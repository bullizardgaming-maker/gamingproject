-- Round 25b: fixes from the review of Round 25.

-- L1 Quantities up to 2,000,000,000 (currency sold by the unit): stock + a cancelled order's quantity must never
-- overflow, so stock, the stored stock counter, minimum order and order quantity are bigint.
DROP FUNCTION offer_available(uuid);
DROP FUNCTION offer_available_of(uuid, boolean, text, integer);
-- Triggers naming these columns (UPDATE OF / WHEN) must be dropped for the type change and are recreated as they were.
DROP TRIGGER offers_available ON offers;
DROP TRIGGER offers_bundle_parts ON offers;
ALTER TABLE offers ALTER COLUMN stock TYPE bigint, ALTER COLUMN available TYPE bigint, ALTER COLUMN min_qty TYPE bigint;
CREATE TRIGGER offers_available BEFORE INSERT OR UPDATE OF stock, delivery_mode, is_bundle ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_available_row();
CREATE TRIGGER offers_bundle_parts AFTER UPDATE OF available, status ON offers
  FOR EACH ROW WHEN (NOT NEW.is_bundle AND (OLD.available IS DISTINCT FROM NEW.available OR OLD.status IS DISTINCT FROM NEW.status))
  EXECUTE FUNCTION offers_refresh_bundles();
ALTER TABLE orders ALTER COLUMN quantity TYPE bigint;
CREATE FUNCTION offer_available_of(oid uuid, bundle boolean, mode text, manual_stock bigint) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT CASE
           WHEN bundle THEN
             CASE WHEN EXISTS (SELECT 1 FROM bundle_items b JOIN offers c ON c.id = b.component_offer_id
                                WHERE b.bundle_offer_id = oid AND c.status <> 'active') THEN 0
                  ELSE COALESCE((SELECT min((SELECT count(*) FROM inventory_items i WHERE i.offer_id = b.component_offer_id AND i.status = 'available') / b.quantity)
                                   FROM bundle_items b WHERE b.bundle_offer_id = oid), 0)::bigint END
           WHEN mode = 'auto' THEN (SELECT count(*) FROM inventory_items i WHERE i.offer_id = oid AND i.status = 'available')
           ELSE manual_stock
         END
$$;
CREATE FUNCTION offer_available(oid uuid) RETURNS bigint LANGUAGE sql VOLATILE AS $$
  SELECT offer_available_of(f.id, f.is_bundle, f.delivery_mode, f.stock) FROM offers f WHERE f.id = oid
$$;

-- L2 The market filters servers and leagues with a literal key (lower(attributes->>'server')), so these expression
-- indexes serve them; the jsonb GIN index from 080 was never used.
DROP INDEX offers_attributes_gin;
CREATE INDEX offers_server ON offers (lower(game), category_slug, lower(attributes->>'server')) WHERE status = 'active';
CREATE INDEX offers_league ON offers (lower(game), category_slug, lower(attributes->>'league')) WHERE status = 'active';

-- M1 EUR crypto invoices: the FX part of the deposit-to-wallet gap, and deposits held for manual review when their fiat
-- value can't be read safely (nothing is credited until Finance resolves them).
ALTER TABLE crypto_payments
  ADD COLUMN fx_gap_cents bigint,
  ADD COLUMN fx_gap_bps integer,
  ADD COLUMN review_reason text,
  ADD COLUMN review_flagged_at timestamptz,
  ADD COLUMN review_resolved_at timestamptz;
CREATE INDEX crypto_payments_review ON crypto_payments (review_flagged_at) WHERE review_reason IS NOT NULL AND review_resolved_at IS NULL;
