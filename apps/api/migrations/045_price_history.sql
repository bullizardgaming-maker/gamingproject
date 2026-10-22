-- Price history. Every change to a listing's price (including a sale starting or ending) is
-- recorded, and a worker job keeps one row per game, category and day with the lowest and
-- median live price, so buyers can see whether today's price is a good one.

CREATE TABLE offer_prices (
  offer_id    uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  price_cents bigint NOT NULL,
  currency    text NOT NULL,
  PRIMARY KEY (offer_id, at)
);

-- The price a buyer pays for one unit right now: the sale price while a sale runs.
CREATE FUNCTION offers_record_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p bigint; last bigint;
BEGIN
  p := CASE WHEN NEW.sale_active AND NEW.sale_price_cents IS NOT NULL THEN NEW.sale_price_cents ELSE NEW.price_cents END;
  SELECT price_cents INTO last FROM offer_prices WHERE offer_id = NEW.id ORDER BY at DESC LIMIT 1;
  IF last IS DISTINCT FROM p THEN
    INSERT INTO offer_prices (offer_id, at, price_cents, currency) VALUES (NEW.id, clock_timestamp(), p, NEW.currency)
      ON CONFLICT (offer_id, at) DO UPDATE SET price_cents = EXCLUDED.price_cents;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER offers_price_history AFTER INSERT OR UPDATE OF price_cents, currency, sale_price_cents, sale_active ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_record_price();

INSERT INTO offer_prices (offer_id, at, price_cents, currency)
SELECT id, created_at, CASE WHEN sale_active AND sale_price_cents IS NOT NULL THEN sale_price_cents ELSE price_cents END, currency FROM offers;

-- Daily market prices in the settlement currency, over live, in-stock, public listings.
CREATE TABLE market_prices_daily (
  game          text NOT NULL,
  category_slug text NOT NULL REFERENCES categories(slug),
  day           date NOT NULL,
  min_cents     bigint NOT NULL,
  median_cents  bigint NOT NULL,
  listings      integer NOT NULL,
  PRIMARY KEY (game, category_slug, day)
);
