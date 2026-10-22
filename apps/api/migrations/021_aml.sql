-- Anti-money-laundering: sanctions screening, transaction monitoring and compliance cases.
-- AML records are kept for the legal record-keeping period (typically 5 years after the
-- relationship ends) and are not touched by the retention job.

-- Loaded sanctions lists. Each alias is its own row (same ref). name_key is the normalised
-- name with its words sorted, so "SMITH, John" and "John Smith" compare equal.
CREATE TABLE sanctions_entries (
  id        bigserial PRIMARY KEY,
  list      text NOT NULL,                 -- e.g. ofac_sdn, eu, uk, un
  ref       text NOT NULL,                 -- the list's own id for the party
  kind      text NOT NULL CHECK (kind IN ('person', 'entity', 'wallet', 'other')),
  name      text NOT NULL,                 -- as published (for wallets: the address)
  name_key  text NOT NULL,
  program   text,
  version   text NOT NULL
);
CREATE INDEX sanctions_entries_trgm ON sanctions_entries USING gin (name_key gin_trgm_ops);
CREATE INDEX sanctions_entries_wallet ON sanctions_entries (name_key) WHERE kind = 'wallet';

CREATE TABLE sanctions_lists (
  list       text PRIMARY KEY,
  version    text NOT NULL,                -- sha256 of the source files
  entries    integer NOT NULL,
  loaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aml_screenings (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  subject     text NOT NULL CHECK (subject IN ('legal_name', 'wallet')),
  value       text NOT NULL,
  best_score  numeric(4, 3) NOT NULL,
  matches     jsonb NOT NULL,
  versions    jsonb NOT NULL,              -- list -> version screened against
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON aml_screenings (user_id, created_at DESC);

CREATE TABLE aml_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  source        text NOT NULL CHECK (source IN ('sanctions', 'monitoring', 'manual')),
  rule          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('high', 'medium')),
  holds_payouts boolean NOT NULL,
  details       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'cleared', 'reported')),
  notes         jsonb NOT NULL DEFAULT '[]',
  sar_reference text,
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- One live case per user and rule; new hits are added to it.
CREATE UNIQUE INDEX aml_cases_live ON aml_cases (user_id, rule) WHERE status IN ('open', 'escalated');
CREATE INDEX ON aml_cases (status, created_at);

-- Payouts paused for compliance review (kept apart from fraud freezes; never shown to the user as AML).
ALTER TABLE users ADD COLUMN aml_hold boolean NOT NULL DEFAULT false;
