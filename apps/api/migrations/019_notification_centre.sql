-- In-app notification centre and Web Push.
-- Every notification now lands in the user's inbox (kept 180 days by the retention job); email and
-- push are delivery channels on top, each with its own per-category preferences.

CREATE TABLE inbox_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  template      text NOT NULL,
  category      text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  link          text,                               -- path in the web app, e.g. /orders/<id>
  read_at       timestamptz,
  dispatched_at timestamptz,                        -- realtime + push handled by the worker
  push_status   text NOT NULL DEFAULT 'pending' CHECK (push_status IN ('pending', 'sent', 'skipped', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_items_user ON inbox_items (user_id, created_at DESC);
CREATE INDEX inbox_items_unread ON inbox_items (user_id) WHERE read_at IS NULL;
CREATE INDEX inbox_items_undispatched ON inbox_items (created_at) WHERE dispatched_at IS NULL;

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  failures        integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON push_subscriptions (user_id);

ALTER TABLE users ADD COLUMN push_preferences jsonb NOT NULL DEFAULT '{}';
