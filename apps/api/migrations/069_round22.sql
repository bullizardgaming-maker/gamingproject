-- Round 22 (claude/round-22-fixes.md). Idempotent.

-- 4. Payouts in `unknown`: the NOWPayments unique_external_id is stored before the provider is called, so IPNs and polls
-- can always find the withdrawal; a "not found" answer is only acted on after two checks (30+ minutes apart) and N hours;
-- a batch created but not verified (2FA step failed) is marked so the job retries the verification instead of reversing.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS not_found_checks int NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS last_not_found_at timestamptz;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS verify_pending boolean NOT NULL DEFAULT false;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_external_id ON withdrawals (external_id) WHERE external_id IS NOT NULL;

-- 8. What each deposit contributed when it funded its order, so a second transfer to the same address is credited.
ALTER TABLE crypto_payments ADD COLUMN IF NOT EXISTS applied_cents bigint;

-- 10. Payouts are USDT (TRC-20 / BEP-20) only: any other confirmed payout address is cleared; the seller adds a USDT one.
UPDATE users SET payout_address = NULL, payout_address_currency = NULL, payout_address_set_at = NULL, payouts_enabled = false
 WHERE payout_address_currency IS NOT NULL AND payout_address_currency NOT IN ('usdttrc20', 'usdtbsc');
UPDATE payout_address_changes SET expires_at = now() WHERE confirmed_at IS NULL AND currency NOT IN ('usdttrc20', 'usdtbsc') AND expires_at > now();
