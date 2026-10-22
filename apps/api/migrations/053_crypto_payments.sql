-- Crypto payments through NOWPayments. An order may have several payments (a top-up after an
-- underpayment shares the first payment's purchase id). Refunds are manual crypto transfers
-- queued for the treasury; chargebacks don't exist on this rail.
CREATE TABLE crypto_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid REFERENCES orders(id),         -- a single order…
  checkout_id      uuid REFERENCES checkouts(id),      -- …or a cart checkout (several orders, one payment)
  provider         text NOT NULL DEFAULT 'nowpayments',
  payment_id       text NOT NULL UNIQUE,         -- NOWPayments payment_id
  purchase_id      text,                         -- groups top-ups with the first payment
  pay_currency     text NOT NULL,                -- coin the buyer chose, e.g. btc, usdttrc20
  pay_address      text NOT NULL,
  pay_extra_id     text,                         -- memo/tag for coins that need one
  pay_amount       numeric(30, 12) NOT NULL,     -- what the buyer must send, in pay_currency
  price_usd        numeric(18, 2) NOT NULL,      -- what this payment covers, in USD
  actually_paid    numeric(30, 12) NOT NULL DEFAULT 0,
  actually_paid_usd numeric(18, 2),
  outcome_amount   numeric(30, 12),              -- what reached the store wallet
  outcome_currency text,
  status           text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired')),
  expires_at       timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (order_id IS NOT NULL OR checkout_id IS NOT NULL)
);
CREATE INDEX ON crypto_payments (order_id, created_at);
CREATE INDEX ON crypto_payments (checkout_id, created_at);

-- Money owed back to a buyer (cancelled after paying, refund decided in a dispute). The CFO sends
-- it from the store wallet and records the transaction hash here.
CREATE TABLE crypto_refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  currency       char(3) NOT NULL,
  reason         text NOT NULL,
  refund_address text,                           -- the buyer supplies it; null until they do
  refund_currency text,
  status         text NOT NULL DEFAULT 'awaiting_address' CHECK (status IN ('awaiting_address', 'pending', 'sent', 'cancelled')),
  tx_hash        text,
  decided_by     uuid REFERENCES users(id),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON crypto_refunds (status, created_at);

-- Two liabilities that sit at the payment provider until the CFO acts: refunds owed to buyers
-- (crypto is sent back by hand) and seller withdrawals awaiting approval.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'gateway_clearing', 'escrow', 'treasury', 'reserve', 'seller_available', 'payouts',
  'platform_withdrawals', 'user_credit', 'fx_pnl', 'tax_payable', 'fx_position', 'fx_conversion',
  'refunds_payable',        -- owed back to buyers, still in the store wallet
  'withdrawals_pending'     -- seller withdrawals requested, not yet approved and sent
));

-- Seller payouts go to a crypto address the seller confirmed (email link, then a 2FA code when
-- they have one). Withdrawals carry a fee and wait for the CFO's approval before anything is sent.
ALTER TABLE users
  ADD COLUMN payout_address          text,
  ADD COLUMN payout_address_currency text,          -- e.g. usdttrc20
  ADD COLUMN payout_address_set_at   timestamptz;

CREATE TABLE payout_address_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  address     text NOT NULL,
  currency    text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payout_address_changes (user_id, created_at DESC);

ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_status_check;
ALTER TABLE withdrawals
  ADD CONSTRAINT withdrawals_status_check CHECK (status IN ('pending', 'pending_approval', 'processing', 'paid', 'failed', 'rejected')),
  ADD COLUMN fee_cents            bigint NOT NULL DEFAULT 0,
  ADD COLUMN net_cents            bigint,
  ADD COLUMN destination_address  text,
  ADD COLUMN destination_currency text,
  ADD COLUMN decided_by           uuid REFERENCES users(id),
  ADD COLUMN decided_at           timestamptz,
  ADD COLUMN decision_note        text,
  ADD COLUMN payout_id            text,            -- NOWPayments withdrawal id (IPNs carry it)
  ADD COLUMN tx_hash              text,
  ADD COLUMN failure_reason       text,
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now();
CREATE INDEX ON withdrawals (status, created_at);
CREATE UNIQUE INDEX withdrawals_payout_id ON withdrawals (payout_id) WHERE payout_id IS NOT NULL;
