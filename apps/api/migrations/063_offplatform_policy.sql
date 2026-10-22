-- Off-platform contact (brief design update): the message is not delivered; the action per offence
-- is set by staff (warn / suspend / ban); the attempt is kept, hidden, for the moderation queue.
ALTER TABLE chat_messages ADD COLUMN hidden boolean NOT NULL DEFAULT false;
CREATE TABLE moderation_settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  offplatform_actions text[] NOT NULL DEFAULT '{warn,warn,ban}',   -- action for the 1st, 2nd, ... offence; the last repeats
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO moderation_settings DEFAULT VALUES;
