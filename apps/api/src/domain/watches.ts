import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanAttributes } from './attributeSets.js';
import { getRate } from './fx.js';
import { notify } from './notifications.js';
import { OFFER_LIST_SQL } from './offers.js';
import { searchOffers } from './search.js';

/**
 * Watchlists and price alerts.
 *  - Offer watch: alert when the listing's price reaches the target (or drops below the price when
 *    the buyer started watching), and when a sold-out listing is back in stock.
 *  - Game watch: alert when the cheapest live listing for a game (optionally one category and
 *    game-specific fields, e.g. LoL boosting on EUW) reaches the target or a new low.
 * Each new low notifies once; a later, lower price notifies again.
 */
export const MAX_WATCHES = 100;

export interface WatchInput {
  offerId?: string;
  game?: string;
  category?: string;
  attributes?: Record<string, string>;
  targetCents?: number | null;
  currency?: string;
}

async function liveOffer(q: Queryable, offerId: string) {
  return maybeOne<any>(q, `${OFFER_LIST_SQL} WHERE f.id = $1`, [offerId]);
}

/** Cheapest live listing for a game watch, or null. */
async function cheapest(q: Queryable, w: { game: string; category_slug: string | null; attributes: Record<string, string> }) {
  const res = await searchOffers(q, { game: w.game, category: w.category_slug ?? undefined, attributes: w.attributes, sort: 'price_asc', pageSize: 1 });
  return (res.items[0] as any) ?? null;
}

export async function createWatch(ctx: Ctx, userId: string, input: WatchInput) {
  const currency = (input.currency ?? ctx.cfg.SETTLEMENT_CURRENCY).toUpperCase();
  await getRate(ctx, ctx.db, currency); // rejects unknown currencies
  const { n } = await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM watches WHERE user_id = $1', [userId]);
  if (n >= MAX_WATCHES) throw badRequest('too_many_watches', `You can watch up to ${MAX_WATCHES} listings and games`);

  if (input.offerId) {
    const o = await liveOffer(ctx.db, input.offerId);
    if (!o || o.status === 'removed') throw notFound('Offer');
    if (o.seller_id === userId) throw badRequest('own_offer', 'You can’t watch your own listing');
    const row = await maybeOne(
      ctx.db,
      `INSERT INTO watches (user_id, kind, offer_id, target_cents, currency, baseline_price_cents, last_in_stock)
       VALUES ($1, 'offer', $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, o.id, input.targetCents ?? null, currency, o.price_settlement_cents, o.status === 'active' && o.stock > 0],
    );
    if (!row) throw conflict('already_watching', 'You’re already watching this listing');
    return getWatch(ctx, userId, row.id);
  }

  if (!input.game?.trim()) throw badRequest('invalid_watch', 'Give an offer or a game to watch');
  const game = input.game.trim();
  let attributes: Record<string, string> = {};
  if (input.category) {
    if (!(await maybeOne(ctx.db, 'SELECT 1 FROM categories WHERE slug = $1', [input.category]))) throw badRequest('unknown_category', 'Unknown category');
    // Only check the values are valid; a watch needn't name every required field.
    const relaxed = cleanAttributes(game, input.category, input.attributes);
    if (!relaxed.ok && !relaxed.error.includes('is required')) throw badRequest('invalid_attributes', relaxed.error);
    attributes = Object.fromEntries(Object.entries(input.attributes ?? {}).filter(([, v]) => v));
    if (relaxed.ok) attributes = relaxed.value;
  } else if (input.attributes && Object.keys(input.attributes).length) {
    throw badRequest('invalid_watch', 'Pick a category to watch specific fields');
  }
  const low = await cheapest(ctx.db, { game, category_slug: input.category ?? null, attributes });
  const row = await maybeOne(
    ctx.db,
    `INSERT INTO watches (user_id, kind, game, category_slug, attributes, target_cents, currency, baseline_price_cents)
     VALUES ($1, 'game', $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
    [userId, low?.game ?? game, input.category ?? null, JSON.stringify(attributes), input.targetCents ?? null, currency, low?.price_settlement_cents ?? null],
  );
  if (!row) throw conflict('already_watching', 'You’re already watching this');
  return getWatch(ctx, userId, row.id);
}

/** A watch with what it currently points at, prices in the watch's currency. */
async function view(ctx: Ctx, w: any) {
  const rate = await getRate(ctx, ctx.db, w.currency);
  const conv = (c: number | null | undefined) => (c == null ? null : Math.round(Number(c) * rate));
  const target = w.target_cents == null ? null : Number(w.target_cents);
  if (w.kind === 'offer') {
    const o = await liveOffer(ctx.db, w.offer_id);
    const live = !!o && o.status === 'active' && !o.shop_paused;
    return {
      id: w.id, kind: 'offer', currency: w.currency, targetCents: target, createdAt: w.created_at,
      offer: o ? { id: o.id, title: o.title, game: o.game, category_slug: o.category_slug, seller_name: o.seller_name, attributes: o.attributes } : null,
      currentCents: o ? conv(o.price_settlement_cents) : null,
      startCents: conv(w.baseline_price_cents),
      available: live && o.stock > 0,
      reached: live && o.stock > 0 && target != null && conv(o.price_settlement_cents)! <= target,
    };
  }
  const low = await cheapest(ctx.db, w);
  return {
    id: w.id, kind: 'game', currency: w.currency, targetCents: target, createdAt: w.created_at,
    game: w.game, category: w.category_slug, attributes: w.attributes,
    cheapest: low ? { id: low.id, title: low.title, seller_name: low.seller_name } : null,
    currentCents: low ? conv(low.price_settlement_cents) : null,
    startCents: conv(w.baseline_price_cents),
    available: !!low,
    reached: !!low && target != null && conv(low.price_settlement_cents)! <= target,
  };
}

export async function getWatch(ctx: Ctx, userId: string, id: string) {
  const w = await maybeOne(ctx.db, 'SELECT * FROM watches WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!w) throw notFound('Watch');
  return view(ctx, w);
}

export async function listWatches(ctx: Ctx, userId: string) {
  const rows = await many(ctx.db, 'SELECT * FROM watches WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  const out = [];
  for (const w of rows) out.push(await view(ctx, w));
  return out;
}

export async function updateWatch(ctx: Ctx, userId: string, id: string, patch: { targetCents: number | null; currency?: string }) {
  if (patch.currency) await getRate(ctx, ctx.db, patch.currency.toUpperCase());
  // A new target re-arms the alert.
  const res = await ctx.db.query(
    `UPDATE watches SET target_cents = $3, currency = COALESCE($4, currency), last_notified_cents = NULL WHERE id = $1 AND user_id = $2`,
    [id, userId, patch.targetCents, patch.currency?.toUpperCase() ?? null],
  );
  if (!res.rowCount) throw notFound('Watch');
  return getWatch(ctx, userId, id);
}

export async function deleteWatch(ctx: Ctx, userId: string, id: string) {
  const res = await ctx.db.query('DELETE FROM watches WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!res.rowCount) throw notFound('Watch');
}

/** Compare every watch with the market and notify on a new low or a restock. */
export async function checkWatches(ctx: Ctx, batch = 500) {
  const rows = await many<any>(ctx.db, 'SELECT * FROM watches ORDER BY last_checked_at NULLS FIRST LIMIT $1', [batch]);
  let sent = 0;
  for (const w of rows) {
    const rate = await getRate(ctx, ctx.db, w.currency);
    // Threshold in settlement currency: the target; else anything below the starting price; else
    // (a game with nothing listed when the watch began) any listing at all.
    const threshold =
      w.target_cents != null ? Math.floor(Number(w.target_cents) / rate) : w.baseline_price_cents != null ? Number(w.baseline_price_cents) - 1 : Number.MAX_SAFE_INTEGER;
    const display = (c: number) => Math.round(c * rate);
    await withTx(ctx.db, async (tx) => {
      if (w.kind === 'offer') {
        const o = await liveOffer(tx, w.offer_id);
        const inStock = !!o && o.status === 'active' && !o.shop_paused && o.stock > 0;
        const price = o ? Number(o.price_settlement_cents) : null;
        if (inStock && w.last_in_stock === false) {
          await notify(tx, w.user_id, 'watch_back_in_stock', { title: o.title, offer_id: o.id, price_cents: display(price!), currency: w.currency }, `watch:${w.id}:restock:${new Date().toISOString().slice(0, 13)}`);
          sent++;
        }
        if (inStock && price! <= threshold && (w.last_notified_cents == null || price! < Number(w.last_notified_cents))) {
          await notify(tx, w.user_id, 'watch_price_drop', { title: o.title, offer_id: o.id, price_cents: display(price!), target_cents: w.target_cents, currency: w.currency }, `watch:${w.id}:${price}`);
          await tx.query('UPDATE watches SET last_notified_cents = $2 WHERE id = $1', [w.id, price]);
          sent++;
        }
        await tx.query('UPDATE watches SET last_in_stock = $2, last_checked_at = now() WHERE id = $1', [w.id, inStock]);
        return;
      }
      const low = await cheapest(tx, w);
      const price = low ? Number(low.price_settlement_cents) : null;
      if (low && price! <= threshold && (w.last_notified_cents == null || price! < Number(w.last_notified_cents))) {
        await notify(
          tx, w.user_id, 'watch_game_low',
          { game: low.game, category: w.category_slug, attributes: w.attributes, title: low.title, offer_id: low.id, price_cents: display(price!), target_cents: w.target_cents, currency: w.currency },
          `watch:${w.id}:${price}`,
        );
        await tx.query('UPDATE watches SET last_notified_cents = $2 WHERE id = $1', [w.id, price]);
        sent++;
      }
      // The first listing seen sets the baseline and the game's proper spelling.
      if (low && (w.baseline_price_cents == null || low.game !== w.game)) {
        await tx.query('UPDATE watches SET baseline_price_cents = COALESCE(baseline_price_cents, $2), game = $3 WHERE id = $1', [w.id, price, low.game]);
      }
      await tx.query('UPDATE watches SET last_checked_at = now() WHERE id = $1', [w.id]);
    });
  }
  return { checked: rows.length, sent };
}

let lastRun = 0;
export async function maybeCheckWatches(ctx: Ctx) {
  if (Date.now() - lastRun < ctx.cfg.WATCH_CHECK_MINUTES * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727293) AS l')).l);
  if (!locked) return null;
  return checkWatches(ctx);
}
