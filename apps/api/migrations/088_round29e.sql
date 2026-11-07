-- Round 29e (7 Nov 2026): review fixes.
-- M-A: free text outside the chat (dispute reasons and statements, warranty texts, progress notes, seller messages) is no
-- longer refused for an app name; a real contact attempt is accepted and flagged here for staff.
CREATE TABLE IF NOT EXISTS text_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,            -- dispute_reason | dispute_statement | progress_note | warranty_claim | warranty_reply
  ref_type    text NOT NULL,            -- order | claim
  ref_id      uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  reasons     text[] NOT NULL,
  excerpt     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  reviewed_by uuid REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS text_flags_queue ON text_flags (status, created_at);
CREATE INDEX IF NOT EXISTS text_flags_user ON text_flags (user_id, created_at DESC);

-- L: listing prices show the real rate once the promo is nearly used up — the stored seller rate is joined by the rank
-- rate and what is left of the $1,500 promo, so SQL can price the part under the cap at the promo rate and the rest at
-- the rank rate (the same split an order pays, Round 29d L1).
ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_rate_bps integer NOT NULL DEFAULT 1399;
ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_remaining_cents bigint;
UPDATE users SET rank_rate_bps = commission_rate_bps WHERE promo_remaining_cents IS NULL;
