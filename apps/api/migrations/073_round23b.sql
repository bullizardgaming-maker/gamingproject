-- Round 23b (review fixes). Idempotent.

-- Newsletter: what Brevo holds for each user (the address and the list it is in; NULL list = in none), so a ban,
-- suspension, address or language change is synced too, and when we last pulled Brevo's unsubscribes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_synced_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_synced_list integer;
UPDATE users SET news_synced_email = email, news_synced_list = -1 WHERE news_synced_at IS NOT NULL AND news_opt_in AND news_synced_email IS NULL; -- re-sync once
CREATE TABLE IF NOT EXISTS newsletter_state (
  key   text PRIMARY KEY,
  value timestamptz NOT NULL
);

-- Staff roles: `marketing` (newsletter export). The staff_roles check also never listed `lead` (Round 20).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'arbiter', 'support', 'lead', 'finance', 'compliance', 'marketing', 'admin'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_staff_roles_check;
ALTER TABLE users ADD CONSTRAINT users_staff_roles_check CHECK (staff_roles <@ ARRAY['arbiter', 'support', 'lead', 'finance', 'compliance', 'marketing', 'admin']::text[]);
