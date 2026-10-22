import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one, withTx } from '../db.js';

/**
 * Seller trust levels, shown as a badge on listings and shops. Earned from a track record and
 * lost when it slips: every requirement of a level must hold. Rates are over the last 90 days
 * (on-time: manual orders with a delivery deadline; disputes and chargebacks: paid orders).
 * A seller with too few recent orders for a rate to mean anything passes that check.
 */
export const TRUST_LEVELS = ['new', 'rising', 'trusted', 'top'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface TrustRequirements {
  completed: number;
  ageDays: number;
  /** Lowest on-time delivery rate, %. */
  onTimePct: number;
  /** Highest dispute rate, %. */
  disputePct: number;
  /** Highest chargeback rate, %. */
  chargebackPct: number;
}
export const REQUIREMENTS: Record<Exclude<TrustLevel, 'new'>, TrustRequirements> = {
  rising: { completed: 10, ageDays: 30, onTimePct: 85, disputePct: 5, chargebackPct: 1 },
  trusted: { completed: 100, ageDays: 180, onTimePct: 92, disputePct: 2, chargebackPct: 0.5 },
  top: { completed: 1000, ageDays: 365, onTimePct: 97, disputePct: 1, chargebackPct: 0.3 },
};
/** Below this many recent orders a rate isn't judged. */
export const MIN_RATE_SAMPLE = 10;

export interface TrustMetrics {
  completed: number;
  ageDays: number;
  onTimePct: number | null;
  disputePct: number | null;
  chargebackPct: number | null;
}

export async function trustMetrics(q: Queryable, sellerId: string): Promise<TrustMetrics> {
  const m = await one<any>(
    q,
    `SELECT (SELECT count(*)::int FROM orders WHERE seller_id = u.id AND status = 'completed') AS completed,
            extract(day FROM now() - u.created_at)::int AS age_days,
            (SELECT count(*)::int FROM orders o WHERE o.seller_id = u.id AND o.delivery_due_at IS NOT NULL AND o.delivery_due_at < now()
                AND o.created_at > now() - interval '90 days' AND o.status NOT IN ('cancelled', 'awaiting_payment')) AS due_n,
            (SELECT count(*)::int FROM orders o WHERE o.seller_id = u.id AND o.delivery_due_at IS NOT NULL AND o.delivery_due_at < now()
                AND o.created_at > now() - interval '90 days' AND o.status NOT IN ('cancelled', 'awaiting_payment') AND o.delivered_at <= o.delivery_due_at) AS on_time_n,
            (SELECT count(*)::int FROM orders o WHERE o.seller_id = u.id AND o.paid_at > now() - interval '90 days') AS paid_n,
            (SELECT count(*)::int FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.seller_id = u.id AND o.paid_at > now() - interval '90 days') AS disputed_n,
            (SELECT count(*)::int FROM chargebacks c JOIN orders o ON o.id = c.order_id WHERE o.seller_id = u.id AND o.paid_at > now() - interval '90 days') AS cb_n
       FROM users u WHERE u.id = $1`,
    [sellerId],
  );
  const pct = (n: number, d: number) => (d >= MIN_RATE_SAMPLE ? Math.round((1000 * n) / d) / 10 : null);
  return {
    completed: m.completed,
    ageDays: m.age_days,
    onTimePct: pct(m.on_time_n, m.due_n),
    disputePct: pct(m.disputed_n, m.paid_n),
    chargebackPct: pct(m.cb_n, m.paid_n),
  };
}

/** Which requirements of a level the metrics meet. */
export function checkLevel(m: TrustMetrics, r: TrustRequirements) {
  return {
    completed: m.completed >= r.completed,
    ageDays: m.ageDays >= r.ageDays,
    onTimePct: m.onTimePct == null || m.onTimePct >= r.onTimePct,
    disputePct: m.disputePct == null || m.disputePct <= r.disputePct,
    chargebackPct: m.chargebackPct == null || m.chargebackPct <= r.chargebackPct,
  };
}

export function levelFor(m: TrustMetrics): TrustLevel {
  let level: TrustLevel = 'new';
  for (const l of ['rising', 'trusted', 'top'] as const) {
    if (Object.values(checkLevel(m, REQUIREMENTS[l])).every(Boolean)) level = l;
    else break;
  }
  return level;
}

/** A seller's level, metrics and what the next level needs (seller hub and profile). */
export async function trustSummary(q: Queryable, sellerId: string) {
  const metrics = await trustMetrics(q, sellerId);
  const level = levelFor(metrics);
  const next = TRUST_LEVELS[TRUST_LEVELS.indexOf(level) + 1] as Exclude<TrustLevel, 'new'> | undefined;
  return {
    level,
    metrics,
    next: next ? { level: next, requirements: REQUIREMENTS[next], met: checkLevel(metrics, REQUIREMENTS[next]) } : null,
  };
}

/** Worker: refresh cached levels for sellers with recent orders, and a daily pass for everyone else with a level. */
export async function refreshTrustLevels(ctx: Ctx, limit = 1_000): Promise<number> {
  const sellers = await many<{ id: string; trust_level: TrustLevel }>(
    ctx.db,
    `SELECT u.id, u.trust_level FROM users u
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.seller_id = u.id AND o.updated_at > now() - interval '2 hours')
         OR (u.trust_level <> 'new' AND (u.trust_computed_at IS NULL OR u.trust_computed_at < now() - interval '1 day'))
      LIMIT $1`,
    [limit],
  );
  let changed = 0;
  for (const s of sellers) {
    const level = levelFor(await trustMetrics(ctx.db, s.id));
    if (level !== s.trust_level) changed++;
    await ctx.db.query('UPDATE users SET trust_level = $2, trust_computed_at = now() WHERE id = $1', [s.id, level]);
  }
  return changed;
}

let lastRun = 0;
export async function maybeRefreshTrustLevels(ctx: Ctx) {
  if (Date.now() - lastRun < 60 * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727295) AS l')).l);
  if (!locked) return null;
  return refreshTrustLevels(ctx);
}
