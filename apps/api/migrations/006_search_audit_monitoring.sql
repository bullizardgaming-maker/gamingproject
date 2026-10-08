-- Market search, staff audit log, worker heartbeats.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Weighted full-text search: title > game > description.
ALTER TABLE offers ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(game, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(description, '')), 'C')
) STORED;
CREATE INDEX offers_search_idx ON offers USING GIN (search);
-- Typo-tolerant game matching ("elden rin", "valornt") and autocomplete.
CREATE INDEX offers_game_trgm_idx ON offers USING GIN (lower(game) gin_trgm_ops);
CREATE INDEX offers_price_idx ON offers (status, price_cents);

-- Every staff action, append-only.
CREATE TABLE admin_audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid NOT NULL REFERENCES users(id),
  actor_role  text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text,
  details     jsonb NOT NULL DEFAULT '{}',
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_audit_log (actor_id, created_at DESC);
CREATE INDEX ON admin_audit_log (target_type, target_id);
CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Last successful run of each background job (monitoring alerts on staleness).
CREATE TABLE worker_heartbeats (
  job          text PRIMARY KEY,
  last_ok_at   timestamptz NOT NULL,
  last_error   text,
  last_error_at timestamptz
);
