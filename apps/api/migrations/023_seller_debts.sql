-- Seller debt collection. A seller balance goes negative when a refund after release or a
-- chargeback claws back more than they hold. Each negative (seller, currency) balance is a
-- debt case: reminders on a schedule, then the shop is paused until the balance is back at
-- zero. Sellers can repay by card; future sales also pay it down automatically.

CREATE TABLE seller_debts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        uuid NOT NULL REFERENCES users(id),
  currency         char(3) NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  peak_cents       bigint NOT NULL CHECK (peak_cents > 0),      -- largest amount owed while open
  owed_cents       bigint NOT NULL CHECK (owed_cents >= 0),      -- at the last check
  reminders_sent   integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  paused_at        timestamptz,                                  -- shop paused because of this debt
  escalated_at     timestamptz,                                  -- finance told
  closed_at        timestamptz,
  closed_reason    text CHECK (closed_reason IN ('repaid', 'written_off'))
);
CREATE UNIQUE INDEX seller_debts_open ON seller_debts (seller_id, currency) WHERE closed_at IS NULL;
CREATE INDEX ON seller_debts (opened_at) WHERE closed_at IS NULL;

-- Set only by debt collection, so clearing the debt lifts only a pause it caused.
ALTER TABLE users ADD COLUMN shop_paused_for_debt boolean NOT NULL DEFAULT false;

-- Card repayments of a debt, through the PSP's hosted checkout (same PCI scope as orders).
CREATE TABLE debt_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        uuid NOT NULL REFERENCES users(id),
  debt_id          uuid NOT NULL REFERENCES seller_debts(id),
  currency         char(3) NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  payment_provider text NOT NULL,
  payment_ref      text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz
);
