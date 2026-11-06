import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { withScope, type TxScope } from './events.js';
import { accountId, post } from './ledger.js';

/**
 * Creator affiliate codes. Staff give a streamer a code and a share of the commission; every order
 * completed by a buyer who entered that code pays the creator their share out of the commission
 * (treasury → the creator's balance, so it is withdrawn like sales income). Independent of the
 * flat referral reward, which still applies on the first order.
 */
const CODE = /^[A-Z0-9][A-Z0-9_-]{2,19}$/;

/** A creator's share can never exceed half of the order's commission (Round 20). */
export const MAX_AFFILIATE_RATE_BPS = 5000;
const checkRate = (bps: number | undefined) => {
  if (bps != null && (bps < 0 || bps > MAX_AFFILIATE_RATE_BPS)) throw badRequest('rate_too_high', `A creator's share is at most ${MAX_AFFILIATE_RATE_BPS / 100}% of the commission`);
};
export async function createAffiliate(ctx: Ctx, staffId: string, input: { userId: string; code: string; rateBps: number; note?: string }) {
  checkRate(input.rateBps);
  const code = input.code.trim().toUpperCase();
  if (!CODE.test(code)) throw badRequest('invalid_code', 'Codes are 3 to 20 letters, digits, - or _');
  const user = await maybeOne(ctx.db, `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`, [input.userId]);
  if (!user) throw notFound('User');
  if (await maybeOne(ctx.db, 'SELECT 1 FROM affiliates WHERE code = $1', [code])) throw conflict('code_taken', 'That code is already in use');
  if (await maybeOne(ctx.db, 'SELECT 1 FROM affiliates WHERE user_id = $1', [input.userId])) throw conflict('already_affiliate', 'This user already has a code');
  return one(ctx.db, `INSERT INTO affiliates (user_id, code, rate_bps, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [input.userId, code, input.rateBps, input.note ?? '', staffId]);
}

export async function updateAffiliate(ctx: Ctx, id: string, patch: { rateBps?: number; status?: 'active' | 'paused'; note?: string }) {
  checkRate(patch.rateBps);
  const row = await maybeOne(ctx.db, `UPDATE affiliates SET rate_bps = COALESCE($2, rate_bps), status = COALESCE($3, status), note = COALESCE($4, note), updated_at = now() WHERE id = $1 RETURNING *`, [id, patch.rateBps ?? null, patch.status ?? null, patch.note ?? null]);
  if (!row) throw notFound('Affiliate');
  return row;
}

export async function listAffiliates(q: Queryable) {
  return many(
    q,
    `SELECT a.*, u.display_name, u.email,
            (SELECT count(*)::int FROM affiliate_attributions t WHERE t.affiliate_id = a.id) AS buyers,
            (SELECT COALESCE(sum(e.earned_cents), 0)::bigint FROM affiliate_earnings e WHERE e.affiliate_id = a.id) AS earned_cents,
            (SELECT count(*)::int FROM affiliate_earnings e WHERE e.affiliate_id = a.id) AS orders
       FROM affiliates a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC`,
  );
}

/** A creator's code, entered at sign-up only (CEO, Oct 24): one code per user, never added or changed later. */
export async function attributeBuyer(q: Queryable, userId: string, code: string) {
  const a = await maybeOne<{ id: string; user_id: string; status: string }>(q, 'SELECT id, user_id, status FROM affiliates WHERE code = $1', [code.trim().toUpperCase()]);
  if (!a || a.status !== 'active') throw badRequest('invalid_affiliate_code', 'That creator code is not valid');
  if (a.user_id === userId) throw badRequest('own_code', 'You cannot use your own code');
  const already = await maybeOne(q, 'SELECT 1 FROM users WHERE id = $1 AND referred_by IS NOT NULL', [userId]);
  if (already) throw conflict('one_code_only', 'One code per account: a friend’s invite code is already on it');
  const r = await q.query('INSERT INTO affiliate_attributions (user_id, affiliate_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, a.id]);
  if (!r.rowCount) throw conflict('already_attributed', 'A creator code is already on this account');
  return { affiliateId: a.id };
}
/** Is a code a creator code (as opposed to a user's invite code)? */
export async function isAffiliateCode(q: Queryable, code: string) {
  return !!(await maybeOne(q, 'SELECT 1 FROM affiliates WHERE code = $1', [code.trim().toUpperCase()]));
}

/** Called when an order completes: pays the creator's share of the commission. */
export async function maybePayAffiliate(ctx: Ctx, s: TxScope, order: { id: string; buyer_id: string; seller_id?: string; commission_cents: number; currency: string }) {
  // One code per user: a buyer who came with a friend's invite code earns for that friend, never for a creator too.
  const a = await maybeOne<{ id: string; user_id: string; rate_bps: number; attributed_at: string; prior_orders: number }>(
    s.tx,
    `SELECT a.id, a.user_id, a.rate_bps, t.created_at AS attributed_at,
            (SELECT count(*)::int FROM orders o WHERE o.buyer_id = t.user_id AND o.id <> $2 AND o.status = 'completed') AS prior_orders
       FROM affiliate_attributions t JOIN affiliates a ON a.id = t.affiliate_id JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND a.status = 'active' AND u.referred_by IS NULL`,
    [order.buyer_id, order.id],
  );
  if (!a) return null;
  // CFO (5 Nov): the creator's share runs from the buyer's 2nd order, for CREATOR_SHARE_MONTHS (12) after the code was entered.
  const months = ctx.cfg.CREATOR_SHARE_MONTHS;
  const until = new Date(a.attributed_at);
  until.setMonth(until.getMonth() + months);
  if (Date.now() > until.getTime()) return null;
  if (a.prior_orders < 1) return null;
  if (order.seller_id && order.seller_id === a.user_id) return null; // the creator never earns on their own sales
  // Round 22 (13): the same linked-account check as invite codes — a creator sharing a device, card, IP subnet or paying
  // wallet with the buyer earns nothing on that buyer's orders.
  const linked = await maybeOne(
    s.tx,
    `SELECT 1 FROM risk_signals x JOIN risk_signals y ON x.kind = y.kind AND x.value = y.value
      WHERE x.user_id = $1 AND y.user_id = $2 AND x.kind IN ('device', 'card', 'wallet', 'ip_subnet') LIMIT 1`,
    [a.user_id, order.buyer_id],
  );
  if (linked) return null;
  const earned = Math.floor((order.commission_cents * Number(a.rate_bps)) / 10_000);
  if (earned <= 0) return null;
  const ins = await s.tx.query(
    `INSERT INTO affiliate_earnings (affiliate_id, order_id, commission_cents, earned_cents, currency) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (order_id) DO NOTHING`,
    [a.id, order.id, order.commission_cents, earned, order.currency],
  );
  if (!ins.rowCount) return null;
  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'treasury', order.currency), amountCents: -earned },
      { account: await accountId(s.tx, 'seller_available', order.currency, a.user_id), amountCents: earned },
    ],
    'affiliate_commission',
    order.id,
  );
  s.notifyUser(a.user_id, 'affiliate.earned', { orderId: order.id, amountCents: earned });
  return earned;
}

/**
 * Round 29d (M5, CFO 16): the creator's first-order bounty — $2.50 for a referred buyer's FIRST completed order of $10 or
 * more, paid once the order has had no dispute for 7 days, only during the creator's first 90 days in the programme, and
 * capped per creator and across all creators per month (the caps are checked when it is paid, not when it is earned).
 */
export async function maybeRecordBounty(ctx: Ctx, s: TxScope, order: { id: string; buyer_id: string; seller_id?: string; charged_cents?: number; currency: string }) {
  if (!ctx.cfg.CREATOR_BOUNTY_CENTS) return null;
  const a = await maybeOne<{ id: string; user_id: string; created_at: string; prior_orders: number }>(
    s.tx,
    `SELECT a.id, a.user_id, a.created_at,
            (SELECT count(*)::int FROM orders o WHERE o.buyer_id = t.user_id AND o.id <> $2 AND o.status = 'completed') AS prior_orders
       FROM affiliate_attributions t JOIN affiliates a ON a.id = t.affiliate_id JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND a.status = 'active' AND u.referred_by IS NULL`,
    [order.buyer_id, order.id],
  );
  if (!a || a.prior_orders > 0) return null;
  if (order.seller_id && order.seller_id === a.user_id) return null;
  if ((order.charged_cents ?? 0) < ctx.cfg.CREATOR_BOUNTY_MIN_ORDER_CENTS) return null;
  if (Date.now() - new Date(a.created_at).getTime() > ctx.cfg.CREATOR_BOUNTY_FIRST_DAYS * 86_400_000) return null;
  const linked = await maybeOne(
    s.tx,
    `SELECT 1 FROM risk_signals x JOIN risk_signals y ON x.kind = y.kind AND x.value = y.value
      WHERE x.user_id = $1 AND y.user_id = $2 AND x.kind IN ('device', 'card', 'wallet', 'ip_subnet') LIMIT 1`,
    [a.user_id, order.buyer_id],
  );
  if (linked) return null;
  const ins = await s.tx.query(
    `INSERT INTO creator_bounties (affiliate_id, creator_id, buyer_id, order_id, amount_cents, currency, eligible_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) ON CONFLICT (order_id) DO NOTHING`,
    [a.id, a.user_id, order.buyer_id, order.id, ctx.cfg.CREATOR_BOUNTY_CENTS, order.currency, ctx.cfg.CREATOR_BOUNTY_DISPUTE_DAYS],
  );
  return ins.rowCount ? ctx.cfg.CREATOR_BOUNTY_CENTS : null;
}

/** Worker: pays the bounties whose 7 dispute-free days are up; a disputed or refunded order voids it; the monthly caps void the rest. */
export async function payCreatorBounties(ctx: Ctx, limit = 200): Promise<{ paid: number; voided: number }> {
  const due = await many<{ id: string }>(ctx.db, `SELECT id FROM creator_bounties WHERE status = 'pending' AND eligible_at <= now() ORDER BY eligible_at LIMIT $1`, [limit]);
  let paid = 0;
  let voided = 0;
  for (const { id } of due) {
    await withScope(ctx, async (s) => {
      const b = await one<any>(s.tx, 'SELECT * FROM creator_bounties WHERE id = $1 FOR UPDATE', [id]);
      if (b.status !== 'pending') return;
      const trouble = await maybeOne<{ reason: string }>(
        s.tx,
        `SELECT CASE WHEN d.id IS NOT NULL THEN 'disputed' ELSE 'order_' || o.status END AS reason
           FROM orders o LEFT JOIN disputes d ON d.order_id = o.id WHERE o.id = $1 AND (d.id IS NOT NULL OR o.status <> 'completed')`,
        [b.order_id],
      );
      const voidIt = async (reason: string) => {
        await s.tx.query(`UPDATE creator_bounties SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason]);
        voided++;
      };
      if (trouble) return voidIt(trouble.reason);
      const amount = Number(b.amount_cents);
      const month = await one<{ creator: string; total: string }>(
        s.tx,
        `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE creator_id = $1), 0)::text AS creator, COALESCE(SUM(amount_cents), 0)::text AS total
           FROM creator_bounties WHERE status = 'paid' AND paid_at >= date_trunc('month', now())`,
        [b.creator_id],
      );
      if (Number(month.creator) + amount > ctx.cfg.CREATOR_BOUNTY_CREATOR_MONTH_CAP_CENTS) return voidIt('creator_month_cap');
      if (Number(month.total) + amount > ctx.cfg.CREATOR_BOUNTY_MONTH_CAP_CENTS) return voidIt('month_cap');
      await post(
        s.tx,
        [
          { account: await accountId(s.tx, 'treasury', b.currency), amountCents: -amount },
          { account: await accountId(s.tx, 'seller_available', b.currency, b.creator_id), amountCents: amount },
        ],
        'creator_bounty',
        b.order_id,
      );
      await s.tx.query(`UPDATE creator_bounties SET status = 'paid', paid_at = now() WHERE id = $1`, [id]);
      s.notifyUser(b.creator_id, 'affiliate.bounty', { orderId: b.order_id, amountCents: amount });
      paid++;
    });
  }
  return { paid, voided };
}

/** The creator's own view: code, rate, buyers brought, earnings. */
export async function affiliateSummary(q: Queryable, userId: string) {
  const a = await maybeOne<any>(
    q,
    `SELECT a.id, a.code, a.rate_bps, a.status, a.created_at,
            (SELECT count(*)::int FROM affiliate_attributions t WHERE t.affiliate_id = a.id) AS buyers,
            (SELECT COALESCE(sum(e.earned_cents), 0)::bigint FROM affiliate_earnings e WHERE e.affiliate_id = a.id) AS earned_cents,
            (SELECT COALESCE(sum(e.earned_cents), 0)::bigint FROM affiliate_earnings e WHERE e.affiliate_id = a.id AND e.created_at > date_trunc('month', now())) AS earned_month_cents,
            (SELECT count(*)::int FROM affiliate_earnings e WHERE e.affiliate_id = a.id) AS orders,
            (SELECT COALESCE(sum(b.amount_cents), 0)::bigint FROM creator_bounties b WHERE b.affiliate_id = a.id AND b.status = 'paid') AS bounties_paid_cents,
            (SELECT COALESCE(sum(b.amount_cents), 0)::bigint FROM creator_bounties b WHERE b.affiliate_id = a.id AND b.status = 'pending') AS bounties_pending_cents
       FROM affiliates a WHERE a.user_id = $1`,
    [userId],
  );
  if (!a) return null;
  const recent = await many(q, `SELECT e.order_id, e.commission_cents, e.earned_cents, e.currency, e.created_at FROM affiliate_earnings e WHERE e.affiliate_id = $1 ORDER BY e.created_at DESC LIMIT 50`, [a.id]);
  return { ...a, rate_bps: Number(a.rate_bps), earned_cents: Number(a.earned_cents), earned_month_cents: Number(a.earned_month_cents), bounties_paid_cents: Number(a.bounties_paid_cents), bounties_pending_cents: Number(a.bounties_pending_cents), recent };
}
