-- Round 29 (5): staging-only manual "mark as sent" for payouts the sandbox cannot send (two staff, audited).
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS manual_send_requested_by uuid REFERENCES users(id);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS manual_send_requested_at timestamptz;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS manual_send_note text;

-- Round 29 (1): regions, not countries (CEO, 5 Nov). The user's region is a display / browse preference; no country on
-- the account. The connection's country (CF-IPCountry) is recorded on sessions for staff and the fraud score. The only
-- country a user types is the one on the withdrawal form (stored on the payout method and each withdrawal).
ALTER TABLE users ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'global';
-- Round 29c: security emails show the time in the user's timezone (Cairo when unknown).
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_region_check;
ALTER TABLE users ADD CONSTRAINT users_region_check CHECK (region IN ('asia', 'middle_east', 'america', 'europe', 'global'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_country char(2);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_country char(2);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS country char(2);
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS country char(2);

-- Round 29 (6): Dragon rank fee 7.99 % (was 9.99 %) — CEO decision 5.
UPDATE seller_ranks SET rate_bps = 799, updated_at = now() WHERE name = 'Dragon' AND rate_bps = 999;

-- Round 29 (2): each withdrawal method asks for what it needs. USDT: network + address; wallet: phone; InstaPay: IPA or
-- phone. The phone / IPA is stored encrypted (users.payout_identifier_ciphertext), only for the payout, confirmed by the
-- same emailed-code flow as an address change. Bank transfers come later.
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_method text NOT NULL DEFAULT 'usdt';
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_identifier_ciphertext text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_identifier_hint text;         -- e.g. "•••• 4567" / "a•••@bank"
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'usdt';
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS identifier_ciphertext text;
ALTER TABLE payout_address_changes ADD COLUMN IF NOT EXISTS identifier_hint text;
ALTER TABLE payout_address_changes ALTER COLUMN address DROP NOT NULL;
ALTER TABLE payout_address_changes ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'usdt';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS destination_ciphertext text;    -- phone / IPA for manual methods
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS destination_hint text;
ALTER TABLE withdrawals ALTER COLUMN destination_address DROP NOT NULL;
ALTER TABLE withdrawals ALTER COLUMN destination_currency DROP NOT NULL;

-- CFO decisions (5 Nov): an EGP method is paid in EGP at the rate table; the provider's own error is kept on the row.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_currency char(3) NOT NULL DEFAULT 'USD';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_amount_cents bigint;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_rate numeric(18, 8);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_key text;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS provider_error jsonb;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS review_reason text;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS review_reasons_text text[] NOT NULL DEFAULT '{}';

-- CFO (5 Nov): the launch promo covers at most $1,500 of a seller's sales (editable with the rank table).
ALTER TABLE commission_settings ADD COLUMN IF NOT EXISTS promo_max_sales_cents bigint NOT NULL DEFAULT 150000;

-- Round 29b (CFO, 5 Nov): wallet deposits ("add funds"). A crypto deposit is a NOWPayments invoice like an order's
-- (processing fee on top); Egyptian methods are listed but disabled until the PSP is live.
CREATE TABLE IF NOT EXISTS wallet_deposits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),
  method               text NOT NULL,                       -- crypto | card_egypt | wallet | instapay
  currency             char(3) NOT NULL,                    -- the wallet currency it lands in (the method's currency)
  amount_cents         bigint NOT NULL,                     -- what lands in the wallet
  fee_cents            bigint NOT NULL DEFAULT 0,           -- the method's deposit fee, paid on top, never refunded
  total_cents          bigint NOT NULL,                     -- amount + fee (the invoice)
  status               text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'credited', 'cancelled', 'expired', 'held')),
  payment_provider     text,
  payment_ref          text,
  ip_country           char(2),
  credited_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_deposits_user_idx ON wallet_deposits (user_id, created_at DESC);
ALTER TABLE crypto_payments ADD COLUMN IF NOT EXISTS deposit_id uuid REFERENCES wallet_deposits(id);
ALTER TABLE crypto_payments DROP CONSTRAINT IF EXISTS crypto_payments_check;
ALTER TABLE crypto_payments ADD CONSTRAINT crypto_payments_check CHECK (order_id IS NOT NULL OR checkout_id IS NOT NULL OR deposit_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS crypto_payments_deposit_idx ON crypto_payments (deposit_id, created_at);
-- Fraud review rows for withdrawals (top-up → withdraw patterns), next to the order ones.
ALTER TABLE risk_flags ADD COLUMN IF NOT EXISTS withdrawal_id uuid REFERENCES withdrawals(id);
