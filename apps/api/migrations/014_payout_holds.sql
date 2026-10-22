-- Staff can override a seller's payout hold (NULL = automatic from track record).
ALTER TABLE users ADD COLUMN payout_hold_days integer CHECK (payout_hold_days BETWEEN 0 AND 90);
