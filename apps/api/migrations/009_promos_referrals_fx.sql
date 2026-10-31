-- Promo codes, referral rewards (store credit) and multi-currency with locked FX rates.
--
-- Order money model (all internal amounts are in the settlement currency, orders.currency):
--   amount_cents            full order value; escrow holds exactly this; seller split is based on it
--   discount_cents          promo discount, funded by the platform (treasury)
--   credit_cents            buyer store credit applied
--   charged_cents           amount - discount - credit: the part paid by card
--   presentment_*           what the card is actually charged, possibly in another currency,
--                           at fx_rate (units per 1 settlement unit, spread included) locked at order time

ALTER TABLE orders
  ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ADD COLUMN credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  ADD COLUMN charged_cents bigint,
  ADD COLUMN presentment_currency char(3),
  ADD COLUMN presentment_amount_cents bigint,
  ADD COLUMN fx_rate numeric(18, 8),
  ADD COLUMN fx_locked_at timestamptz,
  ADD COLUMN listing_currency char(3),
  ADD COLUMN listing_unit_price_cents bigint,
  ADD COLUMN promo_code_id uuid;
UPDATE orders SET charged_cents = amount_cents, presentment_currency = currency, presentment_amount_cents = amount_cents,
                  fx_rate = 1, listing_currency = currency, listing_unit_price_cents = unit_price_cents
 WHERE charged_cents IS NULL;
ALTER TABLE orders ALTER COLUMN charged_cents SET NOT NULL,
                   ALTER COLUMN presentment_currency SET NOT NULL,
                   ALTER COLUMN presentment_amount_cents SET NOT NULL,
                   ALTER COLUMN fx_rate SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_money_parts CHECK (charged_cents = amount_cents - discount_cents - credit_cents AND charged_cents >= 0);

-- ---------------------------------------------------------------------------
-- Promo codes (platform-funded discounts)
-- ---------------------------------------------------------------------------
CREATE TABLE promo_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                citext NOT NULL UNIQUE,
  description         text NOT NULL DEFAULT '',
  percent_off         integer CHECK (percent_off BETWEEN 1 AND 100),
  amount_off_cents    bigint CHECK (amount_off_cents > 0),
  max_discount_cents  bigint CHECK (max_discount_cents > 0),
  min_order_cents     bigint NOT NULL DEFAULT 0,
  categories          text[],                     -- NULL = all categories
  first_order_only    boolean NOT NULL DEFAULT false,
  max_redemptions     integer CHECK (max_redemptions > 0),
  per_user_limit      integer NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz,
  active              boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((percent_off IS NULL) <> (amount_off_cents IS NULL))
);

CREATE TABLE promo_redemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id       uuid NOT NULL REFERENCES promo_codes(id),
  order_id       uuid NOT NULL UNIQUE REFERENCES orders(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  discount_cents bigint NOT NULL,
  status         text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'redeemed', 'released')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON promo_redemptions (promo_id, status);
CREATE INDEX ON promo_redemptions (user_id, promo_id);

-- ---------------------------------------------------------------------------
-- Referrals: reward paid as store credit once the referred user's first order completes.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN referral_code text UNIQUE,
  ADD COLUMN referred_by uuid REFERENCES users(id);

CREATE TABLE referral_rewards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   uuid NOT NULL REFERENCES users(id),
  referee_id    uuid NOT NULL UNIQUE REFERENCES users(id),
  order_id      uuid NOT NULL REFERENCES orders(id),
  amount_cents  bigint NOT NULL,
  status        text NOT NULL CHECK (status IN ('granted', 'blocked')),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- FX: latest rate per currency, as units of that currency per 1 unit of the settlement currency.
-- ---------------------------------------------------------------------------
CREATE TABLE fx_rates (
  currency    char(3) PRIMARY KEY,
  rate        numeric(18, 8) NOT NULL CHECK (rate > 0),
  source      text NOT NULL,
  fetched_at  timestamptz NOT NULL
);

-- Listing price in the settlement currency, kept current when prices or rates change,
-- so search filters and sorts compare like with like across currencies.
ALTER TABLE offers ADD COLUMN price_settlement_cents bigint;
UPDATE offers SET price_settlement_cents = price_cents WHERE price_settlement_cents IS NULL;
CREATE INDEX offers_price_settlement_idx ON offers (status, price_settlement_cents);

-- Keep price_settlement_cents in step with price/currency changes. The settlement currency has
-- no fx_rates row, so its prices pass through unchanged.
CREATE FUNCTION offers_settlement_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r numeric;
BEGIN
  SELECT rate INTO r FROM fx_rates WHERE currency = NEW.currency;
  NEW.price_settlement_cents := CASE WHEN r IS NULL THEN NEW.price_cents ELSE round(NEW.price_cents / r) END;
  RETURN NEW;
END $$;
CREATE TRIGGER offers_settlement_price BEFORE INSERT OR UPDATE OF price_cents, currency ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_settlement_price();
