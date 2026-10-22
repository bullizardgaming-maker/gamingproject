-- Buyer requests: a buyer describes what they want, sellers send proposals, and accepting one
-- creates a listing reserved for that buyer, bought through the normal escrow checkout.
CREATE TABLE buyer_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id        uuid NOT NULL REFERENCES users(id),
  game            text NOT NULL,
  category_slug   text NOT NULL REFERENCES categories(slug),
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  budget_cents    bigint CHECK (budget_cents IS NULL OR budget_cents > 0),
  currency        text NOT NULL,
  attributes      jsonb NOT NULL DEFAULT '{}',
  -- open: taking proposals · accepted: a proposal won · closed: withdrawn by the buyer · expired
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'closed', 'expired')),
  accepted_proposal_id uuid,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX buyer_requests_board ON buyer_requests (status, game, category_slug, created_at DESC);
CREATE INDEX buyer_requests_buyer ON buyer_requests (buyer_id, created_at DESC);

CREATE TABLE request_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES buyer_requests(id) ON DELETE CASCADE,
  seller_id       uuid NOT NULL REFERENCES users(id),
  price_cents     bigint NOT NULL CHECK (price_cents > 0),
  delivery_hours  integer NOT NULL CHECK (delivery_hours BETWEEN 1 AND 168),
  message         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  offer_id        uuid REFERENCES offers(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, seller_id)
);
CREATE INDEX request_proposals_seller ON request_proposals (seller_id, updated_at DESC);

ALTER TABLE buyer_requests ADD CONSTRAINT buyer_requests_accepted_fk FOREIGN KEY (accepted_proposal_id) REFERENCES request_proposals(id);

-- A listing made from an accepted proposal: only that buyer can see or buy it, and it never
-- appears in search, game pages or the seller's public shop.
ALTER TABLE offers ADD COLUMN reserved_for uuid REFERENCES users(id);
ALTER TABLE offers ADD COLUMN request_id uuid REFERENCES buyer_requests(id);
