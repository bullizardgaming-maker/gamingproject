-- Refresh-token sessions (rotation + reuse detection) and email notifications.

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  family_id     uuid NOT NULL,              -- all rotations of one sign-in share a family
  token_hash    text NOT NULL UNIQUE,       -- HMAC of the refresh token; the token itself is never stored
  mfa           boolean NOT NULL DEFAULT false,
  user_agent    text,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  rotated_at    timestamptz,                -- set when exchanged for a newer token
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON sessions (family_id);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  template        text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text UNIQUE,              -- e.g. protection_ending:<order id>, so reminders go out once
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX ON notifications (status, next_attempt_at);

ALTER TABLE users ADD COLUMN email_preferences jsonb NOT NULL DEFAULT '{}';
