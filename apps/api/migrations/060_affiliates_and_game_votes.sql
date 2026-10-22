-- Streamer / creator affiliate codes (brief NEW 8): a share of the commission on every order by a
-- buyer they brought, on top of the per-signup referral reward.
CREATE TABLE affiliates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE REFERENCES users(id),
  code        text NOT NULL UNIQUE,            -- stored upper-case, 3-20 chars
  rate_bps    integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 5000),  -- share of the commission
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- A buyer belongs to one affiliate, from the first code they enter (signup or later, once).
CREATE TABLE affiliate_attributions (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE affiliate_earnings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id     uuid NOT NULL REFERENCES affiliates(id),
  order_id         uuid NOT NULL UNIQUE REFERENCES orders(id),
  commission_cents bigint NOT NULL,
  earned_cents     bigint NOT NULL,
  currency         text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliate_earnings_affiliate_idx ON affiliate_earnings (affiliate_id, created_at DESC);

-- Game suggestions and votes (brief NEW 7).
CREATE TABLE game_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  name_key      text NOT NULL UNIQUE,          -- lower-cased, spaces collapsed
  suggested_by  uuid REFERENCES users(id),
  votes         integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'added', 'declined')),
  staff_note    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE game_votes (
  suggestion_id uuid NOT NULL REFERENCES game_suggestions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, user_id)
);
