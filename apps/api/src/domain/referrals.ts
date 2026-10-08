import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import type { TxScope } from './events.js';
import { accountId, post, userCredit } from './ledger.js';
import { enqueueEmail } from './notifications.js';

/**
 * Referrals: a user shares their code; when someone who signed up with it
 * completes their first order (above a minimum), the referrer gets store
 * credit, funded from treasury. Blocked (and recorded) when the two accounts
 * share a device, card or wallet, or the referrer hit the monthly cap.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

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

/** Called in the same transaction that releases an order's escrow. */
export async function maybeGrantReferral(ctx: Ctx, s: TxScope, order: { id: string; buyer_id: string; amount_cents: number; currency: string }) {
  if (!ctx.cfg.REFERRAL_REWARD_CENTS) return;
  const buyer = await maybeOne<{ referred_by: string | null }>(s.tx, 'SELECT referred_by FROM users WHERE id = $1', [order.buyer_id]);
  if (!buyer?.referred_by) return;
  if (await maybeOne(s.tx, 'SELECT 1 FROM referral_rewards WHERE referee_id = $1', [order.buyer_id])) return;
  const completed = await one<{ n: number }>(s.tx, `SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1 AND status = 'completed'`, [order.buyer_id]);
  if (completed.n !== 1 || order.amount_cents < ctx.cfg.REFERRAL_MIN_ORDER_CENTS) return;

  const referrer = buyer.referred_by;
  const record = (status: 'granted' | 'blocked', reason: string | null) =>
    s.tx.query(
      `INSERT INTO referral_rewards (referrer_id, referee_id, order_id, amount_cents, status, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
      [referrer, order.buyer_id, order.id, ctx.cfg.REFERRAL_REWARD_CENTS, status, reason],
    );

  const linked = await maybeOne(
    s.tx,
    `SELECT 1 FROM risk_signals a JOIN risk_signals b ON a.kind = b.kind AND a.value = b.value
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.kind IN ('device', 'card', 'wallet') LIMIT 1`,
    [referrer, order.buyer_id],
  );
  if (linked) return record('blocked', 'linked_accounts');
  const month = await one<{ n: number }>(
    s.tx,
    `SELECT count(*)::int AS n FROM referral_rewards WHERE referrer_id = $1 AND status = 'granted' AND created_at > date_trunc('month', now())`,
    [referrer],
  );
  if (month.n >= ctx.cfg.REFERRAL_MONTHLY_CAP) return record('blocked', 'monthly_cap');

  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'treasury', order.currency), amountCents: -ctx.cfg.REFERRAL_REWARD_CENTS },
      { account: await accountId(s.tx, 'user_credit', order.currency, referrer), amountCents: ctx.cfg.REFERRAL_REWARD_CENTS },
    ],
    'referral_reward',
    order.id,
  );
  await record('granted', null);
  await enqueueEmail(s.tx, referrer, 'referral_reward', { amount_cents: ctx.cfg.REFERRAL_REWARD_CENTS, currency: order.currency });
  s.notifyUser(referrer, 'referral.rewarded', { amountCents: ctx.cfg.REFERRAL_REWARD_CENTS });
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
  const code = await referralCode(ctx.db, userId);
  const rewards = await many(
    ctx.db,
    `SELECT r.amount_cents, r.status, r.reason, r.created_at, u.display_name AS friend FROM referral_rewards r JOIN users u ON u.id = r.referee_id
      WHERE r.referrer_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [userId],
  );
  const signedUp = await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM users WHERE referred_by = $1', [userId]);
  return {
    code,
    link: `${ctx.cfg.PUBLIC_WEB_URL}/login?ref=${code}`,
    rewardCents: ctx.cfg.REFERRAL_REWARD_CENTS,
    minOrderCents: ctx.cfg.REFERRAL_MIN_ORDER_CENTS,
    friendsSignedUp: signedUp.n,
    rewards,
  };
}
