-- Finer staff roles. A user has one primary role plus any extra staff roles; permissions are
-- the union. Checked on every request from the database, so changes apply immediately.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'arbiter', 'support', 'finance', 'compliance', 'admin'));
ALTER TABLE users ADD COLUMN staff_roles text[] NOT NULL DEFAULT '{}'
  CHECK (staff_roles <@ ARRAY['arbiter', 'support', 'finance', 'compliance', 'admin']::text[]);
