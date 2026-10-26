-- Round 23e.
-- Item 1: erasing a user's chat files removes the rows that point at them in the same transaction, and the stored
-- objects after commit through a retry queue (a failed delete is retried, never forgotten). The foreign keys that
-- point at chat_attachments no longer block the delete.
CREATE TABLE IF NOT EXISTS storage_deletions (
  storage_key  text PRIMARY KEY,
  reason       text NOT NULL DEFAULT 'erasure',
  attempts     int NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_deletions_next_at ON storage_deletions (next_at);

ALTER TABLE order_progress DROP CONSTRAINT IF EXISTS order_progress_attachment_id_fkey;
ALTER TABLE order_progress ADD CONSTRAINT order_progress_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES chat_attachments(id) ON DELETE SET NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_proof_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_proof_id_fkey FOREIGN KEY (delivery_proof_id) REFERENCES chat_attachments(id) ON DELETE SET NULL;

-- Item 6: per-chunk SHA-256 of the stored file, written once at upload, so a download is verified chunk by chunk
-- while it streams from storage (no whole-file spool per view).
ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS chunk_bytes int;
ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS chunk_sha256 text[];
