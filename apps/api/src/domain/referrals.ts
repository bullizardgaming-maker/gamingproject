import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import type { TxScope } from './events.js';
import { accountId, post, userCredit } from './ledger.js';
import { enqueueEmail } from './notifications.js';
import { badRequest } from '../lib/errors.js';

/**
 * Referrals, G2G-style: a user shares their code; whoever signs up with it is their referee for
 * good. On every completed order of a referee the referrer earns `referral_settings.rate_bps` of
 * Bullizard's commission (20% by default), paid from treasury to the referrer's withdrawable
 * balance, for as long as the referee stays active (completed orders no further apart than
 * `active_days`). Blocked (and recorded) when the two accounts share a device, card or wallet.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export interface ReferralSettings {
  rateBps: number;
  activeDays: number;
}
export async function referralSettings(q: Queryable): Promise<ReferralSettings> {
  const r = await one<{ rate_bps: number; active_days: number }>(q, 'SELECT rate_bps, active_days FROM referral_settings');
  return { rateBps: Number(r.rate_bps), activeDays: Number(r.active_days) };
}
/** A code owner's share can never exceed half of the order's commission (Round 20). */
export const MAX_CODE_SHARE_BPS = 5000;
export async function updateReferralSettings(q: Queryable, staffId: string, patch: Partial<ReferralSettings>) {
  if (patch.rateBps != null && (patch.rateBps < 0 || patch.rateBps > MAX_CODE_SHARE_BPS)) throw badRequest('rate_too_high', `The referral share is at most ${MAX_CODE_SHARE_BPS / 100}% of the commission`);
  await q.query(
    'UPDATE referral_settings SET rate_bps = COALESCE($1, rate_bps), active_days = COALESCE($2, active_days), updated_by = $3, updated_at = now()',
    [patch.rateBps ?? null, patch.activeDays ?? null, staffId],
  );
  return referralSettings(q);
}

export async function referralCode(q: Queryable, userId: string): Promise<string> {
  const row = await one<{ referral_code: string | null }>(q, 'SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (row.referral_code) return row.referral_code;
  for (let i = 0; i < 5; i++) {
    const code = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
    const res = await q.query('UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL', [userId, code]).catch(() => null);
    if (res?.rowCount) return code;
  }
  throw new Error('could not allocate referral code');
}

export async function referrerForCode(q: Queryable, code: string | undefined): Promise<string | null> {
  if (!code) return null;
  const r = await maybeOne<{ id: string }>(q, `SELECT id FROM users WHERE referral_code = $1 AND deleted_at IS NULL AND status = 'active'`, [code.trim().toUpperCase()]);
  return r?.id ?? null;
}

/** Called in the same transaction that releases an order's escrow: the referrer's share of this order's commission. */
export async function maybeGrantReferral(ctx: Ctx, s: TxScope, order: { id: string; buyer_id: string; seller_id?: string; amount_cents: number; commission_cents: number; currency: string }) {
  // Lock the referee's row: two orders completing together can't both count as the "first" (Round 20).
  const buyer = await maybeOne<{ referred_by: string | null }>(s.tx, 'SELECT referred_by FROM users WHERE id = $1 FOR UPDATE', [order.buyer_id]);
  if (!buyer?.referred_by) return null;
  const referrer = buyer.referred_by;
  // The code owner never earns on their own sales.
  if (order.seller_id && order.seller_id === referrer) return null;
  const settings = await referralSettings(s.tx);
  const earned = Math.floor((Number(order.commission_cents) * settings.rateBps) / 10_000);
  if (earned <= 0) return null;
  if (await maybeOne(s.tx, 'SELECT 1 FROM referral_rewards WHERE order_id = $1', [order.id])) return null; // replayed release

  const record = (status: 'granted' | 'blocked', reason: string | null) =>
    s.tx.query(
      `INSERT INTO referral_rewards (referrer_id, referee_id, order_id, amount_cents, commission_cents, rate_bps, currency, status, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [referrer, order.buyer_id, order.id, earned, order.commission_cents, settings.rateBps, order.currency, status, reason],
    );

  const linked = await maybeOne(
    s.tx,
    `SELECT 1 FROM risk_signals a JOIN risk_signals b ON a.kind = b.kind AND a.value = b.value
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.kind IN ('device', 'card', 'wallet', 'ip_subnet') LIMIT 1`,
    [referrer, order.buyer_id],
  );
  if (linked) {
    await record('blocked', 'linked_accounts');
    return null;
  }

  // CEO (Oct 24): the share starts AFTER the referee's first completed order, and only while they
  // are active (a completed order within the last active_days).
  const prev = await maybeOne<{ completed_at: string }>(
    s.tx,
    `SELECT completed_at FROM orders WHERE buyer_id = $1 AND status = 'completed' AND id <> $2 ORDER BY completed_at DESC LIMIT 1`,
    [order.buyer_id, order.id],
  );
  if (!prev) {
    await record('blocked', 'first_order');
    return null;
  }
  if (Date.now() - new Date(prev.completed_at).getTime() > settings.activeDays * 86_400_000) {
    await record('blocked', 'inactive');
    return null;
  }
  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'treasury', order.currency), amountCents: -earned },
      { account: await accountId(s.tx, 'seller_available', order.currency, referrer), amountCents: earned },
    ],
    'referral_reward',
    order.id,
  );
  await record('granted', null);
  // The email is a daily digest (sendReferralDigests, worker); the in-app event is immediate.
  s.notifyUser(referrer, 'referral.rewarded', { orderId: order.id, amountCents: earned });
  return earned;
}

/** Worker (hourly): one `referral_earned` email per referrer per day, covering the previous UTC day's granted rewards. */
export async function sendReferralDigests(ctx: Ctx) {
  const settings = await referralSettings(ctx.db);
  const rows = await many<{ referrer_id: string; day: string; amount: number; n: number; currency: string }>(
    ctx.db,
    `SELECT referrer_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, sum(amount_cents)::bigint AS amount, count(*)::int AS n, min(currency) AS currency
       FROM referral_rewards WHERE status = 'granted' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day' AND created_at < date_trunc('day', now() AT TIME ZONE 'UTC')
      GROUP BY referrer_id, day`,
  );
  let sent = 0;
  for (const r of rows) {
    await enqueueEmail(ctx.db, r.referrer_id, 'referral_earned', { amount_cents: Number(r.amount), count: r.n, currency: r.currency, rate_pct: settings.rateBps / 100 }, `referral_earned:${r.referrer_id}:${r.day}`);
    sent++;
  }
  return { sent };
}

/** Credit not already promised to unpaid orders. */
export async function availableCredit(q: Queryable, userId: string, currency: string) {
  const [bal, held] = await Promise.all([
    userCredit(q, userId, currency),
    one<{ s: number }>(q, `SELECT COALESCE(SUM(credit_cents), 0)::bigint AS s FROM orders WHERE buyer_id = $1 AND status = 'awaiting_payment'`, [userId]),
  ]);
  return Math.max(0, bal - held.s);
}

export async function referralSummary(ctx: Ctx, userId: string) {
  const [code, settings] = await Promise.all([referralCode(ctx.db, userId), referralSettings(ctx.db)]);
  const rewards = await many(
    ctx.db,
    `SELECT r.order_id, r.amount_cents, r.commission_cents, r.rate_bps, r.currency, r.status, r.reason, r.created_at, u.display_name AS friend
       FROM referral_rewards r JOIN users u ON u.id = r.referee_id WHERE r.referrer_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [userId],
  );
  const totals = await one<{ earned: number; month: number; orders: number }>(
    ctx.db,
    `SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'granted'), 0)::bigint AS earned,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'granted' AND created_at > date_trunc('month', now())), 0)::bigint AS month,
            count(*) FILTER (WHERE status = 'granted')::int AS orders
       FROM referral_rewards WHERE referrer_id = $1`,
    [userId],
  );
  const signedUp = await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM users WHERE referred_by = $1', [userId]);
  const active = await one<{ n: number }>(
    ctx.db,
    `SELECT count(DISTINCT o.buyer_id)::int AS n FROM orders o JOIN users u ON u.id = o.buyer_id
      WHERE u.referred_by = $1 AND o.status = 'completed' AND o.completed_at > now() - make_interval(days => $2)`,
    [userId, settings.activeDays],
  );
  return {
    code,
    link: `${ctx.cfg.PUBLIC_WEB_URL}/login?ref=${code}`,
    rateBps: settings.rateBps,
    activeDays: settings.activeDays,
    friendsSignedUp: signedUp.n,
    friendsActive: active.n,
    earnedCents: Number(totals.earned),
    earnedMonthCents: Number(totals.month),
    ordersPaid: totals.orders,
    rewards,
  };
}
