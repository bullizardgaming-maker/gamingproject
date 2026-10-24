import type { Queryable } from '../db.js';
import { many } from '../db.js';
import { sellerAvailable, userCredit } from './ledger.js';
import { availableCredit } from './referrals.js';

/**
 * One wallet view for buyers and sellers (front-end request 6): balances per currency and a
 * paged list of money events. Balances come from the ledger (buyer credit plus a seller's
 * released sales); entries are orders the user paid (negative, held while in escrow), refunds
 * and kept underpayments (positive) and withdrawals (pending until paid).
 */
export interface WalletEntry {
  id: string;
  at: string;
  kind: 'order' | 'refund' | 'credit' | 'withdrawal' | 'sale' | 'referral' | 'affiliate';
  ref: string;
  order_id?: string;
  address?: string | null;
  coin?: string | null;
  status: 'held' | 'completed' | 'cancelled' | 'pending';
  amount_cents: number;
  currency: string;
}

export const WALLET_CURRENCIES = ['USD', 'EUR'] as const;

export async function walletBalances(q: Queryable, userId: string) {
  const out: Record<string, number> = {};
  const breakdown: Record<string, { credit_cents: number; sales_cents: number; credit_available_cents: number }> = {};
  for (const cur of WALLET_CURRENCIES) {
    const [credit, available, sales] = await Promise.all([userCredit(q, userId, cur), availableCredit(q, userId, cur), sellerAvailable(q, userId, cur)]);
    out[cur] = credit + sales;
    breakdown[cur] = { credit_cents: credit, credit_available_cents: available, sales_cents: sales };
  }
  return { balances: out, breakdown };
}

export async function walletEntries(q: Queryable, userId: string, opts: { limit?: number; before?: string | null } = {}): Promise<{ entries: WalletEntry[]; next: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before ?? null;
  const rows = await many<any>(
    q,
    `WITH ev AS (
       -- Orders the user paid for: held while the money sits in escrow, completed on release, cancelled on refund/cancel.
       SELECT o.id::text AS id, COALESCE(o.paid_at, o.created_at) AS at, 'order' AS kind, COALESCE(o.ref, 'order#' || upper(left(o.id::text, 7))) AS ref, o.id AS order_id,
              NULL::text AS address, NULL::text AS coin,
              CASE WHEN o.status IN ('paid', 'delivered', 'disputed') THEN 'held' WHEN o.status = 'completed' THEN 'completed' ELSE 'cancelled' END AS status,
              -o.amount_cents AS amount_cents, o.currency
         FROM orders o WHERE o.buyer_id = $1 AND o.status <> 'awaiting_payment'
       UNION ALL
       -- Sales released to a seller.
       SELECT o.id::text || ':sale', o.completed_at, 'sale', COALESCE(o.ref, 'order#' || upper(left(o.id::text, 7))), o.id, NULL, NULL, 'completed', COALESCE(o.seller_received_cents, o.seller_net_cents), o.currency
         FROM orders o WHERE o.seller_id = $1 AND o.status = 'completed' AND o.completed_at IS NOT NULL
       UNION ALL
       -- Refunds back to the buyer (card refunds and crypto refunds the treasury sent).
       SELECT o.id::text || ':refund', o.updated_at, 'refund', COALESCE(o.ref, 'order#' || upper(left(o.id::text, 7))), o.id, r.refund_address, r.refund_currency,
              CASE WHEN r.id IS NULL OR r.status = 'sent' THEN 'completed' WHEN r.status = 'cancelled' THEN 'cancelled' ELSE 'pending' END,
              o.amount_cents, o.currency
         FROM orders o LEFT JOIN crypto_refunds r ON r.order_id = o.id AND r.status <> 'cancelled'
        WHERE o.buyer_id = $1 AND o.status = 'refunded'
       UNION ALL
       -- Credit kept in the balance (underpayments, referral rewards): what landed in user_credit from outside an order refund.
       SELECT e.id::text, e.created_at, 'credit', COALESCE(o.ref, e.memo), e.order_id, NULL, NULL, 'completed', e.amount_cents, a.currency
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id LEFT JOIN orders o ON o.id = e.order_id
        WHERE a.owner_id = $1 AND a.kind = 'user_credit' AND e.amount_cents > 0 AND e.memo NOT IN ('refund')
       UNION ALL
       -- Referral share of our commission on a friend's order, and creator-code earnings: both land in the withdrawable balance.
       SELECT r.id::text, r.created_at, 'referral', COALESCE(o.ref, 'order#' || upper(left(o.id::text, 7))), r.order_id, NULL, NULL, 'completed', r.amount_cents, r.currency
         FROM referral_rewards r JOIN orders o ON o.id = r.order_id WHERE r.referrer_id = $1 AND r.status = 'granted'
       UNION ALL
       SELECT e.id::text, e.created_at, 'affiliate', COALESCE(o.ref, 'order#' || upper(left(o.id::text, 7))), e.order_id, NULL, NULL, 'completed', e.earned_cents, e.currency
         FROM affiliate_earnings e JOIN affiliates a ON a.id = e.affiliate_id JOIN orders o ON o.id = e.order_id WHERE a.user_id = $1
       UNION ALL
       -- Withdrawals (buyer credit or seller sales).
       SELECT w.id::text, w.created_at, 'withdrawal', 'withdrawal#' || upper(left(w.id::text, 7)), NULL, w.destination_address, w.destination_currency,
              CASE WHEN w.status = 'paid' THEN 'completed' WHEN w.status IN ('failed', 'rejected') THEN 'cancelled' ELSE 'pending' END,
              -w.amount_cents, w.currency
         FROM withdrawals w WHERE w.user_id = $1
     )
     SELECT * FROM ev WHERE ($2::timestamptz IS NULL OR at < $2) ORDER BY at DESC, id DESC LIMIT $3`,
    [userId, before, limit + 1],
  );
  const page = rows.slice(0, limit).map((r) => ({ ...r, amount_cents: Number(r.amount_cents), at: new Date(r.at).toISOString() }));
  return { entries: page, next: rows.length > limit ? page[page.length - 1]!.at : null };
}

export async function wallet(q: Queryable, userId: string, opts: { limit?: number; before?: string | null } = {}) {
  const [b, e] = await Promise.all([walletBalances(q, userId), walletEntries(q, userId, opts)]);
  return { ...b, ...e };
}
