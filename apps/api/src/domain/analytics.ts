import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';

/**
 * Seller analytics and the staff business dashboard. Money is in the settlement currency (orders
 * store amount, commission and seller net in it). A sale counts when it is paid (paid_at); refunds
 * and chargebacks are reported against the period the order was paid in.
 */
export type Period = 7 | 30 | 90 | 365;
const bucketOf = (days: Period) => (days > 90 ? 'week' : 'day');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 100 : null);

// --------------------------------------------------------------------------------------------
// Listing views
// --------------------------------------------------------------------------------------------
/**
 * Count a listing view, once per viewer and listing per hour (exact across API nodes when Redis
 * is configured; see lib/viewDedupe.ts). Never the seller's own views. Returns a promise for
 * tests; callers fire and forget, and it never fails the page.
 */
export function recordView(ctx: Pick<Ctx, 'db' | 'views'>, offerId: string, sellerId: string, viewer: { userId?: string; ip: string }): Promise<boolean> {
  if (viewer.userId === sellerId) return Promise.resolve(false);
  return ctx.views
    .firstView(`${viewer.userId ? `u:${viewer.userId}` : `ip:${viewer.ip}`}:${offerId}`)
    .then(async (first) => {
      if (!first) return false;
      await ctx.db.query(
        `INSERT INTO offer_views (offer_id, day, views) VALUES ($1, current_date, 1)
         ON CONFLICT (offer_id, day) DO UPDATE SET views = offer_views.views + 1`,
        [offerId],
      );
      return true;
    })
    .catch(() => false);
}

// --------------------------------------------------------------------------------------------
// Seller analytics
// --------------------------------------------------------------------------------------------
async function sellerTotals(q: Queryable, sellerId: string, from: string, to: string) {
  const t = await one<any>(
    q,
    `WITH paid AS (
       SELECT o.* FROM orders o WHERE o.seller_id = $1 AND o.paid_at >= $2 AND o.paid_at < $3
     ), history AS (
       SELECT buyer_id, count(*)::int AS n FROM orders WHERE seller_id = $1 AND paid_at IS NOT NULL AND paid_at < $3 GROUP BY buyer_id
     )
     SELECT count(*)::int AS orders,
            COALESCE(sum(amount_cents), 0)::bigint AS gross_cents,
            COALESCE(sum(seller_net_cents) FILTER (WHERE status NOT IN ('refunded', 'charged_back')), 0)::bigint AS net_cents,
            count(*) FILTER (WHERE status IN ('refunded', 'charged_back'))::int AS refunded,
            (SELECT count(*)::int FROM disputes d JOIN paid p ON p.id = d.order_id) AS disputed,
            count(DISTINCT buyer_id)::int AS buyers,
            (SELECT count(*)::int FROM history h WHERE h.n >= 2 AND h.buyer_id IN (SELECT buyer_id FROM paid)) AS repeat_buyers,
            (SELECT COALESCE(sum(v.views), 0)::int FROM offer_views v JOIN offers f ON f.id = v.offer_id
              WHERE f.seller_id = $1 AND v.day >= ($2::timestamptz)::date AND v.day < ($3::timestamptz)::date) AS views
       FROM paid`,
    [sellerId, from, to],
  );
  const gross = Number(t.gross_cents);
  return {
    orders: t.orders,
    grossCents: gross,
    netCents: Number(t.net_cents),
    avgOrderCents: t.orders ? Math.round(gross / t.orders) : null,
    views: t.views,
    conversionPct: pct(t.orders, t.views),
    buyers: t.buyers,
    repeatBuyers: t.repeat_buyers,
    repeatBuyerPct: pct(t.repeat_buyers, t.buyers),
    refundRatePct: pct(t.refunded, t.orders),
    disputeRatePct: pct(t.disputed, t.orders),
  };
}

export async function sellerAnalytics(q: Queryable, sellerId: string, days: Period, now = new Date()) {
  const bucket = bucketOf(days);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end.getTime() - days * 86_400_000);
  const prevStart = new Date(start.getTime() - days * 86_400_000);
  const [from, to, prevFrom] = [start, end, prevStart].map((d) => d.toISOString()) as [string, string, string];

  const series = await many<any>(
    q,
    `WITH buckets AS (
       SELECT generate_series(date_trunc('${bucket}', $2::timestamptz AT TIME ZONE 'UTC'), $3::timestamptz AT TIME ZONE 'UTC' - interval '1 second', interval '1 ${bucket}') AS b
     ), paid AS (
       SELECT o.*, date_trunc('${bucket}', o.paid_at AT TIME ZONE 'UTC') AS b,
              EXISTS (SELECT 1 FROM orders e WHERE e.seller_id = o.seller_id AND e.buyer_id = o.buyer_id AND e.paid_at < o.paid_at) AS returning
         FROM orders o WHERE o.seller_id = $1 AND o.paid_at >= $2 AND o.paid_at < $3
     ), views AS (
       SELECT date_trunc('${bucket}', v.day::timestamp) AS b, sum(v.views)::int AS n
         FROM offer_views v JOIN offers f ON f.id = v.offer_id
        WHERE f.seller_id = $1 AND v.day >= ($2::timestamptz)::date AND v.day < ($3::timestamptz)::date GROUP BY 1
     )
     SELECT to_char(b.b, 'YYYY-MM-DD') AS date,
            count(p.id)::int AS orders,
            COALESCE(sum(p.amount_cents), 0)::bigint AS gross_cents,
            COALESCE(sum(p.seller_net_cents) FILTER (WHERE p.status NOT IN ('refunded', 'charged_back')), 0)::bigint AS net_cents,
            count(DISTINCT p.buyer_id) FILTER (WHERE NOT p.returning)::int AS new_buyers,
            count(DISTINCT p.buyer_id) FILTER (WHERE p.returning)::int AS returning_buyers,
            COALESCE(max(v.n), 0)::int AS views
       FROM buckets b LEFT JOIN paid p ON p.b = b.b LEFT JOIN views v ON v.b = b.b
      GROUP BY b.b ORDER BY b.b`,
    [sellerId, from, to],
  );

  const offers = await many<any>(
    q,
    `SELECT f.id, f.title, f.game, f.category_slug, f.status,
            COALESCE(o.orders, 0)::int AS orders, COALESCE(o.gross, 0)::bigint AS gross_cents, COALESCE(v.views, 0)::int AS views
       FROM offers f
       LEFT JOIN (SELECT offer_id, count(*) AS orders, sum(amount_cents) AS gross FROM orders
                   WHERE seller_id = $1 AND paid_at >= $2 AND paid_at < $3 GROUP BY offer_id) o ON o.offer_id = f.id
       LEFT JOIN (SELECT offer_id, sum(views) AS views FROM offer_views WHERE day >= ($2::timestamptz)::date AND day < ($3::timestamptz)::date GROUP BY offer_id) v ON v.offer_id = f.id
      WHERE f.seller_id = $1 AND (o.orders > 0 OR v.views > 0)
      ORDER BY gross_cents DESC, views DESC LIMIT 20`,
    [sellerId, from, to],
  );

  const [current, previous] = await Promise.all([sellerTotals(q, sellerId, from, to), sellerTotals(q, sellerId, prevFrom, from)]);
  return {
    days,
    bucket,
    from,
    to,
    totals: current,
    previous,
    series: series.map((s) => ({ ...s, gross_cents: Number(s.gross_cents), net_cents: Number(s.net_cents) })),
    offers: offers.map((o) => ({ ...o, gross_cents: Number(o.gross_cents), conversion_pct: pct(o.orders, o.views) })),
  };
}

// --------------------------------------------------------------------------------------------
// Staff business dashboard
// --------------------------------------------------------------------------------------------
async function businessTotals(q: Queryable, from: string, to: string) {
  const t = await one<any>(
    q,
    `WITH paid AS (SELECT * FROM orders WHERE paid_at >= $1 AND paid_at < $2)
     SELECT count(*)::int AS orders,
            COALESCE(sum(amount_cents), 0)::bigint AS gmv_cents,
            COALESCE(sum(commission_cents) FILTER (WHERE status NOT IN ('refunded', 'charged_back')), 0)::bigint AS take_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'refunded'), 0)::bigint AS refunded_cents,
            count(*) FILTER (WHERE status = 'refunded')::int AS refunds,
            count(*) FILTER (WHERE rail = 'fiat')::int AS card_orders,
            (SELECT count(*)::int FROM disputes d JOIN paid p ON p.id = d.order_id) AS disputes,
            (SELECT count(*)::int FROM chargebacks c JOIN paid p ON p.id = c.order_id) AS chargebacks,
            count(DISTINCT buyer_id)::int AS buyers,
            count(DISTINCT seller_id)::int AS sellers,
            (SELECT count(*)::int FROM (SELECT buyer_id FROM orders WHERE paid_at IS NOT NULL GROUP BY buyer_id HAVING min(paid_at) >= $1 AND min(paid_at) < $2) n) AS new_buyers,
            (SELECT count(*)::int FROM (SELECT seller_id FROM orders WHERE paid_at IS NOT NULL GROUP BY seller_id HAVING min(paid_at) >= $1 AND min(paid_at) < $2) n) AS new_sellers
       FROM paid`,
    [from, to],
  );
  const gmv = Number(t.gmv_cents);
  const take = Number(t.take_cents);
  return {
    orders: t.orders,
    gmvCents: gmv,
    takeCents: take,
    takeRatePct: pct(take, gmv),
    avgOrderCents: t.orders ? Math.round(gmv / t.orders) : null,
    refunds: t.refunds,
    refundedCents: Number(t.refunded_cents),
    refundRatePct: pct(t.refunds, t.orders),
    disputes: t.disputes,
    disputeRatePct: pct(t.disputes, t.orders),
    chargebacks: t.chargebacks,
    // Card networks measure chargebacks against card transactions only.
    chargebackRatePct: pct(t.chargebacks, t.card_orders),
    buyers: t.buyers,
    sellers: t.sellers,
    newBuyers: t.new_buyers,
    newSellers: t.new_sellers,
  };
}

/**
 * CFO B13: what the period cost us and what we owe right now, straight from the ledger.
 * Costs are treasury debits by memo inside the period; the "outstanding" figures are balances today.
 * Round 22 (23): per currency (never summed across currencies; the top level is the settlement currency, the others are
 * in `byCurrency`); promo cost is net of the promo money that came back on refunds (full, split, after release);
 * withdrawals in `unknown` count as pending.
 */
async function moneyCostsIn(q: Queryable, from: string, to: string, currency: string) {
  const c = await one<any>(
    q,
    `WITH t AS (
       SELECT e.memo, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'treasury' AND a.owner_id IS NULL AND a.currency = $3 AND e.created_at >= $1 AND e.created_at < $2 AND e.amount_cents < 0
     )
     SELECT COALESCE(-sum(amount_cents) FILTER (WHERE memo = 'promo_funding'), 0)::bigint AS promo_cents,
            -- promo money returned to the treasury: the 'refund' posting's treasury leg is exactly the promo part
            (SELECT COALESCE(sum(e.amount_cents), 0)::bigint FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
              WHERE a.kind = 'treasury' AND a.owner_id IS NULL AND a.currency = $3 AND e.memo = 'refund' AND e.amount_cents > 0 AND e.created_at >= $1 AND e.created_at < $2)
            + (SELECT COALESCE(sum(LEAST(d.refund_cents, round(o.discount_cents::numeric * d.refund_cents / NULLIF(o.amount_cents, 0)))), 0)::bigint
                 FROM disputes d JOIN orders o ON o.id = d.order_id
                WHERE d.status = 'resolved_split' AND o.currency = $3 AND o.discount_cents > 0 AND COALESCE(d.resolved_at, d.created_at) >= $1 AND COALESCE(d.resolved_at, d.created_at) < $2)
            + (SELECT COALESCE(sum(round(o.discount_cents::numeric * r.amount_cents / NULLIF(o.amount_cents, 0))), 0)::bigint
                 FROM post_release_refunds r JOIN orders o ON o.id = r.order_id
                WHERE o.currency = $3 AND o.discount_cents > 0 AND r.created_at >= $1 AND r.created_at < $2) AS promo_returned_cents,
            COALESCE(-sum(amount_cents) FILTER (WHERE memo = 'referral_reward'), 0)::bigint AS referral_cents,
            COALESCE(-sum(amount_cents) FILTER (WHERE memo = 'affiliate_commission'), 0)::bigint AS creator_cents,
            COALESCE(-sum(amount_cents) FILTER (WHERE memo = 'psp_fee'), 0)::bigint AS psp_fee_cents,
            COALESCE(-sum(amount_cents) FILTER (WHERE memo LIKE 'payout_network_fee:%' OR memo LIKE 'payout_conversion_fee:%'), 0)::bigint AS payout_fee_cents,
            (SELECT COALESCE(sum(e.amount_cents), 0)::bigint FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'user_credit' AND a.currency = $3) AS buyer_credit_cents,
            (SELECT COALESCE(sum(COALESCE(net_cents, amount_cents)), 0)::bigint FROM withdrawals WHERE currency = $3 AND status IN ('pending', 'pending_approval', 'processing', 'unknown')) AS withdrawals_pending_cents,
            (SELECT count(*)::int FROM withdrawals WHERE currency = $3 AND status IN ('pending', 'pending_approval', 'processing', 'unknown')) AS withdrawals_pending,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - paid_at)))
               FROM orders WHERE currency = $3 AND completed_at IS NOT NULL AND paid_at IS NOT NULL AND completed_at >= $1 AND completed_at < $2) AS median_release_seconds
       FROM t`,
    [from, to, currency],
  );
  const n = (v: unknown) => Number(v ?? 0);
  return {
    currency,
    promoCents: Math.max(0, n(c.promo_cents) - n(c.promo_returned_cents)),
    promoGrossCents: n(c.promo_cents),
    referralCents: n(c.referral_cents),
    creatorCents: n(c.creator_cents),
    pspFeeCents: n(c.psp_fee_cents),
    payoutFeeCents: n(c.payout_fee_cents),
    buyerCreditOutstandingCents: n(c.buyer_credit_cents),
    withdrawalsPendingCents: n(c.withdrawals_pending_cents),
    withdrawalsPending: c.withdrawals_pending,
    medianReleaseHours: c.median_release_seconds == null ? null : Math.round((Number(c.median_release_seconds) / 3600) * 10) / 10,
  };
}

export async function moneyCosts(q: Queryable, from: string, to: string, settlement = 'USD') {
  const main = await moneyCostsIn(q, from, to, settlement);
  const others = await many<{ currency: string }>(q, `SELECT DISTINCT currency FROM ledger_accounts WHERE currency <> $1 ORDER BY currency`, [settlement]);
  const byCurrency: Record<string, Awaited<ReturnType<typeof moneyCostsIn>>> = {};
  for (const { currency } of others) byCurrency[currency] = await moneyCostsIn(q, from, to, currency);
  return { ...main, byCurrency };
}

export async function businessMetrics(q: Queryable, days: Period, now = new Date()) {
  const bucket = bucketOf(days);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end.getTime() - days * 86_400_000);
  const prevStart = new Date(start.getTime() - days * 86_400_000);
  const [from, to, prevFrom] = [start, end, prevStart].map((d) => d.toISOString()) as [string, string, string];

  const series = await many<any>(
    q,
    `WITH buckets AS (
       SELECT generate_series(date_trunc('${bucket}', $1::timestamptz AT TIME ZONE 'UTC'), $2::timestamptz AT TIME ZONE 'UTC' - interval '1 second', interval '1 ${bucket}') AS b
     ), paid AS (
       SELECT o.*, date_trunc('${bucket}', o.paid_at AT TIME ZONE 'UTC') AS b,
              EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id) AS disputed,
              EXISTS (SELECT 1 FROM chargebacks c WHERE c.order_id = o.id) AS charged_back
         FROM orders o WHERE o.paid_at >= $1 AND o.paid_at < $2
     )
     SELECT to_char(b.b, 'YYYY-MM-DD') AS date,
            count(p.id)::int AS orders,
            COALESCE(sum(p.amount_cents), 0)::bigint AS gmv_cents,
            COALESCE(sum(p.commission_cents) FILTER (WHERE p.status NOT IN ('refunded', 'charged_back')), 0)::bigint AS take_cents,
            count(*) FILTER (WHERE p.disputed)::int AS disputes,
            count(*) FILTER (WHERE p.charged_back)::int AS chargebacks,
            count(*) FILTER (WHERE p.rail = 'fiat')::int AS card_orders
       FROM buckets b LEFT JOIN paid p ON p.b = b.b
      GROUP BY b.b ORDER BY b.b`,
    [from, to],
  );
  const categories = await many<any>(
    q,
    `SELECT f.category_slug, count(*)::int AS orders, sum(o.amount_cents)::bigint AS gmv_cents,
            COALESCE(sum(o.commission_cents) FILTER (WHERE o.status NOT IN ('refunded', 'charged_back')), 0)::bigint AS take_cents,
            count(d.id)::int AS disputes
       FROM orders o JOIN offers f ON f.id = o.offer_id LEFT JOIN disputes d ON d.order_id = o.id
      WHERE o.paid_at >= $1 AND o.paid_at < $2 GROUP BY f.category_slug ORDER BY gmv_cents DESC`,
    [from, to],
  );
  const games = await many<any>(
    q,
    `SELECT f.game, count(*)::int AS orders, sum(o.amount_cents)::bigint AS gmv_cents
       FROM orders o JOIN offers f ON f.id = o.offer_id
      WHERE o.paid_at >= $1 AND o.paid_at < $2 GROUP BY f.game ORDER BY gmv_cents DESC LIMIT 10`,
    [from, to],
  );
  const [current, previous, money] = await Promise.all([businessTotals(q, from, to), businessTotals(q, prevFrom, from), moneyCosts(q, from, to)]);
  return {
    days,
    bucket,
    from,
    to,
    totals: current,
    previous,
    money,
    series: series.map((s) => ({
      date: s.date,
      orders: s.orders,
      gmv_cents: Number(s.gmv_cents),
      take_cents: Number(s.take_cents),
      take_rate_pct: pct(Number(s.take_cents), Number(s.gmv_cents)),
      dispute_rate_pct: pct(s.disputes, s.orders),
      chargeback_rate_pct: pct(s.chargebacks, s.card_orders),
    })),
    categories: categories.map((c) => ({ ...c, gmv_cents: Number(c.gmv_cents), take_cents: Number(c.take_cents), take_rate_pct: pct(Number(c.take_cents), Number(c.gmv_cents)), dispute_rate_pct: pct(c.disputes, c.orders) })),
    games: games.map((g) => ({ ...g, gmv_cents: Number(g.gmv_cents) })),
  };
}
