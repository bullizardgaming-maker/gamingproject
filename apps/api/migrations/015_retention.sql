-- Data retention. Evidentiary tables stay append-only, with one exception: the retention job
-- may delete a whole chat room's messages once its retention period is over. It marks that by
-- setting bullizard.retention for its own transaction; updates and truncates are still refused.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'chat_messages' AND current_setting('bullizard.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

-- A purged room keeps its final chain hash, so a copy exported earlier (e.g. in a chargeback
-- packet) can still be matched against what the platform held.
ALTER TABLE chat_rooms
  ADD COLUMN purged_at timestamptz,
  ADD COLUMN purged_messages integer;

-- Delivered codes/credentials are erased after the retention period; the fingerprint stays
-- (it is a keyed hash, used only to stop the same code being sold twice).
ALTER TABLE inventory_items ALTER COLUMN ciphertext DROP NOT NULL;
ALTER TABLE inventory_items ADD COLUMN purged_at timestamptz;

CREATE TABLE retention_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  counts      jsonb NOT NULL DEFAULT '{}',
  error       text
);
