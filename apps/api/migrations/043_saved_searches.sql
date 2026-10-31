-- Saved searches: a buyer's market filters, checked by the worker for listings posted since the
-- last check and sent as a digest (in-app, email and push per the "alerts" preferences).
CREATE TABLE saved_searches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  params          jsonb NOT NULL,
  frequency       text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('hourly', 'daily')),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_searches_user ON saved_searches (user_id, created_at DESC);
CREATE INDEX saved_searches_due ON saved_searches (frequency, last_checked_at);
