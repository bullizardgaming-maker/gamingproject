import type { Queryable } from '../db.js';
import { many } from '../db.js';
import { OFFER_LIST_SQL } from './offers.js';
import { GROSS_SQL } from './commission.js';
import { ONLINE_SQL } from './presence.js';
import { attributesFor } from './attributeSets.js';
import { formatUnitPrice } from './unitPrice.js';

export const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'rating', 'best_selling', 'trust', 'recommended', 'min_qty_asc', 'delivery', 'most_sold', 'fastest_delivery'] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchParams {
  q?: string;
  category?: string;
  game?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  /** Round 25: unit price range in settlement micro-units (what the buyer pays per unit). */
  minUnitPriceMicros?: number;
  maxUnitPriceMicros?: number;
  delivery?: 'instant' | 'manual';
  /** Round 25: one of the listing's delivery methods (domain/delivery.ts). */
  deliveryMethod?: string;
  /** Round 25: promised delivery within this many minutes (instant delivery counts as 0). */
  maxDeliveryMinutes?: number;
  /** Round 25: the seller is online now. */
  sellerOnline?: boolean;
  /** Round 25: seller level at least this (level = 1 + ⌊2·√completed orders⌋). */
  minSellerLevel?: number;
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

/** Completed orders needed for a seller level: level = 1 + ⌊2·√n⌋ ≥ L ⇔ n ≥ ⌈(L−1)²/4⌉. */
export const ordersForLevel = (level: number) => Math.ceil(Math.max(0, level - 1) ** 2 / 4);

/** Listings any buyer may see in the market. */
const LIVE = [
  `f.status = 'active'`,
  `f.reserved_for IS NULL`,
  `category_open(f.category_slug)`,
  `u.status = 'active'`,
  `u.deleted_at IS NULL`,
  `NOT (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now()))`,
];

/** The promised delivery time in minutes; instant delivery is 0. */
export const DELIVERY_MINUTES_SQL = `(CASE WHEN f.delivery_mode = 'auto' THEN 0 ELSE f.delivery_minutes END)`;

/** Text search: weighted full text plus typo-tolerant matches on game and title. Wildcards in the query are literal. */
function textFilter(text: string, arg: (v: unknown) => string) {
  const t = arg(text);
  // word_similarity (<%) matches a typo'd or partial word inside a longer name: "eldn" -> "Elden Ring".
  return {
    where: `(f.search @@ websearch_to_tsquery('simple', ${t}) OR lower(${t}) <% lower(f.game) OR lower(${t}) <% lower(f.title) OR f.title ILIKE '%' || ${arg(text.replace(/[\\%_]/g, '\\$&'))} || '%')`,
    rank: `ts_rank(f.search, websearch_to_tsquery('simple', ${t})) + word_similarity(lower(${t}), lower(f.game))`,
  };
}

/**
 * Round 25b (L2): a game field filter, with the key as a literal so the expression indexes on
 * lower(attributes->>'server') / ('league') serve it. Keys are checked against ATTR_KEY before they reach SQL.
 */
const SAFE_KEY = /^[a-z][a-z_]{0,29}$/;
export function attrSql(key: string, arg: (v: unknown) => string, value: string) {
  if (!SAFE_KEY.test(key)) throw new Error(`bad attribute key ${key}`);
  return `lower(f.attributes->>'${key}') = lower(${arg(value)})`;
}

type Filter = 'game' | 'deliveryMethod' | 'category';
/**
 * The WHERE conditions of a market search (without text and game fields, which searchOffers adds). `skip` leaves out
 * one filter, so a facet can count what choosing another value of it would give.
 */
function filterSql(p: SearchParams, arg: (v: unknown) => string, skip?: Filter): string[] {
  const where = [...LIVE];
  if (p.game && skip !== 'game') where.push(`lower(f.game) = lower(${arg(p.game)})`);
  if (p.category && skip !== 'category') where.push(`f.category_slug = ${arg(p.category)}`);
  if (p.minPriceCents != null) where.push(`${GROSS_SQL('f.price_settlement_cents')} >= ${arg(p.minPriceCents)}`);
  if (p.maxPriceCents != null) where.push(`${GROSS_SQL('f.price_settlement_cents')} <= ${arg(p.maxPriceCents)}`);
  if (p.minUnitPriceMicros != null) where.push(`${GROSS_SQL('f.price_settlement_micros')} >= ${arg(p.minUnitPriceMicros)}`);
  if (p.maxUnitPriceMicros != null) where.push(`${GROSS_SQL('f.price_settlement_micros')} <= ${arg(p.maxUnitPriceMicros)}`);
  if (p.delivery) where.push(`f.delivery_mode = ${arg(p.delivery === 'instant' ? 'auto' : 'manual')}`);
  if (p.deliveryMethod && skip !== 'deliveryMethod') where.push(`f.delivery_methods @> ARRAY[${arg(p.deliveryMethod)}::text]`);
  if (p.maxDeliveryMinutes != null) where.push(`${DELIVERY_MINUTES_SQL} <= ${arg(p.maxDeliveryMinutes)}`);
  if (p.sellerOnline) where.push(ONLINE_SQL);
  if (p.minSellerLevel != null && p.minSellerLevel > 1) where.push(`u.completed_orders >= ${arg(ordersForLevel(p.minSellerLevel))}`);
  if (p.ownerVerified) where.push(`f.owner_proof_status = 'verified'`);
  if (p.sellerId) where.push(`f.seller_id = ${arg(p.sellerId)}`);
  if (p.inStock !== false) where.push('f.available > 0');
  if (p.minRating) where.push(`u.rating_avg >= ${arg(p.minRating)}`);
  return where;
}

/**
 * Market search.
 *  - Text: weighted full-text search (title > game > description) plus trigram
 *    similarity on the game name, so "elden rin" or "valornt" still match.
 *  - Filters: category, game, server/region (a game field), price range (listing or unit price), instant delivery,
 *    delivery method, max delivery time, seller online, seller level, verified-owner accounts, minimum seller rating,
 *    in stock, seller.
 *  - Sorts: recommended, price, most sold, fastest delivery, newest, relevance (default when searching), rating…
 *  - Featured listings lead only the seller's own shop (sellerId given), and only there carry `featured` (CEO,
 *    Round 25): no boost or badge in the market, on game or server pages, or anywhere else.
 *  - Game-specific fields (server, region, rank…): exact filters, and per-value counts when a
 *    game is chosen. Each field's counts ignore that field's own filter so a picker can show
 *    what switching to another value would give.
 *  - Page-based pagination with a total and per-category facet counts.
 * Stock, rating, completed orders and sales are stored counters kept by triggers (migrations 044, 079),
 * so their filters run in the base query and can use indexes.
 */
export async function searchOffers(q: Queryable, p: SearchParams) {
  const params: unknown[] = [];
  const arg = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = filterSql(p, arg, 'category');
  const text = p.q?.trim();
  let rank = '0';
  if (text) {
    const t = textFilter(text, arg);
    where.push(t.where);
    rank = t.rank;
  }
  const attrs = Object.entries(p.attributes ?? {});

  const outer: string[] = [];

  // The seller's own shop: featured listings are marked and pinned first (Round 25: nowhere else).
  const shop = !!p.sellerId;
  const select = OFFER_LIST_SQL.replace('SELECT f.id,', `SELECT ${rank} AS rank,${shop ? ' (f.featured_until IS NOT NULL AND f.featured_until > now()) AS featured,' : ''} f.id,`);
  // Attribute filters are kept apart so the facet queries can relax them one field at a time.
  const attrWhere = attrs.map(([k, v]) => ({ key: k, sql: attrSql(k, arg, v) }));
  const base = `${select} WHERE ${[...where, ...attrWhere.map((a) => a.sql)].join(' AND ')}`;
  const baseParams = [...params]; // everything up to here: shared by results, count and facets

  const sort: Sort = p.sort ?? (text ? 'relevance' : 'newest');
  const order0 = {
    relevance: 'rank DESC, created_at DESC',
    newest: 'created_at DESC',
    price_asc: 'price_settlement_micros ASC, created_at DESC',
    price_desc: 'price_settlement_micros DESC, created_at DESC',
    rating: 'seller_rating DESC NULLS LAST, seller_review_count DESC, created_at DESC',
    trust: "array_position(ARRAY['top','trusted','rising','new'], seller_trust_level), seller_rating DESC NULLS LAST, created_at DESC",
    best_selling: 'seller_completed_orders DESC, created_at DESC',
    most_sold: 'sold_count DESC, seller_completed_orders DESC, created_at DESC',
    // Game-page default: good ratings and low prices together (rating out of 5 against the unit price).
    recommended: '(COALESCE(seller_rating, 3.5) / 5.0) / GREATEST(price_settlement_micros, 1) DESC, sold_count DESC, seller_completed_orders DESC, created_at DESC',
    min_qty_asc: 'min_qty ASC, price_settlement_micros ASC, created_at DESC',
    delivery: "(delivery_mode = 'auto') DESC, delivery_minutes ASC, seller_online DESC, price_settlement_micros ASC",
    fastest_delivery: "(delivery_mode = 'auto') DESC, delivery_minutes ASC, seller_online DESC, price_settlement_micros ASC",
  }[sort];
  const order = shop ? `featured DESC, ${order0}` : order0;
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
       SELECT f.game, f.category_slug, f.seller_id, ${GROSS_SQL('f.price_settlement_cents')} AS price_settlement_cents, f.delivery_mode
         FROM offers f JOIN users u ON u.id = f.seller_id
        WHERE f.status = 'active' AND f.reserved_for IS NULL AND category_open(f.category_slug) AND u.status = 'active' AND u.deleted_at IS NULL
          AND NOT (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now()))
          AND f.available > 0
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
      WHERE f.status = 'active' AND f.reserved_for IS NULL AND category_open(f.category_slug) AND (lower(f.game) LIKE lower($3) || '%' OR lower($1) <% lower(f.game))
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
    // Round 25: currency listings' buyer unit price in the display currency, micro-units (rounded up).
    if (it.unit_price_micros != null) it.display_unit_price_micros = it.currency === currency ? Number(it.unit_price_micros) : Math.ceil(Number(it.price_settlement_micros) * rate);
  }
  return res;
}

/** Round 25: the field a buyer picks a currency listing by (server, region or league): the game's first listing field. */
export function serverFieldFor(game: string, category = 'currency') {
  return attributesFor(game, category)[0] ?? null;
}

/**
 * Round 25 (B4): counts for the market's filter panel, with the same filters as /offers. Each facet ignores its own
 * filter: games are counted across every game, servers across every server of the chosen game, delivery methods across
 * every method. `servers` needs a game (it is the game's first field: server, region or league).
 */
export async function searchFacets(q: Queryable, p: SearchParams & { server?: string }) {
  const build = (skip?: Filter | 'server') => {
    const params: unknown[] = [];
    const arg = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = filterSql(p, arg, skip === 'server' ? undefined : skip);
    // Round 25b (L3): the same text filter as the results.
    const text = p.q?.trim();
    if (text) where.push(textFilter(text, arg).where);
    for (const [k, v] of Object.entries(p.attributes ?? {})) {
      if (skip === 'server' && field && k === field.key) continue;
      where.push(attrSql(k, arg, v));
    }
    return { where: where.join(' AND '), params, arg };
  };
  const field = p.game ? serverFieldFor(p.game, p.category ?? 'currency') : null;
  const FROM = 'FROM offers f JOIN users u ON u.id = f.seller_id';
  const g = build('game');
  const m = build('deliveryMethod');
  const sv = field ? build('server') : null;
  const [games, methods, servers] = await Promise.all([
    many<{ game: string; count: number }>(q, `SELECT f.game, count(*)::int AS count ${FROM} WHERE ${g.where} GROUP BY f.game ORDER BY count DESC, f.game LIMIT 200`, g.params),
    many<{ method: string; count: number }>(q, `SELECT dm AS method, count(*)::int AS count ${FROM} CROSS JOIN LATERAL unnest(f.delivery_methods) dm WHERE ${m.where} GROUP BY dm ORDER BY count DESC, dm`, m.params),
    sv && field
      ? many<{ name: string; count: number }>(q, `SELECT f.attributes->>${sv.arg(field.key)} AS name, count(*)::int AS count ${FROM} WHERE ${sv.where} AND lower(f.attributes->>'${keyLiteral(field.key)}') IS NOT NULL GROUP BY 1 ORDER BY count DESC, 1`, sv.params)
      : Promise.resolve([]),
  ]);
  // A select field lists every option, with 0 where nothing is listed.
  let serverRows = servers;
  if (field?.type === 'select' && field.options) {
    const by = new Map(servers.map((r) => [r.name.toLowerCase(), r.count]));
    serverRows = field.options.map((o) => ({ name: o, count: by.get(o.toLowerCase()) ?? 0 }));
  }
  return { games, servers: field ? { key: field.key, label: field.label, values: serverRows } : null, delivery_methods: methods };
}

/** Lower-case slug of a game name, the same as the web app's slugify (lib/catalog.ts). */
export const gameSlug = (game: string) =>
  game
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const keyLiteral = (k: string) => {
  if (!SAFE_KEY.test(k)) throw new Error(`bad attribute key ${k}`);
  return k;
};

/** Round 25b (L2): the slug → game map, from games with their own fields and games with active listings; cached a minute. */
let slugCache: { at: number; map: Map<string, string> } | null = null;
export const GAME_SLUG_CACHE_MS = 60_000;
export function forgetGameSlugs() {
  slugCache = null;
}

/** The game a slug names: a game with its own listing fields, or one with listings. Null when none. */
export async function gameForSlug(q: Queryable, slug: string): Promise<string | null> {
  const find = () => slugCache!.map.get(slug) ?? null;
  if (slugCache && Date.now() - slugCache.at < GAME_SLUG_CACHE_MS) {
    const hit = find();
    if (hit) return hit;
  }
  const { GAME_SETS } = await import('./attributeSets.js');
  const rows = await many<{ game: string }>(q, `SELECT DISTINCT game FROM offers WHERE status = 'active'`);
  const map = new Map<string, string>();
  for (const n of [...rows.map((r) => r.game), ...Object.keys(GAME_SETS)]) if (!map.has(gameSlug(n))) map.set(gameSlug(n), n);
  slugCache = { at: Date.now(), map };
  return find();
}

/**
 * Round 25 (B1): one row per server of a game for a category (default currency): active listings, up to four sellers
 * (most sales first), how many sellers, units sold and the lowest unit price buyers pay (settlement currency, micro-units
 * and as a decimal). Every server of the game's list is included (0 when it has none); a free-text field (Aion server,
 * WoW realm) lists the values sellers used. Active, in-stock, visible listings only; no page limit.
 */
export async function serverSummary(q: Queryable, game: string, category = 'currency') {
  const field = serverFieldFor(game, category);
  if (!field) return { game, category, key: null, label: null, servers: [] as ServerRow[] };
  const rows = await many<{ name: string; offers: number; sellers_count: number; sold: number; from_micros: string | null; sellers: Array<{ id: string; name: string; avatar: string | null }> }>(
    q,
    `WITH live AS (
       SELECT f.attributes->>$3 AS name, f.seller_id, f.sold_count, ${GROSS_SQL('f.price_settlement_micros')} AS micros, u.display_name, u.completed_orders
         FROM offers f JOIN users u ON u.id = f.seller_id
        WHERE ${LIVE.join(' AND ')} AND f.available > 0 AND lower(f.game) = lower($1) AND f.category_slug = $2 AND lower(f.attributes->>'${keyLiteral(field.key)}') IS NOT NULL
     ), per_seller AS (
       SELECT name, seller_id, max(display_name) AS display_name, max(completed_orders) AS completed, sum(sold_count) AS sold FROM live GROUP BY name, seller_id
     )
     SELECT l.name, count(*)::int AS offers, count(DISTINCT l.seller_id)::int AS sellers_count, COALESCE(sum(l.sold_count), 0)::int AS sold, min(l.micros)::text AS from_micros,
            (SELECT json_agg(json_build_object('id', s.seller_id, 'name', s.display_name, 'avatar', NULL) ORDER BY s.sold DESC, s.completed DESC, s.display_name)
               FROM (SELECT * FROM per_seller ps WHERE ps.name = l.name ORDER BY ps.sold DESC, ps.completed DESC, ps.display_name LIMIT 4) s) AS sellers
       FROM live l GROUP BY l.name`,
    [game, category, field.key],
  );
  const by = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const names = field.type === 'select' && field.options ? [...field.options] : rows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
  const servers: ServerRow[] = names.map((name) => {
    const r = by.get(name.toLowerCase());
    const micros = r?.from_micros != null ? Number(r.from_micros) : null;
    return {
      name,
      offers: r?.offers ?? 0,
      sellers: (r?.sellers ?? []).map((s) => ({ id: s.id, name: s.name, avatar: s.avatar })),
      sellers_count: r?.sellers_count ?? 0,
      sold: r?.sold ?? 0,
      from_unit_price: micros != null ? formatUnitPrice(micros) : null,
      from_unit_price_micros: micros,
    };
  });
  return { game, category, key: field.key, label: field.label, servers };
}

export interface ServerRow {
  name: string;
  offers: number;
  sellers: Array<{ id: string; name: string; avatar: string | null }>;
  sellers_count: number;
  sold: number;
  /** Lowest unit price a buyer pays, settlement currency (USD), six decimals; null when nothing is listed. */
  from_unit_price: string | null;
  from_unit_price_micros: number | null;
}
