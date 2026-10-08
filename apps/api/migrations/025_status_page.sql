-- Public status page: incidents and planned maintenance posted by staff, with timestamped
-- updates, plus email subscribers (double opt-in) who hear about each one. Component health is
-- also derived live from the same signals monitoring uses (database, realtime, worker jobs).

CREATE TABLE incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL DEFAULT 'incident' CHECK (kind IN ('incident', 'maintenance')),
  title           text NOT NULL,
  impact          text NOT NULL CHECK (impact IN ('none', 'minor', 'major', 'critical')),
  status          text NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed')),
  components      text[] NOT NULL DEFAULT '{}',
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX ON incidents (created_at DESC);

CREATE TABLE incident_updates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  status      text NOT NULL,
  body        text NOT NULL,
  author_id   uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON incident_updates (incident_id, created_at);

CREATE TABLE status_subscribers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE,
  confirm_hash     text,                    -- HMAC of the confirmation token, cleared once confirmed
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Emails to subscribers (not users, so not the user notification outbox).
CREATE TABLE status_emails (
  id            bigserial PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES status_subscribers(id) ON DELETE CASCADE,
  subject       text NOT NULL,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX ON status_emails (created_at) WHERE status = 'pending';
