-- Round 23f part B (copy deck §9.6): payouts are USDT only. A payout address in any other coin is removed, and when
-- that happened is kept, so the wallet can tell the seller why (money.payoutAddress.cleared).
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_address_cleared_at timestamptz;
UPDATE users SET payout_address = NULL, payout_address_currency = NULL, payout_address_set_at = NULL, payouts_enabled = false, payout_address_cleared_at = now()
 WHERE payout_address IS NOT NULL AND payout_address_currency NOT IN ('usdttrc20', 'usdtbsc');
