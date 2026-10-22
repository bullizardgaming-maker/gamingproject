-- Watchlists and price alerts. A watch follows one listing, or a slice of a game's market
-- (game + optional category + optional game-specific fields). The worker compares the current
-- price with the buyer's target (or, with no target, the price when they started watching) and
-- notifies once per new low; a listing coming back into stock is also announced.
CREATE TABLE watches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN ('offer', 'game')),
  offer_id                uuid REFERENCES offers(id) ON DELETE CASCADE,
  game                    text,
  category_slug           text REFERENCES categories(slug),
  attributes              jsonb NOT NULL DEFAULT '{}',
  -- Optional target, in the currency the buyer chose; converted at check time.
  target_cents            bigint CHECK (target_cents > 0),
  currency                char(3) NOT NULL DEFAULT 'USD',
  -- Settlement-currency price when the watch started (the baseline when there is no target).
  baseline_price_cents    bigint,
  last_notified_cents     bigint,
  last_in_stock           boolean,
  last_checked_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'offer' AND offer_id IS NOT NULL AND game IS NULL) OR (kind = 'game' AND game IS NOT NULL AND offer_id IS NULL))
);
CREATE UNIQUE INDEX watches_offer_once ON watches (user_id, offer_id) WHERE kind = 'offer';
CREATE UNIQUE INDEX watches_game_once ON watches (user_id, lower(game), COALESCE(category_slug, ''), attributes) WHERE kind = 'game';
CREATE INDEX watches_due ON watches (last_checked_at NULLS FIRST);
