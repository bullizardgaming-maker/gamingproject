-- Round 29d (6 Nov 2026): review fixes.
-- M4: FX per the CFO — EGP from the CBE official rate (a fallback source is flagged), Finance overrides in Ops with a
-- second approver when the change is more than 2 %.
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS fallback boolean NOT NULL DEFAULT false;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS override_until timestamptz;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS override_note text;

CREATE TABLE IF NOT EXISTS fx_rate_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency       char(3) NOT NULL,
  rate           numeric(18, 8) NOT NULL CHECK (rate > 0),
  previous_rate  numeric(18, 8),
  change_bps     int NOT NULL DEFAULT 0,
  note           text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  requested_by   uuid NOT NULL REFERENCES users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS fx_rate_overrides_pending_idx ON fx_rate_overrides (currency) WHERE status = 'pending';

-- M5: creator first-order bounty ($2.50 per first order of $10+ with no dispute in 7 days, within the creator's first
-- 90 days; capped per creator and per month).
CREATE TABLE IF NOT EXISTS creator_bounties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id),
  creator_id    uuid NOT NULL REFERENCES users(id),
  buyer_id      uuid NOT NULL REFERENCES users(id),
  order_id      uuid NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents  bigint NOT NULL,
  currency      char(3) NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  eligible_at   timestamptz NOT NULL,
  paid_at       timestamptz,
  void_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creator_bounties_pending_idx ON creator_bounties (eligible_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS creator_bounties_creator_month_idx ON creator_bounties (creator_id, paid_at);
