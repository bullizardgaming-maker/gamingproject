-- Round 23a (domain, email, Cloudflare). Idempotent.

-- 1. Alerts to team mailboxes (ALERTS_EMAIL, FINANCE_EMAIL) go through the same outbox as user emails:
--    a row has either a user or a to_email address.
ALTER TABLE notifications ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS to_email text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_recipient') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_recipient CHECK (user_id IS NOT NULL OR to_email IS NOT NULL);
  END IF;
END $$;

-- 5. Newsletter consent (unticked by default): the choice, when it was made, and when it last reached Brevo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_opt_in_at timestamptz;   -- time of the current choice (in or out)
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_synced_at timestamptz;   -- last successful Brevo sync of that choice
CREATE INDEX IF NOT EXISTS users_news_pending ON users (news_opt_in_at) WHERE news_opt_in_at IS NOT NULL;

-- 3. Proof videos above the API's 95 MB cap go straight to object storage: reserved as 'uploading' until scanned.
ALTER TABLE chat_attachments DROP CONSTRAINT IF EXISTS chat_attachments_status_check;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachments_status_check CHECK (status IN ('clean', 'infected', 'uploading'));
