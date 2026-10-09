import type { Ctx } from '../context.js';
import { one, withTx } from '../db.js';

/**
 * Repairs the stored search counters (migration 044) wherever they drifted from the live
 * definitions: listing stock, and each seller's completed orders and rating. Triggers keep them
 * current; this catches anything a trigger can't see, such as a concurrent stock edit racing an
 * inventory upload. Returns how many rows were corrected.
 */
export async function repairCounters(ctx: Ctx) {
  return withTx(ctx.db, async (tx) => {
    // Plain listings first: bundles read their parts' counters when they're corrected.
    const plain = await tx.query(`UPDATE offers SET available = offer_available(id) WHERE NOT is_bundle AND status <> 'removed' AND available <> offer_available(id)`);
    const bundles = await tx.query(`UPDATE offers SET available = offer_available(id) WHERE is_bundle AND status <> 'removed' AND available <> offer_available(id)`);
    const sellers = await tx.query(
      `UPDATE users u SET completed_orders = s.completed, rating_avg = s.avg, review_count = s.reviews
         FROM (SELECT u2.id,
                      (SELECT count(*)::int FROM orders o WHERE o.seller_id = u2.id AND o.status = 'completed') AS completed,
                      (SELECT round(avg(rating)::numeric, 2) FROM reviews r WHERE r.seller_id = u2.id AND NOT r.hidden) AS avg,
                      (SELECT count(*)::int FROM reviews r WHERE r.seller_id = u2.id AND NOT r.hidden) AS reviews
                 FROM users u2 WHERE EXISTS (SELECT 1 FROM offers f WHERE f.seller_id = u2.id)) s
        WHERE u.id = s.id
          AND (u.completed_orders, u.rating_avg, u.review_count) IS DISTINCT FROM (s.completed, s.avg, s.reviews)`,
    );
    const fixed = { listings: (plain.rowCount ?? 0) + (bundles.rowCount ?? 0), sellers: sellers.rowCount ?? 0 };
    if (fixed.listings || fixed.sellers) ctx.log.warn({ fixed }, 'search counters drifted and were repaired');
    return fixed;
  });
}

let lastRun = 0;
/** Worker job: at most every 6 hours, on one worker. */
export async function maybeRepairCounters(ctx: Ctx) {
  if (Date.now() - lastRun < 6 * 60 * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727297) AS l')).l);
  if (!locked) return null;
  return repairCounters(ctx);
}
