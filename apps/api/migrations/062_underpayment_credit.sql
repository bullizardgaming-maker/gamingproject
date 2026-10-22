-- Underpayments (brief design update): what arrived is never refunded; when the order lapses it is
-- credited to the buyer's balance, to spend on a later order or withdraw under the withdrawal rules.
ALTER TABLE crypto_payments DROP CONSTRAINT crypto_payments_status_check;
ALTER TABLE crypto_payments ADD CONSTRAINT crypto_payments_status_check
  CHECK (status IN ('waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired', 'credited'));
ALTER TABLE crypto_payments ADD COLUMN credited_cents bigint;
-- Withdrawals can now come from a buyer's credit as well as a seller's balance.
ALTER TABLE withdrawals ADD COLUMN source text NOT NULL DEFAULT 'balance' CHECK (source IN ('balance', 'credit'));
