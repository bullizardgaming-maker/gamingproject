-- Round 22b (follow-up to Round 22). Idempotent.

-- 1. A withdrawal that already carries the provider's ids was handed over: record the attempt, so sendPayout and the hourly
-- job never send it again (they only send rows with no attempt and no provider ids).
UPDATE withdrawals SET provider_attempted_at = COALESCE(decided_at, updated_at, now())
 WHERE provider_attempted_at IS NULL AND (payout_id IS NOT NULL OR provider_ref IS NOT NULL);

-- 5. A flag that banned automatically remembers the status it replaced; dismissing it restores that status.
ALTER TABLE chat_flags ADD COLUMN IF NOT EXISTS auto_ban boolean NOT NULL DEFAULT false;
ALTER TABLE chat_flags ADD COLUMN IF NOT EXISTS prior_status text;
-- Open Round 22 filter bans (strike recorded at once, user still banned by the filter); the filter only acts on active users.
UPDATE chat_flags f SET auto_ban = true, prior_status = 'active'
  FROM users u
 WHERE u.id = f.user_id AND f.status = 'open' AND f.strike AND NOT f.auto_ban AND u.status = 'banned' AND u.suspension_reason = 'off_platform_ban';

-- 6. Seller payout currencies other than USD are gone (payouts are USDT).
UPDATE users SET payout_currency = 'USD' WHERE payout_currency IN ('EUR', 'EGP');

-- 7. Coins sent for a withdrawal that was already reversed: recorded for Finance.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paid_after_reversal_at timestamptz;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paid_after_reversal_hash text;
-- 7. Four-eyes: the requirement is stored with the first approval and kept.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS four_eyes_required boolean NOT NULL DEFAULT false;
UPDATE withdrawals SET four_eyes_required = true WHERE first_approved_by IS NOT NULL AND status = 'pending_approval' AND NOT four_eyes_required;
