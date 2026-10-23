-- Referral like G2G (CEO, Oct 23): the referrer earns a share of Bullizard's commission on every
-- completed order of the user they invited, for as long as that user stays active. Replaces the
-- one-time credit. The share is staff-set; earnings go to the referrer's withdrawable balance.
CREATE TABLE referral_settings (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  rate_bps    integer NOT NULL DEFAULT 2000 CHECK (rate_bps BETWEEN 0 AND 10000),
  -- A referred user stays "active" while their completed orders are no further apart than this.
  active_days integer NOT NULL DEFAULT 365 CHECK (active_days BETWEEN 1 AND 3650),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO referral_settings DEFAULT VALUES;

ALTER TABLE referral_rewards DROP CONSTRAINT referral_rewards_referee_id_key;
ALTER TABLE referral_rewards
  ADD COLUMN commission_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN rate_bps         integer NOT NULL DEFAULT 0,
  ADD COLUMN currency         char(3) NOT NULL DEFAULT 'USD';
CREATE UNIQUE INDEX referral_rewards_order_idx ON referral_rewards (order_id);
CREATE INDEX referral_rewards_referee_idx ON referral_rewards (referee_id, created_at DESC);
