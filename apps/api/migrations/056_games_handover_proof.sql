-- Launch games: leagues, the buyer's in-game name on orders, and delivery proof.

-- Challenge leagues (Path of Exile 1 & 2) are opened and closed by staff. A listing in an ended
-- league whose seller has gone quiet expires (domain/leagues.ts).
CREATE TABLE game_leagues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game        text NOT NULL,                 -- lower-case game name, e.g. 'path of exile'
  name        text NOT NULL,
  starts_at   timestamptz,
  ends_at     timestamptz,                   -- null while the league runs
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game, name)
);

-- The character name (or UID) the buyer confirmed at checkout, for games that deliver in-game.
ALTER TABLE orders ADD COLUMN character_name text;
-- Remembered per game after the first order: {"path of exile": "MyExile"}.
ALTER TABLE users ADD COLUMN handover_names jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Proof of delivery: the chat attachment (photo or video) the seller attached when delivering.
ALTER TABLE orders ADD COLUMN delivery_proof_id uuid REFERENCES chat_attachments(id);

-- Listings expired by a league ending (kept apart from 'paused' so the seller can tell why).
ALTER TABLE offers DROP CONSTRAINT offers_status_check;
ALTER TABLE offers ADD CONSTRAINT offers_status_check CHECK (status IN ('active', 'paused', 'removed', 'review', 'expired'));
ALTER TABLE offers ADD COLUMN expired_reason text;
CREATE INDEX offers_league_idx ON offers ((lower(game)), (attributes->>'league')) WHERE status = 'active';

