-- Account warranty. Account sales already sit in escrow for 14 days; a seller can offer a
-- warranty that runs on after release (7 to 90 days) against the account being pulled back by
-- its original owner, banned for something before the sale, or locked. While it runs, that
-- order's payout stays on hold, so a claim the seller loses can be refunded from it.

ALTER TABLE offers ADD COLUMN warranty_days integer NOT NULL DEFAULT 0 CHECK (warranty_days IN (0, 7, 14, 30, 60, 90));
ALTER TABLE orders ADD COLUMN warranty_days integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN warranty_ends_at timestamptz;

-- The warranty is a term of the sale: copied from the listing when the order is made (card
-- payments only: crypto escrow settles on-chain and can't be refunded after release).
CREATE FUNCTION orders_warranty_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.warranty_days := CASE WHEN NEW.rail = 'fiat' THEN COALESCE((SELECT warranty_days FROM offers WHERE id = NEW.offer_id), 0) ELSE 0 END;
  END IF;
  -- It starts when the order completes (escrow released).
  IF NEW.completed_at IS NOT NULL AND NEW.warranty_ends_at IS NULL AND NEW.warranty_days > 0 THEN
    NEW.warranty_ends_at := NEW.completed_at + make_interval(days => NEW.warranty_days);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_warranty BEFORE INSERT OR UPDATE OF completed_at ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_warranty_terms();
CREATE INDEX orders_warranty_running ON orders (seller_id, warranty_ends_at) WHERE warranty_ends_at IS NOT NULL;

CREATE TABLE warranty_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  buyer_id           uuid NOT NULL REFERENCES users(id),
  seller_id          uuid NOT NULL REFERENCES users(id),
  reason             text NOT NULL CHECK (reason IN ('recovered', 'banned', 'locked', 'other')),
  details            text NOT NULL,
  -- open: waiting for the seller · seller_fixed: seller says it's fixed, buyer to confirm ·
  -- escalated: an arbiter decides · then resolved / refunded / rejected / withdrawn
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'seller_fixed', 'escalated', 'resolved', 'refunded', 'rejected', 'withdrawn')),
  seller_message     text,
  respond_by         timestamptz NOT NULL,
  confirm_by         timestamptz,
  decided_by         uuid REFERENCES users(id),
  decision_note      text,
  refund_id          uuid REFERENCES post_release_refunds(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX warranty_claims_one_open ON warranty_claims (order_id) WHERE status IN ('open', 'seller_fixed', 'escalated');
CREATE INDEX warranty_claims_due ON warranty_claims (status, respond_by, confirm_by) WHERE status IN ('open', 'seller_fixed');
