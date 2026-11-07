import type { Tx } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { accountId, post } from './ledger.js';

/**
 * Security audit (Nov 2026): referral rewards, creator (affiliate) shares and creator bounties are paid out of Bullizard's
 * commission on an order. When that order is refunded after release or charged back, the commission goes back to the buyer,
 * so the reward is taken back too — pro rata to how much of the order has been refunded so far, never more than was paid.
 * The earner's balance may go below zero; the usual debt rules then apply (withdrawals stop until it is settled).
 * Unpaid bounties on the order are voided. Idempotent: what was already reversed (ledger memo per reward) is subtracted.
 */
export async function reverseOrderRewards(tx: Tx, order: { id: string; amount_cents: number | string; currency: string }, refundedTotalCents: number) {
  const total = Number(order.amount_cents);
  if (total <= 0 || refundedTotalCents <= 0) return;
  const fraction = Math.min(1, refundedTotalCents / total);

  const earned: Array<{ owner: string; currency: string; paid: number; memo: string }> = [];
  const ref = await maybeOne<{ referrer_id: string; amount_cents: string }>(tx, `SELECT referrer_id, amount_cents::text FROM referral_rewards WHERE order_id = $1 AND status = 'granted'`, [order.id]);
  if (ref) earned.push({ owner: ref.referrer_id, currency: order.currency, paid: Number(ref.amount_cents), memo: 'referral_reversal' });
  const aff = await maybeOne<{ user_id: string; earned_cents: string; currency: string }>(
    tx, `SELECT a.user_id, e.earned_cents::text, e.currency FROM affiliate_earnings e JOIN affiliates a ON a.id = e.affiliate_id WHERE e.order_id = $1`, [order.id],
  );
  if (aff) earned.push({ owner: aff.user_id, currency: aff.currency, paid: Number(aff.earned_cents), memo: 'affiliate_reversal' });
  const bounty = await maybeOne<{ id: string; creator_id: string; amount_cents: string; currency: string; status: string }>(
    tx, `SELECT id, creator_id, amount_cents::text, currency, status FROM creator_bounties WHERE order_id = $1 FOR UPDATE`, [order.id],
  );
  if (bounty?.status === 'pending') await tx.query(`UPDATE creator_bounties SET status = 'void', void_reason = 'order_refunded' WHERE id = $1`, [bounty.id]);
  if (bounty?.status === 'paid') earned.push({ owner: bounty.creator_id, currency: bounty.currency, paid: Number(bounty.amount_cents), memo: 'creator_bounty_reversal' });

  for (const e of earned) {
    const account = await accountId(tx, 'seller_available', e.currency, e.owner);
    const done = -Number((await one<{ s: string }>(tx, 'SELECT COALESCE(SUM(amount_cents), 0)::text AS s FROM ledger_entries WHERE account_id = $1 AND order_id = $2 AND memo = $3', [account, order.id, e.memo])).s);
    const due = Math.min(e.paid, Math.round(e.paid * fraction)) - done;
    if (due <= 0) continue;
    await post(tx, [{ account, amountCents: -due }, { account: await accountId(tx, 'treasury', e.currency), amountCents: due }], e.memo, order.id);
  }
}

/**
 * For a chargeback: how much of the order's card payment was already given back to the buyer's Bullizard balance. Round 29e
 * (M-B): the sum of every refund-to-balance posting — a full refund (`refund`), the buyer's leg of a dispute split
 * (`dispute_split`) and of a post-release refund (`clawback:*`) — so a partial refund is netted exactly, not all-or-nothing.
 * Postings with a gateway_clearing leg are refunds that went back to the card and are not counted. Capped at the charge.
 */
export async function cardRefundedToBalance(tx: Tx, order: { id: string; buyer_id?: string; charged_cents: number | string | null }) {
  const row = await many<{ cents: string }>(
    tx,
    `SELECT COALESCE(SUM(e.amount_cents), 0)::text AS cents
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.order_id = $1 AND a.kind = 'user_credit' AND e.amount_cents > 0
        AND (e.memo = 'refund' OR e.memo = 'dispute_split' OR e.memo LIKE 'clawback:%')
        AND NOT EXISTS (SELECT 1 FROM ledger_entries g JOIN ledger_accounts ga ON ga.id = g.account_id WHERE g.txn_id = e.txn_id AND ga.kind = 'gateway_clearing')`,
    [order.id],
  );
  return Math.min(Number(row[0]?.cents ?? 0), Number(order.charged_cents ?? 0));
}
