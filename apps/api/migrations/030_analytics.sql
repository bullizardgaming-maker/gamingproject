-- Listing views per day, for seller conversion rates. Counted once per viewer, listing and hour
-- (in the API process), never for the seller's own views.
CREATE TABLE offer_views (
  offer_id  uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  day       date NOT NULL,
  views     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (offer_id, day)
);
-- Analytics read paid orders by time.
CREATE INDEX IF NOT EXISTS orders_paid_at ON orders (paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_seller_paid ON orders (seller_id, paid_at) WHERE paid_at IS NOT NULL;
