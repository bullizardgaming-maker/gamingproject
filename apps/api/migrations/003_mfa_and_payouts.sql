-- Two-factor login (TOTP, RFC 6238) and payout-account onboarding.

ALTER TABLE users
  ADD COLUMN totp_secret_ciphertext text,          -- AES-256-GCM; set during setup, active once totp_enabled_at is set
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0,  -- last accepted time step: blocks code replay
  ADD COLUMN payouts_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recovery_codes (user_id) WHERE used_at IS NULL;
