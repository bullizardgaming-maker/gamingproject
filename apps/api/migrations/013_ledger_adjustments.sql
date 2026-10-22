-- Manual ledger corrections (e.g. a PSP fee booked wrong, a goodwill credit), four-eyes approved.
-- The ledger itself stays append-only: an approved adjustment is a new balanced posting.
CREATE TABLE ledger_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason        text NOT NULL,
  lines         jsonb NOT NULL,               -- [{kind, ownerId, currency, amountCents}]
  order_id      uuid REFERENCES orders(id),
  status        text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'posted', 'rejected')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  txn_id        uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
