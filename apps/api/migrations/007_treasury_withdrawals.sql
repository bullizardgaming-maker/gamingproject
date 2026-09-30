-- Platform earnings withdrawals (treasury -> company bank), with four-eyes approval.
-- Also widens the ledger account kinds for store credit and FX results used by later features.

ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'gateway_clearing', 'escrow', 'treasury', 'reserve', 'seller_available', 'payouts',
  'platform_withdrawals',   -- platform revenue moved out to the company bank account
  'user_credit',            -- store credit (referral rewards), spendable at checkout
  'fx_pnl'                  -- foreign-exchange gains/losses on presentment currencies
));

CREATE TABLE treasury_withdrawals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      char(3) NOT NULL,
  note          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'paid', 'rejected', 'failed')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  provider_ref  text,
  failure       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
