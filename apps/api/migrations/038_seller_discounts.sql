-- Seller-funded discounts. Unlike platform promo codes (009), these lower the order's price
-- itself, so commission is charged on what the buyer actually pays and no treasury top-up happens.

-- Timed sales: a lower price between two times. sale_active mirrors "now is inside the window"
-- (kept current by the worker) so the stored settlement price used for search sorts by the sale price.
ALTER TABLE offers ADD COLUMN sale_price_cents bigint CHECK (sale_price_cents IS NULL OR sale_price_cents > 0);
ALTER TABLE offers ADD COLUMN sale_starts_at timestamptz;
ALTER TABLE offers ADD COLUMN sale_ends_at timestamptz;
ALTER TABLE offers ADD COLUMN sale_active boolean NOT NULL DEFAULT false;
ALTER TABLE offers ADD CONSTRAINT offers_sale_window CHECK (sale_price_cents IS NULL OR (sale_starts_at IS NOT NULL AND sale_ends_at > sale_starts_at));
CREATE INDEX offers_sale_due ON offers (sale_starts_at, sale_ends_at) WHERE sale_price_cents IS NOT NULL;

CREATE OR REPLACE FUNCTION offers_settlement_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r numeric; p bigint;
BEGIN
  SELECT rate INTO r FROM fx_rates WHERE currency = NEW.currency;
  p := CASE WHEN NEW.sale_active AND NEW.sale_price_cents IS NOT NULL THEN NEW.sale_price_cents ELSE NEW.price_cents END;
  NEW.price_settlement_cents := CASE WHEN r IS NULL THEN p ELSE round(p / r) END;
  RETURN NEW;
END $$;
DROP TRIGGER offers_settlement_price ON offers;
CREATE TRIGGER offers_settlement_price BEFORE INSERT OR UPDATE OF price_cents, currency, sale_price_cents, sale_active ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_settlement_price();

-- Discount codes a seller hands out (social posts, returning buyers): a percentage off their own
-- listings, optionally with a minimum order, a window and a use limit.
CREATE TABLE seller_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       uuid NOT NULL REFERENCES users(id),
  code            citext NOT NULL,
  percent_off     integer NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  min_order_cents bigint NOT NULL DEFAULT 0,
  max_uses        integer CHECK (max_uses > 0),
  per_buyer_limit integer NOT NULL DEFAULT 1 CHECK (per_buyer_limit > 0),
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, code)
);
ALTER TABLE orders ADD COLUMN seller_code_id uuid REFERENCES seller_codes(id);
ALTER TABLE orders ADD COLUMN seller_discount_cents bigint NOT NULL DEFAULT 0;
CREATE INDEX orders_seller_code ON orders (seller_code_id) WHERE seller_code_id IS NOT NULL;
