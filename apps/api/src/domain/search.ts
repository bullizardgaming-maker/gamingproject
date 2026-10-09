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
  /** Exact (case-insensitive) matches on game-specific fields, e.g. {server: 'EUW', rank: 'Gold'}. */
  attributes?: Record<string, string>;
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
 *  - Game-specific fields (server, region, rank…): exact filters, and per-value counts when a
 *    game is chosen. Each field's counts ignore that field's own filter so a picker can show
 *    what switching to another value would give.
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
    where.push(`(f.search @@ websearch_to_tsquery('simple', ${t}) OR lower(${t}) <% lower(f.game) OR lower(${t}) <% lower(f.title) OR f.title ILIKE '%' || ${arg(text.replace(/[\\%_]/g, '\\$&'))} || '%')`); // wildcards in the query are literal
    rank = `ts_rank(f.search, websearch_to_tsquery('simple', ${t})) + word_similarity(lower(${t}), lower(f.game))`;
  }
  if (p.game) where.push(`lower(f.game) = lower(${arg(p.game)})`);
  if (p.minPriceCents != null) where.push(`f.price_settlement_cents >= ${arg(p.minPriceCents)}`);
  if (p.maxPriceCents != null) where.push(`f.price_settlement_cents <= ${arg(p.maxPriceCents)}`);
  if (p.delivery) where.push(`f.delivery_mode = ${arg(p.delivery === 'instant' ? 'auto' : 'manual')}`);
  if (p.ownerVerified) where.push(`f.owner_proof_status = 'verified'`);
  if (p.sellerId) where.push(`f.seller_id = ${arg(p.sellerId)}`);
  const attrs = Object.entries(p.attributes ?? {});

  // Filters on computed columns apply to the wrapped query.
  const outer: string[] = [];
  if (p.inStock !== false) outer.push('stock > 0');
  if (p.minRating) outer.push(`seller_rating >= ${arg(p.minRating)}`);

  const select = OFFER_LIST_SQL.replace('SELECT f.id,', `SELECT ${rank} AS rank, f.id,`);
  // Attribute filters are kept apart so the facet queries can relax them one field at a time.
  const attrWhere = attrs.map(([k, v]) => ({ key: k, sql: `lower(f.attributes->>${arg(k)}) = lower(${arg(v)})` }));
  const base = `${select} WHERE ${[...where, ...attrWhere.map((a) => a.sql)].join(' AND ')}`;
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

  // Per-field value counts for one game, within the chosen category. Each field ignores its own
  // filter (but keeps the others), so a picker shows what every option would return.
  const attributeFacets = async () => {
    if (!p.game) return [];
    const keys = new Set<string>([...attrs.map(([k]) => k), '*']);
    const out: Array<{ key: string; value: string; count: number }> = [];
    for (const key of keys) {
      const ps = [...params];
      // The skipped filter stays in the SQL as a no-op so every placeholder is still used (Postgres
      // can't type an unused one) and the numbering holds.
      const conds = [...where, ...attrWhere.map((a) => (a.key === key ? `(${a.sql} OR true)` : a.sql))];
      const cat = p.category ? ` AND category_slug = $${ps.push(p.category)}` : '';
      const field = key === '*' ? '' : ` AND kv.key = $${ps.push(key)}`;
      const rowsF = await many<{ key: string; value: string; count: number }>(
        q,
        `WITH base AS (${select} WHERE ${conds.join(' AND ')})
         SELECT kv.key, kv.value, count(*)::int AS count FROM base, jsonb_each_text(base.attributes) kv
          WHERE true ${outer.length ? `AND ${outer.join(' AND ')}` : ''}${cat}${field}
          GROUP BY kv.key, kv.value ORDER BY kv.key, count DESC, kv.value LIMIT 300`,
        ps,
      );
      // The unfiltered pass supplies every field except the filtered ones, which get their own pass.
      out.push(...(key === '*' ? rowsF.filter((r) => !attrs.some(([k]) => k === r.key)) : rowsF));
    }
    return out;
  };

  const [rows, count, facets, attributes] = await Promise.all([
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
    attributeFacets(),
  ]);
  const total = count[0]?.n ?? 0;
  return {
    items: rows.map(({ rank: _r, ...r }) => r),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
    sort,
    facets: { categories: facets, attributes },
  };
}

/**
 * The game directory: every game with live listings, its listing and seller counts, the cheapest
 * price (settlement currency) and how many listings it has in each category. Powers the A–Z index
 * and the per-game category tabs.
 */
export async function gameDirectory(q: Queryable) {
  return many<{ game: string; offers: number; sellers: number; min_price_cents: number; instant: number; categories: Array<{ slug: string; count: number }> }>(
    q,
    `WITH live AS (
       SELECT f.game, f.category_slug, f.seller_id, f.price_settlement_cents, f.delivery_mode
         FROM offers f JOIN users u ON u.id = f.seller_id
        WHERE f.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL
          AND NOT (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now()))
          AND (CASE WHEN f.delivery_mode = 'auto'
                    THEN EXISTS (SELECT 1 FROM inventory_items i WHERE i.offer_id = f.id AND i.status = 'available')
                    ELSE f.stock > 0 END)
     ), per_cat AS (
       SELECT game, category_slug, count(*)::int AS n FROM live GROUP BY game, category_slug
     )
     SELECT l.game, count(*)::int AS offers, count(DISTINCT l.seller_id)::int AS sellers,
            min(l.price_settlement_cents)::bigint AS min_price_cents,
            count(*) FILTER (WHERE l.delivery_mode = 'auto')::int AS instant,
            (SELECT json_agg(json_build_object('slug', c.category_slug, 'count', c.n) ORDER BY c.n DESC)
               FROM per_cat c WHERE c.game = l.game) AS categories
       FROM live l GROUP BY l.game ORDER BY lower(l.game)`,
  ).then((rows) => rows.map((r) => ({ ...r, min_price_cents: Number(r.min_price_cents) })));
}

/** Game-name autocomplete with typo tolerance. */
export async function suggestGames(q: Queryable, prefix: string, limit = 8) {
  return many<{ game: string; offers: number }>(
    q,
    `SELECT f.game, count(*)::int AS offers FROM offers f
      WHERE f.status = 'active' AND (lower(f.game) LIKE lower($3) || '%' OR lower($1) <% lower(f.game))
      GROUP BY f.game ORDER BY max(word_similarity(lower($1), lower(f.game))) DESC, offers DESC LIMIT $2`,
    [prefix, Math.min(limit, 20), prefix.replace(/[\\%_]/g, '\\$&')],
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
