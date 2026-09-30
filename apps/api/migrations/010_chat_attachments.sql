-- Image evidence in chat (screenshots for disputes). Files are malware-scanned, re-encoded
-- (strips EXIF/GPS and any appended payloads) and stored encrypted; the chat message carries the
-- image's SHA-256 so the hash chain also proves the evidence wasn't swapped later.

ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_kind_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_kind_check CHECK (kind IN ('text', 'system', 'delivery', 'warning', 'attachment'));

CREATE TABLE chat_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid NOT NULL REFERENCES chat_rooms(id),
  uploader_id    uuid NOT NULL REFERENCES users(id),
  message_id     uuid REFERENCES chat_messages(id),
  original_name  text NOT NULL,
  mime           text NOT NULL,
  bytes          integer NOT NULL,
  width          integer,
  height         integer,
  sha256         text,                 -- of the stored (re-encoded) image
  storage_key    text,
  status         text NOT NULL CHECK (status IN ('clean', 'infected')),
  scan_result    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON chat_attachments (room_id, created_at);
CREATE INDEX ON chat_attachments (uploader_id, created_at);
