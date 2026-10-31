-- Automated FX top-ups. When sellers are owed more EUR/GBP than the platform holds, the planner
-- proposes buying the shortfall (plus a buffer) from the settlement currency. Finance approves
-- (four eyes for proposals a person made), or proposals under FX_TOPUP_AUTO_APPROVE_CENTS run
-- on their own. The FX provider quotes and executes, and the result is booked as a conversion.

CREATE TABLE fx_topups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency  char(3) NOT NULL,
  to_currency    char(3) NOT NULL CHECK (to_currency <> from_currency),
  to_cents       bigint NOT NULL CHECK (to_cents > 0),               -- amount to buy
  est_from_cents bigint NOT NULL CHECK (est_from_cents > 0),         -- at the reference rate when proposed
  status         text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed', 'executing', 'completed', 'failed', 'rejected', 'superseded')),
  reason         text NOT NULL,
  provider       text,
  provider_ref   text,
  from_cents     bigint,                                             -- actually spent
  rate           numeric(18, 8),                                     -- to per from, as executed
  error          text,
  requested_by   uuid REFERENCES users(id),                          -- null: proposed by the planner
  decided_by     uuid REFERENCES users(id),                          -- null: auto-approved
  conversion_id  uuid REFERENCES fx_conversions(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  executed_at    timestamptz
);
CREATE UNIQUE INDEX fx_topups_one_open ON fx_topups (to_currency) WHERE status IN ('proposed', 'executing');

-- Conversions executed automatically have no person who recorded them.
ALTER TABLE fx_conversions ALTER COLUMN recorded_by DROP NOT NULL;
