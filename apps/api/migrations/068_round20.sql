-- Round 20 (Oct 24): fixes from the independent review of Round 19.

-- Chat flags record whether the offence counted as a strike (loosely phrased / split hits are queued only).
ALTER TABLE chat_flags ADD COLUMN IF NOT EXISTS strike boolean NOT NULL DEFAULT true;

-- Crypto deposits: which payment rows funded their order (set when the order is captured), so a deposit that
-- arrives later — after a cancel, or on top of a funded order — is credited to the buyer's balance exactly once.
ALTER TABLE crypto_payments ADD COLUMN IF NOT EXISTS applied_at timestamptz;
UPDATE crypto_payments p SET applied_at = COALESCE(p.updated_at, now())
  WHERE p.applied_at IS NULL AND p.status IN ('finished', 'confirmed', 'sending', 'partially_paid')
    AND EXISTS (SELECT 1 FROM orders o WHERE (o.id = p.order_id OR o.checkout_id = p.checkout_id) AND o.status NOT IN ('awaiting_payment', 'cancelled'));

-- Payouts: a provider call that timed out leaves the withdrawal `unknown` (money still booked as paid out)
-- until the provider confirms whether the payout exists; the withdrawal id is the provider idempotency key.
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check CHECK (status IN ('pending', 'pending_approval', 'processing', 'unknown', 'paid', 'failed', 'rejected'));
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS provider_attempted_at timestamptz;

-- Payout address changes always need a second factor: the authenticator code, or a one-time code sent by SMS/email.
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS code_hash text;
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS code_via text;

-- Support Lead: a staff role that alone may release or decide orders above the Lead threshold ($200).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'arbiter', 'support', 'lead', 'finance', 'compliance', 'admin'));

-- Ban vs suspend: a real `banned` status (never lifted automatically) and an end time for suspensions.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'banned'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at timestamptz;
-- Off-platform bans already recorded as suspensions become bans.
UPDATE users SET status = 'banned', banned_at = COALESCE(banned_at, now()) WHERE status = 'suspended' AND suspension_reason IN ('off_platform_ban', 'fraud_confirmed');

-- Split disputes: what the seller actually received (the wallet "sale" line shows this, not seller_net_cents).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_received_cents bigint;

-- Launch gate §4: kill switches and beta limits, one row, staff-editable (Ops → Controls).
CREATE TABLE IF NOT EXISTS platform_controls (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  pause_withdrawals          boolean NOT NULL DEFAULT false,
  pause_orders               boolean NOT NULL DEFAULT false,
  pause_chat                 boolean NOT NULL DEFAULT false,
  pause_signups              boolean NOT NULL DEFAULT false,
  pause_message              text,
  max_withdrawal_day_cents   bigint NOT NULL DEFAULT 500000,   -- per user per day ($5,000)
  max_order_cents            bigint NOT NULL DEFAULT 50000,    -- beta: no order above $500
  new_account_days           integer NOT NULL DEFAULT 7,
  new_account_max_order_cents bigint NOT NULL DEFAULT 10000,   -- first week: $100 per order
  new_account_max_open_orders integer NOT NULL DEFAULT 3,
  alert_dispute_hour         integer NOT NULL DEFAULT 5,       -- alerts: disputes opened in an hour
  alert_bans_hour            integer NOT NULL DEFAULT 3,
  alert_withdrawal_cents     bigint NOT NULL DEFAULT 200000,   -- a single withdrawal above $2,000 is "unusual"
  updated_by                 uuid REFERENCES users(id),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_controls DEFAULT VALUES ON CONFLICT DO NOTHING;
