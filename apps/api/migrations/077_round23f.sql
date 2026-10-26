-- Round 23f (item 4): open download streams per user, counted across API nodes. A slot not released (a node died)
-- stops counting after the longest a stream may run (15 minutes); the retention job deletes old rows.
CREATE TABLE IF NOT EXISTS download_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS download_slots_user ON download_slots (user_id, started_at DESC);
