-- Round 23d: legal documents that are in force are immutable at the database level (item 4);
-- terms acceptances are kept as history (item 11); upload slots are reserved before spooling (item 8).

CREATE OR REPLACE FUNCTION legal_documents_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.effective_at <= now() THEN
    RAISE EXCEPTION 'legal document % % % is in force and cannot be changed or deleted', OLD.doc, OLD.locale, OLD.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legal_documents_immutable ON legal_documents;
CREATE TRIGGER legal_documents_immutable BEFORE UPDATE OR DELETE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION legal_documents_immutable();

-- Item 5: KYC applicants of deleted accounts are deleted at the provider by compliance (a person does the irreversible call).
CREATE TABLE IF NOT EXISTS kyc_deletion_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  provider    text NOT NULL,
  external_id text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  done_by     uuid REFERENCES users(id),
  UNIQUE (provider, external_id)
);

-- Item 8: upload slots are reserved before any byte is spooled (hourly limit and concurrency hold under parallel requests).
CREATE TABLE IF NOT EXISTS upload_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS upload_slots_user_started ON upload_slots (user_id, started_at DESC);

-- Item 9: everyone whose choice ever reached Brevo gets a synced marker, opted-out rows included, so a pending
-- opt-out is pushed (the Round 23b backfill only marked opted-in rows).
UPDATE users SET news_synced_email = COALESCE(news_synced_email, email), news_synced_list = COALESCE(news_synced_list, -1)
 WHERE news_synced_at IS NOT NULL AND news_synced_list IS NULL;

-- Item 10: failing rows back off instead of blocking the queue; the opt-out time is separate from the consent time;
-- Brevo deletions that failed at account deletion are retried with the stored address.
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_sync_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_sync_next_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_opt_out_at timestamptz;
CREATE TABLE IF NOT EXISTS newsletter_forget_queue (
  email      text PRIMARY KEY,
  attempts   integer NOT NULL DEFAULT 0,
  next_at    timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Item 11: every Terms acceptance is kept (sign-up, settings, each order), never overwritten.
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  doc         text NOT NULL DEFAULT 'terms',
  version     text NOT NULL,
  via         text NOT NULL CHECK (via IN ('signup', 'settings', 'order')),
  ip          inet,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terms_acceptances_user ON terms_acceptances (user_id, accepted_at DESC);
INSERT INTO terms_acceptances (user_id, version, via, accepted_at)
  SELECT id, tos_version, 'signup', tos_accepted_at FROM users WHERE tos_version IS NOT NULL AND deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM terms_acceptances t WHERE t.user_id = users.id);

-- Item 12: MFA challenge tokens are single-use (row deleted on exchange) and die with a password reset.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_challenges_user ON mfa_challenges (user_id);
