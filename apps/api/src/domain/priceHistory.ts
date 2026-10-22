import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one, withTx } from '../db.js';

export const MAX_HISTORY_DAYS = 365;

/**
 * A listing's price over the last `days` days, as recorded on every change (migration 045). The
 * last change before the window is included, moved to the window's start, so the line begins at
 * the left edge with the price that was in force then.
 */
export async function offerPriceHistory(q: Queryable, offerId: string, days: number) {
  const rows = await many<{ at: string; price_cents: number; currency: string }>(
    q,
    `(SELECT greatest(at, now() - make_interval(days => $2::int)) AS at, price_cents, currency FROM offer_prices
       WHERE offer_id = $1 AND at <= now() - make_interval(days => $2::int) ORDER BY at DESC LIMIT 1)
     UNION ALL
     (SELECT at, price_cents, currency FROM offer_prices WHERE offer_id = $1 AND at > now() - make_interval(days => $2::int))
     ORDER BY at`,
    [offerId, days],
  );
  return { currency: rows.at(-1)?.currency ?? null, points: rows.map(({ at, price_cents }) => ({ at, price_cents })) };
}

/** Lowest and median live price per day for one game and category, in the settlement currency. */
export async function marketPriceHistory(ctx: Ctx, q: Queryable, game: string, category: string, days: number) {
  const points = await many<{ day: string; min_cents: number; median_cents: number; listings: number }>(
    q,
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, min_cents, median_cents, listings FROM market_prices_daily
      WHERE lower(game) = lower($1) AND category_slug = $2 AND day > current_date - $3::int ORDER BY day`,
    [game, category, days],
  );
  return { currency: ctx.cfg.SETTLEMENT_CURRENCY, points };
}

/** Today's row for every game and category with live listings (re-run during the day, it updates). */
export async function snapshotMarketPrices(ctx: Ctx) {
  const res = await ctx.db.query(
    `INSERT INTO market_prices_daily (game, category_slug, day, min_cents, median_cents, listings)
     SELECT f.game, f.category_slug, current_date, min(f.price_settlement_cents),
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY f.price_settlement_cents))::bigint, count(*)::int
       FROM offers f JOIN users u ON u.id = f.seller_id
      WHERE f.status = 'active' AND f.reserved_for IS NULL AND f.available > 0 AND u.status = 'active' AND u.deleted_at IS NULL
        AND NOT (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now()))
      GROUP BY f.game, f.category_slug
     ON CONFLICT (game, category_slug, day) DO UPDATE
       SET min_cents = EXCLUDED.min_cents, median_cents = EXCLUDED.median_cents, listings = EXCLUDED.listings`,
  );
  return res.rowCount ?? 0;
}

let lastRun = 0;
/** Worker job: hourly, on one worker. */
export async function maybeSnapshotMarketPrices(ctx: Ctx) {
  if (Date.now() - lastRun < 60 * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727298) AS l')).l);
  if (!locked) return null;
  return snapshotMarketPrices(ctx);
}
