import type { Queryable } from '../db.js';
import { many } from '../db.js';

/**
 * Staff retention dashboard. Everything counts paid orders (paid_at set), by UTC calendar month.
 *  - Buyer cohorts: buyers grouped by the month of their first paid order; for each later month,
 *    how many of them bought again. Same for sellers, by month of first sale.
 *  - Monthly series: active buyers, how many were returning (bought in an earlier month), and
 *    seller churn (sold last month, nothing this month) against sellers active last month.
 *  - Repeat rate: share of each cohort's buyers who placed a second order within 90 days.
 */
export const RETENTION_MONTHS = [6, 12, 24] as const;
export type RetentionMonths = (typeof RETENTION_MONTHS)[number];

const monthStart = (d: Date, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
const ym = (d: Date) => d.toISOString().slice(0, 7);

interface Cohort { cohort: string; size: number; retained: number[] }

async function cohorts(q: Queryable, actor: 'buyer_id' | 'seller_id', from: string, to: string, months: string[]): Promise<Cohort[]> {
  const rows = await many<{ cohort: string; month: string; n: number }>(
    q,
    `WITH first AS (
       SELECT ${actor} AS who, date_trunc('month', min(paid_at) AT TIME ZONE 'UTC') AS cohort FROM orders WHERE paid_at IS NOT NULL GROUP BY ${actor}
     ), activity AS (
       SELECT DISTINCT ${actor} AS who, date_trunc('month', paid_at AT TIME ZONE 'UTC') AS month FROM orders WHERE paid_at >= $1 AND paid_at < $2
     )
     SELECT to_char(f.cohort, 'YYYY-MM') AS cohort, to_char(a.month, 'YYYY-MM') AS month, count(*)::int AS n
       FROM first f JOIN activity a ON a.who = f.who AND a.month >= f.cohort
      WHERE f.cohort >= $1::timestamptz AT TIME ZONE 'UTC'
      GROUP BY 1, 2`,
    [from, to],
  );
  const at = new Map(rows.map((r) => [`${r.cohort}|${r.month}`, r.n]));
  return months.map((c, i) => {
    const retained = months.slice(i).map((m) => at.get(`${c}|${m}`) ?? 0);
    return { cohort: c, size: retained[0] ?? 0, retained };
  });
}

export async function retentionMetrics(q: Queryable, months: RetentionMonths, now = new Date()) {
  const start = monthStart(now, months - 1);
  const end = monthStart(now, -1);
  const prev = monthStart(now, months); // one month earlier, so the first month has a churn baseline
  const list = Array.from({ length: months }, (_, i) => ym(monthStart(start, -i)));
  const [from, to] = [start.toISOString(), end.toISOString()];

  const [buyers, sellers, series, repeat] = await Promise.all([
    cohorts(q, 'buyer_id', from, to, list),
    cohorts(q, 'seller_id', from, to, list),
    many<any>(
      q,
      `WITH months AS (
         SELECT generate_series($1::timestamptz AT TIME ZONE 'UTC', $2::timestamptz AT TIME ZONE 'UTC' - interval '1 month', interval '1 month') AS m
       ), buys AS (
         SELECT DISTINCT buyer_id AS who, date_trunc('month', paid_at AT TIME ZONE 'UTC') AS m FROM orders WHERE paid_at >= $3 AND paid_at < $2
       ), sales AS (
         SELECT DISTINCT seller_id AS who, date_trunc('month', paid_at AT TIME ZONE 'UTC') AS m FROM orders WHERE paid_at >= $3 AND paid_at < $2
       ), first_buy AS (
         SELECT buyer_id AS who, date_trunc('month', min(paid_at) AT TIME ZONE 'UTC') AS m FROM orders WHERE paid_at IS NOT NULL GROUP BY buyer_id
       ), first_sale AS (
         SELECT seller_id AS who, date_trunc('month', min(paid_at) AT TIME ZONE 'UTC') AS m FROM orders WHERE paid_at IS NOT NULL GROUP BY seller_id
       )
       SELECT to_char(mo.m, 'YYYY-MM') AS month,
              (SELECT count(*) FROM buys b WHERE b.m = mo.m)::int AS active_buyers,
              (SELECT count(*) FROM buys b JOIN first_buy f ON f.who = b.who WHERE b.m = mo.m AND f.m < mo.m)::int AS returning_buyers,
              (SELECT count(*) FROM sales s WHERE s.m = mo.m)::int AS active_sellers,
              (SELECT count(*) FROM first_sale f WHERE f.m = mo.m)::int AS new_sellers,
              (SELECT count(*) FROM sales s WHERE s.m = mo.m - interval '1 month')::int AS sellers_last_month,
              (SELECT count(*) FROM sales s WHERE s.m = mo.m - interval '1 month'
                  AND NOT EXISTS (SELECT 1 FROM sales s2 WHERE s2.who = s.who AND s2.m = mo.m))::int AS churned_sellers
         FROM months mo ORDER BY mo.m`,
      [from, to, prev.toISOString()],
    ),
    many<any>(
      q,
      `WITH firsts AS (
         SELECT buyer_id, min(paid_at) AS first_at FROM orders WHERE paid_at IS NOT NULL GROUP BY buyer_id
       )
       SELECT to_char(date_trunc('month', f.first_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS cohort,
              count(*)::int AS buyers,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM orders o WHERE o.buyer_id = f.buyer_id AND o.paid_at > f.first_at AND o.paid_at <= f.first_at + interval '90 days'
              ))::int AS repeat_90d,
              bool_and(f.first_at + interval '90 days' <= $3::timestamptz) AS complete
         FROM firsts f WHERE f.first_at >= $1 AND f.first_at < $2 GROUP BY 1 ORDER BY 1`,
      [from, to, now.toISOString()],
    ),
  ]);

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const done = repeat.filter((r) => r.complete);
  const totalBuyers = done.reduce((s, r) => s + r.buyers, 0);
  const totalRepeat = done.reduce((s, r) => s + r.repeat_90d, 0);
  return {
    months,
    buyerCohorts: buyers,
    sellerCohorts: sellers,
    // Churn needs the whole month: in the running month, sellers who haven't sold *yet* would count.
    series: series.map((r) => {
      const partial = r.month === ym(now);
      return {
        ...r,
        partial,
        returning_pct: pct(r.returning_buyers, r.active_buyers),
        churned_sellers: partial ? null : r.churned_sellers,
        seller_churn_pct: partial ? null : pct(r.churned_sellers, r.sellers_last_month),
      };
    }),
    repeat: repeat.map((r) => ({ cohort: r.cohort, buyers: r.buyers, repeat_90d: r.repeat_90d, repeat_pct: pct(r.repeat_90d, r.buyers), complete: r.complete })),
    // Only cohorts whose 90 days have fully passed, so young cohorts don't drag the rate down.
    repeat90dPct: pct(totalRepeat, totalBuyers),
  };
}
