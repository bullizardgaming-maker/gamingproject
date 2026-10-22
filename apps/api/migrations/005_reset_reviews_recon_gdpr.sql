-- Password reset, seller reviews, money reconciliation, account deletion.

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON password_resets (user_id, created_at DESC);

CREATE TABLE reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL UNIQUE REFERENCES orders(id),
  buyer_id     uuid NOT NULL REFERENCES users(id),
  seller_id    uuid NOT NULL REFERENCES users(id),
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      text NOT NULL DEFAULT '',
  seller_reply text,
  replied_at   timestamptz,
  -- Hidden reviews don't count toward ratings: linked accounts (likely fake) or moderated.
  hidden       boolean NOT NULL DEFAULT false,
  hidden_reason text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reviews (seller_id, created_at DESC) WHERE NOT hidden;

CREATE TABLE reconciliation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running', 'ok', 'mismatch', 'error')),
  report      jsonb NOT NULL DEFAULT '{}'
);

ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- One verified phone number per live account (makes mass account farming more expensive).
CREATE UNIQUE INDEX users_verified_phone ON users (phone) WHERE phone_verified_at IS NOT NULL AND deleted_at IS NULL;
