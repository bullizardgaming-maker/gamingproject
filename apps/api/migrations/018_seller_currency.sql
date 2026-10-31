-- Sellers can hold their balance and be paid out in EUR or GBP (not only the settlement currency).
--
-- The rate is locked on the order when it is placed (mid-market, no spread), so a seller who prices
-- in EUR gets exactly their EUR price minus commission, however USD/EUR moves before release.
-- Cross-currency credits pass through fx_position accounts (one per currency): the platform's open
-- currency position. Treasury closes it by converting money at the PSP/bank and recording that as an
-- fx_conversion, which keeps the per-currency PSP balance check exact.

ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'gateway_clearing', 'escrow', 'treasury', 'reserve', 'seller_available', 'payouts',
  'platform_withdrawals', 'user_credit', 'fx_pnl', 'tax_payable',
  'fx_position',            -- seller money owed in one currency, funded from another
  'fx_conversion'           -- money moved between the platform's currency balances
));

ALTER TABLE users ADD COLUMN payout_currency char(3);  -- NULL = settlement currency

ALTER TABLE orders
  ADD COLUMN seller_currency char(3),
  ADD COLUMN seller_fx_rate  numeric(20, 10);            -- seller currency units per settlement unit, mid-market

CREATE TABLE fx_conversions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency char(3) NOT NULL,
  from_cents    bigint NOT NULL CHECK (from_cents > 0),
  to_currency   char(3) NOT NULL CHECK (to_currency <> from_currency),
  to_cents      bigint NOT NULL CHECK (to_cents > 0),
  reference     text NOT NULL,                           -- PSP/bank conversion id
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
