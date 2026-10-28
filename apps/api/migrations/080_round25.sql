-- Round 25: precise currency unit prices, currency listing fields, market search, crypto in EUR, review fixes.

-- B2 Currency listings carry their unit price in USD micro-units (6 decimals: 123 = 0.000123 per unit) in the listing's
-- currency. price_cents stays NOT NULL (the price of one unit rounded up to the cent) for the older readers.
ALTER TABLE offers ADD COLUMN unit_price_micros bigint CHECK (unit_price_micros IS NULL OR unit_price_micros > 0);
UPDATE offers f SET unit_price_micros = f.price_cents * 10000
  FROM categories c WHERE c.slug = f.category_slug AND c.kind = 'currency' AND f.unit_price_micros IS NULL;

-- B3 Volume discounts on currency listings: up to four [{minQty, percentOff}] (1–50 %).
ALTER TABLE offers ADD COLUMN volume_discounts jsonb NOT NULL DEFAULT '[]';

-- B3 Delivery time from a fixed list (15m … 24h) in minutes; delivery_hours stays (rounded up) for older readers.
ALTER TABLE offers ADD COLUMN delivery_minutes integer;
UPDATE offers SET delivery_minutes = delivery_hours * 60 WHERE delivery_minutes IS NULL;
ALTER TABLE offers ALTER COLUMN delivery_minutes SET DEFAULT 1440;
ALTER TABLE offers ALTER COLUMN delivery_minutes SET NOT NULL;
ALTER TABLE offers ADD CONSTRAINT offers_delivery_minutes_positive CHECK (delivery_minutes > 0);

-- B3 "Established buyers only" is gone from the API: nothing gates on it any more, and no listing keeps the old setting.
UPDATE offers SET min_buyer_reputation = NULL WHERE min_buyer_reputation IS NOT NULL;

-- B4 One sortable price for every listing, in settlement micro-units (the seller's side; readers gross it up).
ALTER TABLE offers ADD COLUMN price_settlement_micros bigint;
CREATE OR REPLACE FUNCTION offers_settlement_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r numeric; p bigint; m numeric;
BEGIN
  SELECT rate INTO r FROM fx_rates WHERE currency = NEW.currency;
  p := CASE WHEN NEW.sale_active AND NEW.sale_price_cents IS NOT NULL THEN NEW.sale_price_cents ELSE NEW.price_cents END;
  m := CASE WHEN NEW.sale_active AND NEW.sale_price_cents IS NOT NULL THEN NEW.sale_price_cents * 10000
            ELSE COALESCE(NEW.unit_price_micros, NEW.price_cents * 10000) END;
  NEW.price_settlement_cents := CASE WHEN r IS NULL THEN p ELSE round(p / r) END;
  NEW.price_settlement_micros := CASE WHEN r IS NULL THEN m ELSE round(m / r) END;
  RETURN NEW;
END $$;
DROP TRIGGER offers_settlement_price ON offers;
CREATE TRIGGER offers_settlement_price BEFORE INSERT OR UPDATE OF price_cents, currency, sale_price_cents, sale_active, unit_price_micros ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_settlement_price();
UPDATE offers f SET price_settlement_micros = CASE WHEN r.rate IS NULL THEN m.v ELSE round(m.v / r.rate) END
  FROM offers g
  LEFT JOIN fx_rates r ON r.currency = g.currency
  CROSS JOIN LATERAL (SELECT CASE WHEN g.sale_active AND g.sale_price_cents IS NOT NULL THEN g.sale_price_cents * 10000
                                  ELSE COALESCE(g.unit_price_micros, g.price_cents * 10000) END::numeric AS v) m
 WHERE g.id = f.id;

-- B4 Every in-game listing stores the methods it offers (no more "null = all of the game's"), so the market can filter
-- on them with an index. Same table as domain/delivery.ts: listed games use their list, other handover games f2f / uid.
UPDATE offers SET delivery_methods = CASE lower(game)
    WHEN 'albion online' THEN ARRAY['f2f', 'market']
    WHEN 'path of exile' THEN ARRAY['f2f']
    WHEN 'path of exile 2' THEN ARRAY['f2f']
    WHEN 'aion' THEN ARRAY['f2f', 'mail']
    WHEN 'aion 2' THEN ARRAY['f2f', 'mail']
    WHEN 'world of warcraft' THEN ARRAY['f2f']
    WHEN 'old school runescape' THEN ARRAY['f2f']
    WHEN 'diablo iv' THEN ARRAY['f2f']
    ELSE ARRAY['uid'] END
 WHERE delivery_methods IS NULL
   AND category_slug IN ('currency', 'items', 'top-ups', 'boosting')
   AND lower(game) IN ('albion online', 'path of exile', 'path of exile 2', 'aion', 'aion 2', 'world of warcraft', 'old school runescape',
                       'diablo iv', 'genshin impact', 'honkai: star rail', 'mobile legends', 'pubg mobile');

-- B4 Indexes for the market search and the server summary.
CREATE INDEX offers_market ON offers (lower(game), category_slug, price_settlement_micros) WHERE status = 'active' AND reserved_for IS NULL;
CREATE INDEX offers_delivery_methods ON offers USING GIN (delivery_methods) WHERE status = 'active';
CREATE INDEX offers_attributes_gin ON offers USING GIN (attributes jsonb_path_ops) WHERE status = 'active';
CREATE INDEX offers_live_sold ON offers (sold_count DESC) WHERE status = 'active' AND reserved_for IS NULL;
CREATE INDEX users_completed_orders ON users (completed_orders);

-- B2 The order keeps both prices: the unit price in micro-units next to the cents, for the buyer's side and the listing's.
-- B8 (M2) amount_usd_cents: the order value in USD, for the $200 Lead-only rule whatever the order's currency.
ALTER TABLE orders ADD COLUMN unit_price_micros bigint, ADD COLUMN listing_unit_price_micros bigint, ADD COLUMN amount_usd_cents bigint;
UPDATE orders SET unit_price_micros = unit_price_cents * 10000, listing_unit_price_micros = listing_unit_price_cents * 10000;
UPDATE orders o SET amount_usd_cents = CASE WHEN o.currency = 'USD' THEN o.amount_cents
                                            ELSE round(o.amount_cents / NULLIF((SELECT rate FROM fx_rates r WHERE r.currency = o.currency), 0)) END;
UPDATE orders SET amount_usd_cents = amount_cents WHERE amount_usd_cents IS NULL; -- no rate stored: the settlement amount
ALTER TABLE orders ALTER COLUMN amount_usd_cents SET NOT NULL;

-- B5 Crypto invoices in EUR: what the payment was priced in at NOWPayments and the locked rate (EUR per USD).
ALTER TABLE crypto_payments
  ADD COLUMN price_currency text NOT NULL DEFAULT 'USD' CHECK (price_currency IN ('USD', 'EUR')),
  ADD COLUMN price_amount numeric(18, 2),
  ADD COLUMN fx_rate numeric(18, 8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0);
UPDATE crypto_payments SET price_amount = price_usd WHERE price_amount IS NULL;

-- B8 (L1) 079 made every account with a verified email level 1, banned and deleted ones too. Level 1 used to need a
-- verified phone, so banned/deleted accounts at level 1 without one were promoted by 079: back to 0.
UPDATE users SET kyc_tier = 0
 WHERE kyc_tier = 1 AND phone_verified_at IS NULL AND (status = 'banned' OR deleted_at IS NOT NULL);
