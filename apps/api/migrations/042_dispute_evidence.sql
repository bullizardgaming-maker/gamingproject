-- Dispute evidence: what kind of problem it is, and each side's written statements (kept apart
-- from the chat so an arbiter reads both cases side by side).
ALTER TABLE disputes ADD COLUMN category text NOT NULL DEFAULT 'other'
  CHECK (category IN ('not_delivered', 'not_as_described', 'not_working', 'account_recovered', 'other'));
CREATE TABLE dispute_statements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('buyer', 'seller')),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_statements_dispute ON dispute_statements (dispute_id, created_at);
