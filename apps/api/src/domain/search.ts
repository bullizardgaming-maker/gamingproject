import type { Queryable } from '../db.js';
import { many } from '../db.js';
import { OFFER_LIST_SQL } from './offers.js';

export const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'rating', 'best_selling'] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchParams {
  q?: string;
  category?: string;
  game?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  delivery?: 'instant' | 'manual';
  ownerVerified?: boolean;
  minRating?: number;
  inStock?: boolean;
  sellerId?: string;
  sort?: Sort;
  page?: number;
  pageSize?: number;
}

/**
 * Market search.
 *  - Text: weighted full-text search (title > game > description) plus trigram
 *    similarity on the game name, so "elden rin" or "valornt" still match.
 *  - Filters: category, game, price range, instant delivery, verified-owner
 *    accounts, minimum seller rating, in stock, seller.
 *  - Sorts: relevance (default when searching), newest, price, rating, best-selling.
 *  - Page-based pagination with a total and per-category facet counts.
 * Stock and rating are computed per row; if listings grow past ~100k, move them
 * into counters maintained on write.
 */
export async function searchOffers(q: Queryable, p: SearchParams) {
  const params: unknown[] = [];
  const arg = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [
    `f.status = 'active'`,
    `u.status = 'active'`,
    `u.deleted_at IS NULL`,
    `NOT (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now()))`,
  ];
  const text = p.q?.trim();
  let rank = '0';
  if (text) {
    const t = arg(text);
    // word_similarity (<%) matches a typo'd or partial word inside a longer name: "eldn" -> "Elden Ring".
    where.push(`(f.search @@ websearch_to_tsquery('simple', ${t}) OR lower(${t}) <% lower(f.game) OR lower(${t}) <% lower(f.title) OR f.title ILIKE '%' || ${t} || '%')`);
    rank = `ts_rank(f.search, websearch_to_tsquery('simple', ${t})) + word_similarity(lower(${t}), lower(f.game))`;
  }
  if (p.game) where.push(`lower(f.game) = lower(${arg(p.game)})`);
  if (p.minPriceCents != null) where.push(`f.price_settlement_cents >= ${arg(p.minPriceCents)}`);
  if (p.maxPriceCents != null) where.push(`f.price_settlement_cents <= ${arg(p.maxPriceCents)}`);
  if (p.delivery) where.push(`f.delivery_mode = ${arg(p.delivery === 'instant' ? 'auto' : 'manual')}`);
  if (p.ownerVerified) where.push(`f.owner_proof_status = 'verified'`);
  if (p.sellerId) where.push(`f.seller_id = ${arg(p.sellerId)}`);

  // Filters on computed columns apply to the wrapped query.
  const outer: string[] = [];
  if (p.inStock !== false) outer.push('stock > 0');
  if (p.minRating) outer.push(`seller_rating >= ${arg(p.minRating)}`);

  const base = `${OFFER_LIST_SQL.replace('SELECT f.id,', `SELECT ${rank} AS rank, f.id,`)} WHERE ${where.join(' AND ')}`;
  const baseParams = [...params]; // everything up to here: shared by results, count and facets

  const sort: Sort = p.sort ?? (text ? 'relevance' : 'newest');
  const order = {
    relevance: 'rank DESC, created_at DESC',
    newest: 'created_at DESC',
    price_asc: 'price_settlement_cents ASC, created_at DESC',
    price_desc: 'price_settlement_cents DESC, created_at DESC',
    rating: 'seller_rating DESC NULLS LAST, seller_review_count DESC, created_at DESC',
    best_selling: 'seller_completed_orders DESC, created_at DESC',
  }[sort];
  const pageSize = Math.min(Math.max(p.pageSize ?? 24, 1), 60);
  const page = Math.max(p.page ?? 1, 1);

  // Results & total honour the category filter; facets don't, so every category tab can show its count.
  const filtered = [...outer];
  const listParams = [...baseParams];
  if (p.category) {
    listParams.push(p.category);
    filtered.push(`category_slug = $${listParams.length}`);
  }
  const filteredWhere = filtered.length ? `WHERE ${filtered.join(' AND ')}` : '';
  const facetWhere = outer.length ? `WHERE ${outer.join(' AND ')}` : '';

  const [rows, count, facets] = await Promise.all([
    many(
      q,
      `WITH base AS (${base}) SELECT * FROM base ${filteredWhere}
        ORDER BY ${order}, id LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
      [...listParams, pageSize, (page - 1) * pageSize],
    ),
    many<{ n: number }>(q, `WITH base AS (${base}) SELECT count(*)::int AS n FROM base ${filteredWhere}`, listParams),
    many<{ category_slug: string; count: number }>(
      q,
      `WITH base AS (${base}) SELECT category_slug, count(*)::int AS count FROM base ${facetWhere} GROUP BY category_slug ORDER BY count DESC`,
      baseParams,
    ),
  ]);
  const total = count[0]?.n ?? 0;
  return {
    items: rows.map(({ rank: _r, ...r }) => r),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
    sort,
    facets: { categories: facets },
  };
}

/** Game-name autocomplete with typo tolerance. */
export async function suggestGames(q: Queryable, prefix: string, limit = 8) {
  return many<{ game: string; offers: number }>(
    q,
    `SELECT f.game, count(*)::int AS offers FROM offers f
      WHERE f.status = 'active' AND (lower(f.game) LIKE lower($1) || '%' OR lower($1) <% lower(f.game))
      GROUP BY f.game ORDER BY max(word_similarity(lower($1), lower(f.game))) DESC, offers DESC LIMIT $2`,
    [prefix, Math.min(limit, 20)],
  );
}

/** Adds display_price_cents/display_currency to each listing, converting via the settlement price. */
export async function withDisplayPrices<T extends { items: any[] }>(ctx: import('../context.js').Ctx, res: T, currency: string): Promise<T> {
  const { getRate } = await import('./fx.js');
  const rate = await getRate(ctx, ctx.db, currency);
  for (const it of res.items) {
    it.display_currency = currency;
    it.display_price_cents = it.currency === currency ? it.price_cents : Math.round(Number(it.price_settlement_cents) * rate);
  }
  return res;
}
