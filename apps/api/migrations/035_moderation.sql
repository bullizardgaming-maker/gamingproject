-- Listing and chat moderation.
-- Listings whose text matches a staff-maintained term are held for review (status 'review') and
-- stay out of search until a moderator approves them; 'block' terms are refused outright.
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE offers ADD CONSTRAINT offers_status_check CHECK (status IN ('active', 'paused', 'removed', 'review'));
ALTER TABLE offers ADD COLUMN review_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE offers ADD COLUMN review_note text;
ALTER TABLE offers ADD COLUMN reviewed_by uuid REFERENCES users(id);
ALTER TABLE offers ADD COLUMN reviewed_at timestamptz;
CREATE INDEX offers_review_queue ON offers (updated_at) WHERE status = 'review';

CREATE TABLE moderation_terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term        text NOT NULL,
  action      text NOT NULL CHECK (action IN ('block', 'review')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX moderation_terms_term ON moderation_terms (lower(term));

-- A chat message that looked like an attempt to move the deal off-platform. The sender was
-- already warned in the chat; staff confirm (a real attempt) or dismiss (false alarm).
CREATE TABLE chat_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  reasons     text[] NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  reviewed_by uuid REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (room_id, seq)
);
CREATE INDEX chat_flags_queue ON chat_flags (status, created_at);
CREATE INDEX chat_flags_user ON chat_flags (user_id, created_at DESC);

-- Starting list (kept equal to DEFAULT_TERMS in src/domain/safety.ts; staff edit it in the admin).
INSERT INTO moderation_terms (term, action) VALUES
  ('stolen card', 'block'), ('carding', 'block'), ('cvv', 'block'), ('fullz', 'block'), ('ddos', 'block'),
  ('doxx', 'block'), ('doxing', 'block'), ('swatting', 'block'), ('credit card generator', 'block'),
  ('aimbot', 'review'), ('wallhack', 'review'), ('cheat', 'review'), ('hack', 'review'), ('exploit', 'review'),
  ('dupe', 'review'), ('duped', 'review'), ('injector', 'review'), ('unban', 'review'), ('recovered account', 'review'),
  ('stolen', 'review'), ('chargeback', 'review'), ('cracked', 'review'), ('modded account', 'review'), ('botted', 'review');
