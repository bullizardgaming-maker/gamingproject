-- Round 29 (5): staging-only manual "mark as sent" for payouts the sandbox cannot send (two staff, audited).
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS manual_send_requested_by uuid REFERENCES users(id);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS manual_send_requested_at timestamptz;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS manual_send_note text;

-- Round 29 (1): regions, not countries (CEO, 5 Nov). The user's region is a display / browse preference; no country on
-- the account. The connection's country (CF-IPCountry) is recorded on sessions for staff and the fraud score. The only
-- country a user types is the one on the withdrawal form (stored on the payout method and each withdrawal).
ALTER TABLE users ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'global';
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
