-- Public seller trust levels, recomputed by the worker from completed sales, account age,
-- on-time delivery, disputes and chargebacks (domain/trust.ts). Cached here because listings
-- show the badge on every row.
ALTER TABLE users ADD COLUMN trust_level text NOT NULL DEFAULT 'new' CHECK (trust_level IN ('new', 'rising', 'trusted', 'top'));
ALTER TABLE users ADD COLUMN trust_computed_at timestamptz;
