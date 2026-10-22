import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { cleanAttributes } from './attributeSets.js';
import { notify } from './notifications.js';
import { searchOffers, type SearchParams } from './search.js';

/**
 * Saved searches with digests: "tell me about new listings like this". The worker checks each
 * search hourly or daily for listings posted since its last check and sends one notification
 * with how many there are and the cheapest few. Nothing is sent when there's nothing new.
 */
export const MAX_SAVED_SEARCHES = 20;
export const DIGEST_TOP = 3;

export interface SavedSearchParams {
  q?: string;
  game?: string;
  category?: string;
  maxPriceCents?: number;
  delivery?: 'instant' | 'manual';
  ownerVerified?: boolean;
  minRating?: number;
  attributes?: Record<string, string>;
}

/** Keep only the filters that make sense to save, and check game fields against the game. */
function clean(p: SavedSearchParams): SavedSearchParams {
  const out: SavedSearchParams = {};
  if (p.q?.trim()) out.q = p.q.trim().slice(0, 100);
  if (p.game?.trim()) out.game = p.game.trim().slice(0, 80);
  if (p.category) out.category = p.category;
  if (p.maxPriceCents != null) out.maxPriceCents = p.maxPriceCents;
  if (p.delivery) out.delivery = p.delivery;
  if (p.ownerVerified) out.ownerVerified = true;
  if (p.minRating) out.minRating = p.minRating;
  if (p.attributes && Object.keys(p.attributes).length) {
    if (!out.game || !out.category) throw badRequest('invalid_search', 'Game fields need a game and a category');
    const a = cleanAttributes(out.game, out.category, p.attributes, { partial: true });
    if (!a.ok) throw badRequest('invalid_search', a.error);
    out.attributes = a.value;
  }
  if (!out.q && !out.game && !out.category) throw badRequest('invalid_search', 'Save a search with at least a game, a category or search words');
  return out;
}

/** The market page link for these filters (web app routes). */
export function searchPath(p: SavedSearchParams) {
  const qs = new URLSearchParams();
  if (p.q) qs.set('q', p.q);
  if (p.game) qs.set('game', p.game);
  if (p.category) qs.set('category', p.category);
  if (p.maxPriceCents != null) qs.set('maxPrice', String(p.maxPriceCents));
  if (p.delivery) qs.set('delivery', p.delivery);
  if (p.ownerVerified) qs.set('ownerVerified', 'true');
  if (p.minRating) qs.set('minRating', String(p.minRating));
  for (const [k, v] of Object.entries(p.attributes ?? {})) qs.set(`attr.${k}`, v);
  qs.set('sort', 'newest');
  return `/market?${qs}`;
}

const toSearch = (p: SavedSearchParams): SearchParams => ({ ...p, sort: 'price_asc', pageSize: DIGEST_TOP });

export async function listSavedSearches(q: Queryable, userId: string) {
  const rows = await many<any>(q, 'SELECT id, name, params, frequency, last_checked_at, last_sent_at, created_at FROM saved_searches WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows.map((r) => ({ ...r, path: searchPath(r.params) }));
}

export async function createSavedSearch(ctx: Ctx, userId: string, input: { name: string; params: SavedSearchParams; frequency?: 'hourly' | 'daily' }) {
  const params = clean(input.params);
  return withTx(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { n } = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM saved_searches WHERE user_id = $1', [userId]);
    if (n >= MAX_SAVED_SEARCHES) throw badRequest('too_many_searches', `You can save up to ${MAX_SAVED_SEARCHES} searches`);
    const row = await one<{ id: string }>(
      tx,
      'INSERT INTO saved_searches (user_id, name, params, frequency) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, input.name.trim(), JSON.stringify(params), input.frequency ?? 'daily'],
    );
    return (await listSavedSearches(tx, userId)).find((s) => s.id === row.id);
  });
}

export async function updateSavedSearch(q: Queryable, userId: string, id: string, patch: { frequency?: 'hourly' | 'daily'; name?: string }) {
  const r = await q.query('UPDATE saved_searches SET frequency = COALESCE($3, frequency), name = COALESCE($4, name) WHERE id = $1 AND user_id = $2', [id, userId, patch.frequency ?? null, patch.name?.trim() ?? null]);
  if (!r.rowCount) throw notFound('Saved search');
  return (await listSavedSearches(q, userId)).find((s) => s.id === id);
}

export async function deleteSavedSearch(q: Queryable, userId: string, id: string) {
  const r = await q.query('DELETE FROM saved_searches WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rowCount) throw notFound('Saved search');
}

/** Worker: send digests for searches that are due. Returns how many digests went out. */
export async function sendDigests(ctx: Ctx, limit = 500): Promise<number> {
  const due = await many<any>(
    ctx.db,
    `SELECT s.* FROM saved_searches s JOIN users u ON u.id = s.user_id
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND s.last_checked_at < now() - CASE s.frequency WHEN 'hourly' THEN interval '1 hour' ELSE interval '1 day' END
      ORDER BY s.last_checked_at LIMIT $1`,
    [limit],
  );
  let sent = 0;
  for (const s of due) {
    const checkedAt = new Date();
    const res = await searchOffers(ctx.dbRead, { ...toSearch(s.params), createdAfter: s.last_checked_at });
    // Don't tell people about their own listings.
    const items = (res.items as any[]).filter((o) => o.seller_id !== s.user_id);
    await withTx(ctx.db, async (tx) => {
      if (res.total > 0 && items.length) {
        await notify(tx, s.user_id, 'saved_search_digest', {
          search_id: s.id, name: s.name, count: res.total, path: searchPath(s.params),
          top: items.map((o) => ({ title: o.title, price_cents: Number(o.price_cents), currency: o.currency, offer_id: o.id })),
        }, `saved:${s.id}:${checkedAt.toISOString()}`);
        await tx.query('UPDATE saved_searches SET last_sent_at = now() WHERE id = $1', [s.id]);
        sent++;
      }
      await tx.query('UPDATE saved_searches SET last_checked_at = $2 WHERE id = $1', [s.id, checkedAt]);
    });
  }
  return sent;
}

let lastRun = 0;
export async function maybeSendDigests(ctx: Ctx) {
  if (Date.now() - lastRun < 10 * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727296) AS l')).l);
  if (!locked) return null;
  return sendDigests(ctx);
}

export async function getSavedSearch(q: Queryable, userId: string, id: string) {
  const r = await maybeOne(q, 'SELECT * FROM saved_searches WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r) throw notFound('Saved search');
  return r;
}
