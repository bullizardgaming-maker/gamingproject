-- Search counters. Listing pages showed stock, seller rating and completed orders computed per
-- row (an inventory count, a bundle's set count and three aggregates over orders and reviews).
-- They're now stored and kept current by triggers, so search reads columns and can filter and
-- sort on them with indexes. offer_available() stays the live definition: order placement
-- still checks it under locks, and a worker job repairs any counter that drifts.

-- Stock with the row's new values (a BEFORE trigger can't read them back from the table).
CREATE FUNCTION offer_available_of(oid uuid, bundle boolean, mode text, manual_stock integer) RETURNS integer
LANGUAGE sql VOLATILE AS $$
  SELECT CASE
           WHEN bundle THEN
             CASE WHEN EXISTS (SELECT 1 FROM bundle_items b JOIN offers c ON c.id = b.component_offer_id
                                WHERE b.bundle_offer_id = oid AND c.status <> 'active') THEN 0
                  ELSE COALESCE((SELECT min((SELECT count(*) FROM inventory_items i WHERE i.offer_id = b.component_offer_id AND i.status = 'available') / b.quantity)
                                   FROM bundle_items b WHERE b.bundle_offer_id = oid), 0)::int END
           WHEN mode = 'auto' THEN (SELECT count(*)::int FROM inventory_items i WHERE i.offer_id = oid AND i.status = 'available')
           ELSE manual_stock
         END
$$;
-- VOLATILE so a call inside a trigger sees rows other transactions committed since the statement began.
CREATE OR REPLACE FUNCTION offer_available(oid uuid) RETURNS integer LANGUAGE sql VOLATILE AS $$
  SELECT offer_available_of(f.id, f.is_bundle, f.delivery_mode, f.stock) FROM offers f WHERE f.id = oid
$$;

ALTER TABLE offers ADD COLUMN available integer NOT NULL DEFAULT 0;
ALTER TABLE users
  ADD COLUMN completed_orders integer NOT NULL DEFAULT 0,
  ADD COLUMN rating_avg numeric(3, 2),
  ADD COLUMN review_count integer NOT NULL DEFAULT 0;

-- Listings: recompute on the columns that decide stock.
CREATE FUNCTION offers_available_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.available := offer_available_of(NEW.id, NEW.is_bundle, NEW.delivery_mode, NEW.stock);
  RETURN NEW;
END $$;
CREATE TRIGGER offers_available BEFORE INSERT OR UPDATE OF stock, delivery_mode, is_bundle ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_available_row();

-- A part's stock or status moved: the bundles it's in follow.
CREATE FUNCTION offers_refresh_bundles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE offers f SET available = offer_available(f.id)
   WHERE f.id IN (SELECT bundle_offer_id FROM bundle_items WHERE component_offer_id = NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER offers_bundle_parts AFTER UPDATE OF available, status ON offers
  FOR EACH ROW WHEN (NOT NEW.is_bundle AND (OLD.available IS DISTINCT FROM NEW.available OR OLD.status IS DISTINCT FROM NEW.status))
  EXECUTE FUNCTION offers_refresh_bundles();

-- A bundle's parts changed.
CREATE FUNCTION bundle_items_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE offers f SET available = offer_available(f.id)
   WHERE f.id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.bundle_offer_id ELSE NEW.bundle_offer_id END);
  RETURN NULL;
END $$;
CREATE TRIGGER bundle_items_available AFTER INSERT OR UPDATE OR DELETE ON bundle_items
  FOR EACH ROW EXECUTE FUNCTION bundle_items_refresh();

-- Instant inventory: one statement per upload or reservation, applied as a per-listing delta
-- (concurrent uploads add up instead of overwriting each other).
CREATE FUNCTION inventory_available_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE offers f SET available = f.available + d.n
      FROM (SELECT offer_id, count(*)::int AS n FROM new_rows WHERE status = 'available' GROUP BY offer_id) d
     WHERE f.id = d.offer_id AND f.delivery_mode = 'auto' AND NOT f.is_bundle;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE offers f SET available = f.available - d.n
      FROM (SELECT offer_id, count(*)::int AS n FROM old_rows WHERE status = 'available' GROUP BY offer_id) d
     WHERE f.id = d.offer_id AND f.delivery_mode = 'auto' AND NOT f.is_bundle;
  ELSE
    UPDATE offers f SET available = f.available + d.n
      FROM (SELECT offer_id, sum(n)::int AS n FROM (
              SELECT offer_id, 1 AS n FROM new_rows WHERE status = 'available'
              UNION ALL SELECT offer_id, -1 FROM old_rows WHERE status = 'available') x
             GROUP BY offer_id HAVING sum(n) <> 0) d
     WHERE f.id = d.offer_id AND f.delivery_mode = 'auto' AND NOT f.is_bundle;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER inventory_available_ins AFTER INSERT ON inventory_items
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION inventory_available_delta();
CREATE TRIGGER inventory_available_upd AFTER UPDATE ON inventory_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION inventory_available_delta();
CREATE TRIGGER inventory_available_del AFTER DELETE ON inventory_items
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION inventory_available_delta();

-- Sellers: completed orders.
CREATE FUNCTION orders_completed_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Nested IFs: plpgsql doesn't short-circuit, and OLD/NEW are null on INSERT/DELETE.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status = 'completed' THEN UPDATE users SET completed_orders = completed_orders - 1 WHERE id = OLD.seller_id; END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'completed' THEN UPDATE users SET completed_orders = completed_orders + 1 WHERE id = NEW.seller_id; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_completed_ins AFTER INSERT OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_completed_count();
CREATE TRIGGER orders_completed_upd AFTER UPDATE OF status, seller_id ON orders
  FOR EACH ROW WHEN ((OLD.status = 'completed') IS DISTINCT FROM (NEW.status = 'completed') OR OLD.seller_id IS DISTINCT FROM NEW.seller_id)
  EXECUTE FUNCTION orders_completed_count();

-- Sellers: rating over visible reviews (recomputed; one seller's reviews are indexed).
CREATE FUNCTION seller_rating_refresh(sid uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE users u SET rating_avg = r.avg, review_count = r.n
    FROM (SELECT round(avg(rating)::numeric, 2) AS avg, count(*)::int AS n FROM reviews WHERE seller_id = sid AND NOT hidden) r
   WHERE u.id = sid
$$;
CREATE FUNCTION reviews_rating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM seller_rating_refresh(NEW.seller_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM seller_rating_refresh(OLD.seller_id);
  ELSE
    PERFORM seller_rating_refresh(OLD.seller_id);
    IF NEW.seller_id <> OLD.seller_id THEN PERFORM seller_rating_refresh(NEW.seller_id); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reviews_rating_ins AFTER INSERT OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_rating();
CREATE TRIGGER reviews_rating_upd AFTER UPDATE OF rating, hidden, seller_id ON reviews
  FOR EACH ROW WHEN (OLD.rating IS DISTINCT FROM NEW.rating OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.seller_id IS DISTINCT FROM NEW.seller_id)
  EXECUTE FUNCTION reviews_rating();

-- Backfill: plain listings first, then bundles (which read their parts).
UPDATE offers SET available = offer_available(id) WHERE NOT is_bundle;
UPDATE offers SET available = offer_available(id) WHERE is_bundle;
UPDATE users u SET completed_orders = c.n FROM (SELECT seller_id, count(*)::int AS n FROM orders WHERE status = 'completed' GROUP BY seller_id) c WHERE u.id = c.seller_id;
UPDATE users u SET rating_avg = r.avg, review_count = r.n
  FROM (SELECT seller_id, round(avg(rating)::numeric, 2) AS avg, count(*)::int AS n FROM reviews WHERE NOT hidden GROUP BY seller_id) r
 WHERE u.id = r.seller_id;

CREATE INDEX offers_live_price ON offers (price_settlement_cents) WHERE status = 'active' AND reserved_for IS NULL AND available > 0;
