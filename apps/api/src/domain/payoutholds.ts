import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { accountId, sellerAvailable } from './ledger.js';

/**
 * Payout holds. Money released from escrow is not withdrawable straight away for
 * sellers without a track record: a buyer's card chargeback can arrive weeks after
 * the protection window, and a brand-new seller who has already withdrawn leaves
 * the platform holding the loss. The hold shrinks as the seller builds history.
 *
 *   new          fewer than 10 completed sales or account younger than 30 days
 *   established  10+ sales, 30+ days, chargeback rate under 1%
 *   trusted      100+ sales, 180+ days, chargeback rate under 0.5%
 *   watch        a chargeback in the last 90 days and a rate of 1% or more
 *
 * Staff can override the number of days per seller.
 */
export type HoldLevel = 'new' | 'established' | 'trusted' | 'watch' | 'custom';

export async function holdPolicy(ctx: Ctx, q: Queryable, sellerId: string) {
  const s = await one<{ completed: number; charged_back: number; recent_cb: number; age_days: number; override: number | null }>(
    q,
    `SELECT count(*) FILTER (WHERE o.status = 'completed')::int AS completed,
            count(*) FILTER (WHERE o.status = 'charged_back')::int AS charged_back,
            (SELECT count(*)::int FROM chargebacks c JOIN orders co ON co.id = c.order_id
              WHERE co.seller_id = u.id AND c.received_at > now() - interval '90 days') AS recent_cb,
            extract(day FROM now() - u.created_at)::int AS age_days,
            u.payout_hold_days AS override
       FROM users u LEFT JOIN orders o ON o.seller_id = u.id
      WHERE u.id = $1 GROUP BY u.id`,
    [sellerId],
  );
  const c = ctx.cfg;
  const sales = s.completed + s.charged_back;
  const rate = sales ? s.charged_back / sales : 0;
  let level: HoldLevel;
  let days: number;
  if (s.override != null) [level, days] = ['custom', s.override];
  else if (s.recent_cb > 0 && rate >= 0.01) [level, days] = ['watch', c.PAYOUT_HOLD_DAYS_WATCH];
  else if (s.completed >= 100 && s.age_days >= 180 && rate < 0.005) [level, days] = ['trusted', c.PAYOUT_HOLD_DAYS_TRUSTED];
  else if (s.completed >= 10 && s.age_days >= 30 && rate < 0.01) [level, days] = ['established', c.PAYOUT_HOLD_DAYS_ESTABLISHED];
  else [level, days] = ['new', c.PAYOUT_HOLD_DAYS_NEW];
  return { level, holdDays: days, completedSales: s.completed, chargebackRate: Math.round(rate * 10_000) / 100, accountAgeDays: s.age_days };
}

/** Balance split into what can be withdrawn now and what is still on hold, with release dates. */
export async function withdrawable(ctx: Ctx, q: Queryable, sellerId: string, currency = ctx.cfg.SETTLEMENT_CURRENCY) {
  const policy = await holdPolicy(ctx, q, sellerId);
  const available = await sellerAvailable(q, sellerId, currency);
  const account = await accountId(q, 'seller_available', currency, sellerId);
  // Held: releases inside the seller's hold period, plus any order still under an account warranty
  // (until it ends) or with an open warranty claim (until it's decided, unlocks_at null).
  const releases = await many<{ unlocks_at: string | null; cents: number }>(
    q,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM warranty_claims c WHERE c.order_id = o.id AND c.status IN ('open', 'seller_fixed', 'escalated')) THEN NULL
                 ELSE date_trunc('hour', greatest(e.created_at + make_interval(days => $2), COALESCE(o.warranty_ends_at, '-infinity'))) END AS unlocks_at,
            SUM(e.amount_cents)::bigint AS cents
       FROM ledger_entries e LEFT JOIN orders o ON o.id = e.order_id
      WHERE e.account_id = $1 AND e.memo = 'escrow_release' AND e.amount_cents > 0
        AND (e.created_at > now() - make_interval(days => $2) OR o.warranty_ends_at > now()
             OR EXISTS (SELECT 1 FROM warranty_claims c WHERE c.order_id = o.id AND c.status IN ('open', 'seller_fixed', 'escalated')))
      GROUP BY 1 ORDER BY 1 NULLS LAST`,
    [account, policy.holdDays],
  );
  const recent = releases.reduce((sum, r) => sum + Number(r.cents), 0);
  // Refunds, chargebacks and earlier withdrawals already came out of the balance; never hold more than is there.
  const heldCents = Math.min(Math.max(available, 0), recent);
  return {
    ...policy,
    currency,
    availableCents: available,
    heldCents,
    withdrawableCents: Math.max(0, available - heldCents),
    upcoming: releases.map((r) => ({ unlocksAt: r.unlocks_at, cents: Number(r.cents) })), // unlocksAt null: waiting on a warranty claim
  };
}
