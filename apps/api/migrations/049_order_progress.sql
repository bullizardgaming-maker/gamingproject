-- Progress updates on boosting orders: the seller posts how far along the service is, with a
-- note and optionally a screenshot already uploaded to the order chat (so it is scanned,
-- re-encoded and hash-chained like any other evidence). Percent never goes backwards.
CREATE TABLE order_progress (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id),
  author_id      uuid NOT NULL REFERENCES users(id),
  percent        smallint NOT NULL CHECK (percent BETWEEN 0 AND 100),
  note           text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  attachment_id  uuid REFERENCES chat_attachments(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_progress (order_id, created_at);
