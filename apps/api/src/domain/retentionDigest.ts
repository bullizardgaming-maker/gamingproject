import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one, withTx } from '../db.js';
import { retentionMetrics } from './cohorts.js';
import { enqueueEmail } from './notifications.js';
import { ROLE_PERMISSIONS, STAFF_ROLES } from './permissions.js';

/**
 * Weekly retention digest for staff. Every Monday (UTC) the worker emails everyone with
 * `analytics.view` a summary of the past week against the week before, plus last month's seller
 * churn and the 90-day repeat rate from the retention dashboard (cohorts.ts). The subject starts
 * with "Alert:" when seller churn is above COHORT_ALERT_SELLER_CHURN_PCT or the repeat rate is
 * below COHORT_ALERT_REPEAT_PCT. One email per staff member per ISO week (dedupe key).
 */
const DAY = 86_400_000;
let lastCheck = 0;

/** ISO week label, e.g. 2026-W41, for the dedupe key. */
export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7)).padStart(2, '0')}`;
}

async function week(q: Queryable, from: Date, to: Date) {
  return one<{ orders: number; active_buyers: number; returning_buyers: number; new_buyers: number; active_sellers: number; new_sellers: number }>(
    q,
    `WITH w AS (SELECT buyer_id, seller_id FROM orders WHERE paid_at >= $1 AND paid_at < $2),
          fb AS (SELECT buyer_id, min(paid_at) AS first_at FROM orders WHERE paid_at IS NOT NULL GROUP BY buyer_id),
          fs AS (SELECT seller_id, min(paid_at) AS first_at FROM orders WHERE paid_at IS NOT NULL GROUP BY seller_id)
     SELECT (SELECT count(*) FROM w)::int AS orders,
            (SELECT count(DISTINCT buyer_id) FROM w)::int AS active_buyers,
            (SELECT count(*) FROM fb WHERE fb.first_at >= $1 AND fb.first_at < $2)::int AS new_buyers,
            (SELECT count(DISTINCT w.buyer_id) FROM w JOIN fb ON fb.buyer_id = w.buyer_id WHERE fb.first_at < $1)::int AS returning_buyers,
            (SELECT count(DISTINCT seller_id) FROM w)::int AS active_sellers,
            (SELECT count(*) FROM fs WHERE fs.first_at >= $1 AND fs.first_at < $2)::int AS new_sellers`,
    [from.toISOString(), to.toISOString()],
  );
}

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

/** The digest's numbers and alert lines, as of `now` (exported for tests and previews). */
export async function retentionDigest(ctx: Ctx, now = new Date()) {
  const weekEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [cur, prev, metrics] = await Promise.all([
    week(ctx.dbRead, new Date(weekEnd.getTime() - 7 * DAY), weekEnd),
    week(ctx.dbRead, new Date(weekEnd.getTime() - 14 * DAY), new Date(weekEnd.getTime() - 7 * DAY)),
    retentionMetrics(ctx.dbRead, 6, now),
  ]);
  const lastFull = [...metrics.series].reverse().find((m) => !m.partial);
  const alerts: string[] = [];
  const churn = lastFull?.seller_churn_pct ?? null;
  if (churn != null && churn > ctx.cfg.COHORT_ALERT_SELLER_CHURN_PCT) {
    alerts.push(`Seller churn in ${lastFull!.month} was ${churn}%, above the ${ctx.cfg.COHORT_ALERT_SELLER_CHURN_PCT}% line (${lastFull!.churned_sellers} of ${lastFull!.sellers_last_month} sellers stopped selling)`);
  }
  if (metrics.repeat90dPct != null && metrics.repeat90dPct < ctx.cfg.COHORT_ALERT_REPEAT_PCT) {
    alerts.push(`The 90-day repeat rate is ${metrics.repeat90dPct}%, below the ${ctx.cfg.COHORT_ALERT_REPEAT_PCT}% line`);
  }
  return {
    week: isoWeek(new Date(weekEnd.getTime() - DAY)),
    week_ending: new Date(weekEnd.getTime() - DAY).toISOString().slice(0, 10),
    ...cur,
    prev_orders: prev.orders,
    prev_active_buyers: prev.active_buyers,
    prev_returning_buyers: prev.returning_buyers,
    prev_new_buyers: prev.new_buyers,
    prev_active_sellers: prev.active_sellers,
    prev_new_sellers: prev.new_sellers,
    active_buyers_delta_pct: pct(cur.active_buyers, prev.active_buyers),
    month: lastFull?.month ?? null,
    seller_churn_pct: churn,
    churned_sellers: lastFull?.churned_sellers ?? null,
    sellers_last_month: lastFull?.sellers_last_month ?? null,
    returning_pct: lastFull?.returning_pct ?? null,
    month_active_buyers: lastFull?.active_buyers ?? 0,
    repeat_90d_pct: metrics.repeat90dPct,
    alerts,
  };
}

/** Staff whose roles carry `analytics.view`. */
async function recipients(q: Queryable) {
  const roles = STAFF_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('analytics.view'));
  return many<{ id: string }>(
    q,
    `SELECT id FROM users WHERE (role = ANY($1::text[]) OR staff_roles && $1::text[]) AND deleted_at IS NULL AND status = 'active'`,
    [roles],
  );
}

/** Sends the digest once per ISO week to each recipient; returns how many were queued. */
export async function sendRetentionDigest(ctx: Ctx, now = new Date()) {
  const digest = await retentionDigest(ctx, now);
  const staff = await recipients(ctx.db);
  // Keyed on the week it is sent in, so a rerun later the same week (another node, a restart) sends nothing.
  const key = (userId: string) => `retention_digest:${isoWeek(now)}:${userId}`;
  let queued = 0;
  await withTx(ctx.db, async (tx) => {
    for (const s of staff) {
      const before = (await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = $1', [key(s.id)])).n;
      await enqueueEmail(tx, s.id, 'retention_digest', digest, key(s.id));
      if (!before) queued++;
    }
  });
  return { week: digest.week, alerts: digest.alerts, queued };
}

/** Worker entry: Mondays (UTC), checked at most every 10 minutes; the dedupe key makes reruns harmless. */
export async function maybeSendRetentionDigest(ctx: Ctx, now = new Date()) {
  if (!ctx.cfg.COHORT_DIGEST_ENABLED) return null;
  if (now.getUTCDay() !== 1) return null;
  if (Date.now() - lastCheck < 10 * 60_000) return null;
  lastCheck = Date.now();
  return sendRetentionDigest(ctx, now);
}
