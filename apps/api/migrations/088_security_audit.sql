-- Security audit (Nov 2026): when the last failed rules-test attempts happened (a cooldown after three in an hour).
ALTER TABLE users ADD COLUMN IF NOT EXISTS rules_failed_at timestamptz[] NOT NULL DEFAULT '{}';
