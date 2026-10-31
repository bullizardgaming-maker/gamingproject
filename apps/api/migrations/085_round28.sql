-- Round 28 (2): the buyer pays NOWPayments' processing fee on top of the order; fixed when the first crypto invoice is made.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_fee_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS processing_fee_cents bigint NOT NULL DEFAULT 0;
-- Round 28 (1): why a received deposit has not funded its order, for Ops.
ALTER TABLE crypto_payments ADD COLUMN IF NOT EXISTS apply_note text;
