-- Buyer reputation: after a completed order the seller rates the buyer (positive or negative,
-- with optional tags from a fixed list; no free text, so nothing to moderate). Sellers see a
-- buyer's summary on orders; buyers see their own. Disputes lost and chargebacks are counted
-- from the order records, so they can't be rated away.
CREATE TABLE buyer_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id),
  seller_id   uuid NOT NULL REFERENCES users(id),
  buyer_id    uuid NOT NULL REFERENCES users(id),
  positive    boolean NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON buyer_ratings (buyer_id, created_at);
