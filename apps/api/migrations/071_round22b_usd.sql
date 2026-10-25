-- Round 22b (third pass). Idempotent.

-- 5. The suspension a filter ban replaced comes back with its original end.
ALTER TABLE chat_flags ADD COLUMN IF NOT EXISTS prior_suspended_until timestamptz;
ALTER TABLE chat_flags ADD COLUMN IF NOT EXISTS prior_suspension_reason text;
-- Withdrawals are USD only: list any non-USD seller/buyer balance for Finance (converted by a manual ledger adjustment,
-- never here). The same list is an Ops alert (`non_usd_balances`).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT a.owner_id, a.kind, a.currency, SUM(e.amount_cents)::bigint AS cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
            WHERE a.kind IN ('seller_available', 'user_credit') AND a.currency <> 'USD' AND a.owner_id IS NOT NULL
            GROUP BY a.owner_id, a.kind, a.currency HAVING SUM(e.amount_cents) <> 0 LOOP
    RAISE NOTICE 'non-USD balance for Finance: user % % % cents (%)', r.owner_id, r.currency, r.cents, r.kind;
  END LOOP;
END $$;
