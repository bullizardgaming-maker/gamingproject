-- Commission is a gross-up on top of the seller's price: buyer price = seller price / (1 - rate).
-- The rate comes from the seller's rank (five, set by staff) or the launch promo (5% for a
-- seller's first 60 days). Every seller carries their current rate so listings can show buyer
-- prices in SQL; the worker refreshes it as ranks and the promo window change.
CREATE TABLE seller_ranks (
  position               integer PRIMARY KEY,         -- 1 = lowest
  name                   text NOT NULL UNIQUE,
  min_monthly_sales_cents bigint NOT NULL CHECK (min_monthly_sales_cents >= 0),
  rate_bps               integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 5000),
  perks                  text[] NOT NULL DEFAULT '{}',
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- Placeholder values until the CEO sets them (PUT /v1/admin/ranks).
INSERT INTO seller_ranks (position, name, min_monthly_sales_cents, rate_bps, perks) VALUES
  (1, 'Hatchling', 0,          1399, '{}'),
  (2, 'Scale',     50000,      1299, '{}'),
  (3, 'Fang',      200000,     1199, '{}'),
  (4, 'Basilisk',  500000,     1099, '{}'),
  (5, 'Dragon',    1500000,     999, '{Featured spot on the home page}');

-- The launch promo rate and how long a new seller gets it, editable by staff.
CREATE TABLE commission_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  promo_rate_bps       integer NOT NULL DEFAULT 500,
  promo_days           integer NOT NULL DEFAULT 60,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO commission_settings DEFAULT VALUES;

ALTER TABLE users
  ADD COLUMN seller_since        timestamptz,                         -- first listing; starts the promo clock
  ADD COLUMN commission_rate_bps integer NOT NULL DEFAULT 1399,       -- current rate, refreshed by the worker
  ADD COLUMN seller_rank         text NOT NULL DEFAULT 'Hatchling',
  ADD COLUMN commission_computed_at timestamptz;
UPDATE users SET seller_since = (SELECT min(created_at) FROM offers f WHERE f.seller_id = users.id);
