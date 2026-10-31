import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, SlidersHorizontal } from '@phosphor-icons/react';
import { api } from '../api';
import { CATEGORY_ICON, OfferTable, SellerFaces } from '../components/CatalogUi';
import { categoryLabel, slugify, useCategoryOrder } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { usePageMeta } from '@/lib/seo';
import { intlLocale, t, type MessageKey } from '../i18n';
import type { PriceTier } from '@/lib/tiers';
import { useDisplayCurrency, usePrice } from '@/lib/prefs';
import { attrLabel, attributesFor } from '@/lib/attributes';
import { compact, deliveryTimeLabel, methodLabel, type MethodKey } from '@/lib/delivery';
import { DELIVERY_TIME_KEYS } from '../../../api/src/domain/unitPrice';

export interface Offer {
  /** Set on a listing agreed on a buyer request: only that buyer can see and buy it. */
  reserved_for?: string | null;
  status?: string;
  seller_trust_level?: 'new' | 'rising' | 'trusted' | 'top';
  seller_founding?: boolean;
  /** Seller rank name (Hatchling … Dragon), when the API sends it. */
  seller_rank?: string | null;
  /** Up to two badges the seller chose to show: `rank:<name>`, `founding`, `trust:<level>`, `verified`. */
  seller_badges?: string[];
  seller_last_seen_at?: string | null;
  /** Seller level, from completed orders (Round 24). */
  seller_level?: number | null;
  /** Share of positive reviews, 0–100. */
  seller_positive_pct?: number | null;
  /** Completed orders on this listing. */
  sold_count?: number | null;
  /** Public offer ID shown to buyers, for reports: "BZO" + 12 characters, no dash. */
  public_id?: string | null;
  /** Delivery methods the seller offers on this listing (keys from lib/delivery). */
  delivery_methods?: string[] | null;
  /** Currency sold by amount: price_cents (= price_per_unit_cents) is per one `unit_label` ("1M"), bought from `min_qty` up to `stock` (= stock_qty). */
  unit_label?: string | null;
  unit_size?: number | null;
  min_qty?: number | null;
  price_per_unit_cents?: number;
  stock_qty?: number;
  /** Only on the seller's own shop (GET /offers?seller=): a featured listing, pinned first there. */
  featured?: boolean;
  is_bundle?: boolean;
  /** Round 25, currency listings: buyer's price of one unit in USD micro-units (123 = 0.000123); null otherwise. */
  unit_price_micros?: number | null;
  /** The same in the `currency=` the list was asked for. */
  display_unit_price_micros?: number | null;
  /** Up to four tiers: from this many units, this % off. */
  volume_discounts?: Array<{ minQty: number; percentOff: number } | { minQty: number; type: 'percent' | 'fixed'; value: number }>;
  /** Promised delivery time in minutes (0 = instant) and as the seller's pick (15m … 24h; null = instant or longer). */
  delivery_minutes?: number | null;
  delivery_time?: '15m' | '1h' | '3h' | '6h' | '12h' | '24h' | null;
  /** Account listings: warranty after escrow releases, in days (0 = none). */
  warranty_days?: number;
  /** Account listings tied to a platform account the seller signed in to (the account name stays private). */
  linked_platform?: 'steam' | 'riot' | null;
  linked_account_created_at?: string | null;
  /** A bundle's parts: what's inside and what each costs on its own. */
  bundle?: Array<{ offer_id: string; quantity: number; title: string; game: string; currency: string; price_cents: number }>;
  /** Set while a sale runs: the price before the sale (price_cents is the sale price). */
  regular_price_cents?: number;
  sale_ends_at?: string | null;
  shop_paused?: boolean;
  request_id?: string | null;
  /** Cheaper unit prices for larger orders, ascending by quantity. */
  price_tiers?: PriceTier[];
  /** Seller signed in within the last few minutes (and shows it). */
  seller_online?: boolean;
  /** Median first reply in chat, minutes; null until there are enough chats. */
  seller_response_minutes?: number | null;
  id: string;
  seller_id: string;
  seller_name: string;
  category_slug: string;
  category_kind: string;
  game: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  delivery_mode: 'auto' | 'manual';
  delivery_hours?: number | null;
  display_price_cents?: number;
  display_currency?: string;
  stock: number;
  high_risk_secondary: boolean;
  owner_proof_status: string;
  seller_completed_orders: number;
  seller_rating: number | null;
  seller_review_count: number;
  version: number;
  /** Game-specific fields such as server, region or rank. */
  attributes?: Record<string, string>;
}

/** "Steam account verified · since 2014": the seller signed in to it, so we know they control it. */
export function LinkedBadge({ offer }: { offer: Pick<Offer, 'linked_platform' | 'linked_account_created_at'> }) {
  const platform = offer.linked_platform === 'steam' ? 'Steam' : 'Riot';
  const year = offer.linked_account_created_at ? String(new Date(offer.linked_account_created_at).getFullYear()) : null;
  return (
    <span className="chip released" title={t('linked.badgeHint', { platform })}>
      {year ? t('linked.badgeSince', { platform, year }) : t('linked.badge', { platform })}
    </span>
  );
}

export function OfferBadges({ offer }: { offer: Offer }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      {offer.delivery_mode === 'auto' && <span className="chip released">{t('badge.instant')}</span>}
      {offer.category_kind === 'account' ? (
        <>
          <span className="chip held">{t('badge.insurance')}</span>
          {offer.high_risk_secondary ? <span className="chip disputed">{t('badge.highRisk')}</span> : <span className="chip released">{t('badge.ownerVerified')}</span>}
          {offer.linked_platform && <LinkedBadge offer={offer} />}
          {!!offer.warranty_days && <span className="chip released" title={t('warranty.badgeHint', { days: offer.warranty_days })}>{t('warranty.badge', { days: offer.warranty_days })}</span>}
        </>
      ) : null}
    </div>
  );
}

interface SearchResult {
  items: Offer[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  facets: { categories: Array<{ category_slug: string; count: number }> };
}
/** GET /offers/facets (Round 25, B4): each facet ignores its own filter. */
interface Facets {
  games: Array<{ game: string; count: number }>;
  servers: { key: string; label: string; values: Array<{ name: string; count: number }> } | null;
  delivery_methods: Array<{ method: string; count: number }>;
}

const SORTS = ['recommended', 'price_asc', 'price_desc', 'most_sold', 'fastest_delivery', 'newest'] as const;
/** Filters the URL carries, in the API's own names (/offers and /offers/facets take them as they are). */
const FILTER_KEYS = ['q', 'category', 'game', 'server', 'minUnitPrice', 'maxUnitPrice', 'deliveryMethod', 'maxDeliveryTime', 'online', 'minLevel'] as const;
const LEVELS = [5, 10, 20, 50, 100] as const;
const GAMES_SHOWN = 8;
const GROUPS_PER_PAGE = 24;
const PAGE_SIZE = 24;
/** Currency results are grouped by game and server; at most this many listings are read to build the groups. */
const GROUP_SCAN_PAGES = 10;

interface Group { key: string; game: string; server: string; region: string | null; field: string | null; offers: number; sold: number; sellers: Array<{ id: string; name: string }>; sellersCount: number; fromMicros: number | null; fromCents: number }

/**
 * /market, G2G-style (Round 25, F6): a filter panel on the left (game with counts, server or region, price range,
 * delivery method and time, seller online, seller level), a sort, the result count and pages. Currency results
 * come as server cards (game + server, sold, seller faces, "From" price); other types as the listing table.
 */
export function Market() {
  const [params, setParams] = useSearchParams();
  const categoryOrder = useCategoryOrder(); // open types only, in launch order
  const [result, setResult] = useState<SearchResult | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [allGames, setAllGames] = useState(false);
  const cur = useDisplayCurrency();
  const price = usePrice();
  const get = (k: string) => params.get(k) ?? '';
  const q = get('q');
  // Game coins are the market's front page; a search looks across every type.
  const category = get('category') || (q ? '' : 'currency');
  const grouped = category === 'currency';
  const sort = get('sort') || 'recommended';
  const page = Math.max(1, Number(get('page') || 1));

  const filters = useMemo(() => {
    const f = new URLSearchParams();
    for (const k of FILTER_KEYS) if (params.get(k)) f.set(k, params.get(k)!);
    if (category) f.set('category', category);
    if (f.get('minUnitPrice') || f.get('maxUnitPrice')) f.set('currency', cur);
    return f;
  }, [params, category, cur]);

  useEffect(() => {
    let stale = false;
    setFacets(null);
    api<Facets>(`/offers/facets?${filters}`).then((r) => !stale && setFacets(r)).catch(() => !stale && setFacets({ games: [], servers: null, delivery_methods: [] }));
    return () => { stale = true; };
  }, [filters]);

  useEffect(() => {
    let stale = false;
    setError('');
    setResult(null);
    setGroups(null);
    const qs = new URLSearchParams(filters);
    qs.set('sort', sort);
    if (grouped) {
      // Read the matching listings (in the chosen order) and fold them into game + server cards.
      (async () => {
        const items: Offer[] = [];
        for (let p = 1; p <= GROUP_SCAN_PAGES; p++) {
          qs.set('page', String(p));
          qs.set('pageSize', '60');
          const r = await api<SearchResult>(`/offers?${qs}`);
          items.push(...r.items);
          if (!r.hasMore) break;
        }
        if (!stale) setGroups(groupOffers(items));
      })().catch((e) => !stale && setError(e.message));
    } else {
      qs.set('page', String(page));
      qs.set('pageSize', String(PAGE_SIZE));
      api<SearchResult>(`/offers?${qs}`).then((r) => !stale && setResult(r)).catch((e) => !stale && setError(e.message));
    }
    return () => { stale = true; };
  }, [filters, sort, grouped, grouped ? 0 : page]);

  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
    if ('game' in changes) next.delete('server'); // a server belongs to one game
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };
  const clearAll = () => setParams(new URLSearchParams(q ? { q } : {}));
  const active = FILTER_KEYS.filter((k) => k !== 'q' && k !== 'category' && params.get(k)).length;

  const title = q ? t('market.resultsFor', { q }) : categoryLabel(category);
  usePageMeta({ title, description: `${title} on Bullizard: compare offers by price, delivery time and seller rating. Every order is held in escrow.` });

  const total = grouped ? groups?.length ?? null : result?.total ?? null;
  const pages = grouped ? Math.max(1, Math.ceil((groups?.length ?? 0) / GROUPS_PER_PAGE)) : Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));
  const shownGroups = groups?.slice((page - 1) * GROUPS_PER_PAGE, page * GROUPS_PER_PAGE) ?? [];
  const gameList = facets?.games ?? [];
  const visibleGames = allGames ? gameList : gameList.slice(0, GAMES_SHOWN);

  return (
    <div className="stack mk">
      <div className="row spread" style={{ alignItems: 'end' }}>
        <div>
          <div className="eyebrow">{q ? t('market.searchEyebrow') : t('market.eyebrow')}</div>
          <h1 style={{ fontSize: 40, margin: 0 }}>{title}</h1>
        </div>
        <form
          role="search"
          aria-label={t('market.search')}
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: String(new FormData(e.currentTarget).get('q') ?? '') });
          }}
          style={{ minWidth: 260, flex: '0 1 360px' }}
        >
          <input name="q" defaultValue={q} key={q} placeholder={t('market.search')} aria-label={t('market.search')} />
        </form>
      </div>

      <nav className="mk-types" aria-label={t('market.category')}>
        {categoryOrder.map((slug) => {
          const Icon = CATEGORY_ICON[slug];
          return (
            <button key={slug} type="button" aria-pressed={category === slug} onClick={() => set({ category: slug, game: '', server: '' })}>
              {Icon && <Icon className="size-4" aria-hidden />}{categoryLabel(slug)}
            </button>
          );
        })}
      </nav>

      <div className="mk-layout">
        <aside id="market-filters" className={cn('card mk-filters', !filtersOpen && 'max-lg:hidden')} aria-label={t('market.filters')}>
          <div className="row spread">
            <h2 className="mk-filters-title">{t('market.filters')}</h2>
            {active > 0 && <button type="button" className="btn ghost sm" onClick={clearAll}>{t('mk.clear')}</button>}
          </div>

          <fieldset className="mk-group">
            <legend>{t('mk.game')}</legend>
            <button type="button" className="side-filter" aria-pressed={!get('game')} onClick={() => set({ game: '' })}>
              <span>{t('mk.allGames')}</span>
            </button>
            {visibleGames.map((g) => (
              <button key={g.game} type="button" className="side-filter" aria-pressed={get('game').toLowerCase() === g.game.toLowerCase()} onClick={() => set({ game: g.game })}>
                <span className="truncate">{g.game}</span>
                <span className="mono small">{compact(g.count)}</span>
              </button>
            ))}
            {gameList.length > GAMES_SHOWN && (
              <button type="button" className="mk-more" aria-expanded={allGames} onClick={() => setAllGames((v) => !v)}>
                {allGames ? t('mk.showLess') : t('mk.showMore', { n: gameList.length - GAMES_SHOWN })}
              </button>
            )}
          </fieldset>

          {get('game') && facets?.servers && facets.servers.values.length > 0 && (
            <label className="mk-group field">
              <span className="mk-legend">{attrLabel(facets.servers.label)}</span>
              <select value={get('server')} onChange={(e) => set({ server: e.target.value })}>
                <option value="">{t('attr.any', { label: attrLabel(facets.servers.label).toLowerCase() })}</option>
                {facets.servers.values.map((v) => <option key={v.name} value={v.name} disabled={!v.count && v.name !== get('server')}>{v.name} ({v.count})</option>)}
              </select>
            </label>
          )}

          <fieldset className="mk-group">
            <legend>{t('mk.price', { currency: price.currency })}</legend>
            <PriceRange min={get('minUnitPrice')} max={get('maxUnitPrice')} onApply={(min, max) => set({ minUnitPrice: min, maxUnitPrice: max })} />
          </fieldset>

          {(facets?.delivery_methods.length ?? 0) > 0 && (
            <fieldset className="mk-group">
              <legend>{t('of.deliveryMethods')}</legend>
              <label className="check-row"><input type="radio" name="mk-method" checked={!get('deliveryMethod')} onChange={() => set({ deliveryMethod: '' })} /> {t('mk.any')}</label>
              {facets!.delivery_methods.map((m) => (
                <label key={m.method} className="check-row">
                  <input type="radio" name="mk-method" checked={get('deliveryMethod') === m.method} onChange={() => set({ deliveryMethod: m.method })} />
                  <span className="flex-1">{methodLabel(m.method as MethodKey)}</span>
                  <span className="mono small muted">{compact(m.count)}</span>
                </label>
              ))}
            </fieldset>
          )}

          <label className="mk-group field">
            <span className="mk-legend">{t('co.deliveryTime')}</span>
            <select value={get('maxDeliveryTime')} onChange={(e) => set({ maxDeliveryTime: e.target.value })}>
              <option value="">{t('mk.any')}</option>
              {DELIVERY_TIME_KEYS.map((k) => <option key={k} value={k}>{t('mk.upTo', { time: deliveryTimeLabel(k) })}</option>)}
            </select>
          </label>

          <fieldset className="mk-group">
            <legend>{t('table.seller')}</legend>
            <label className="ct-toggle">
              <input type="checkbox" role="switch" checked={get('online') === 'true'} onChange={(e) => set({ online: e.target.checked ? 'true' : '' })} />
              <span>{t('ct.onlineOnly')}</span>
            </label>
            <label className="field">
              <span className="mk-legend">{t('mk.level')}</span>
              <select value={get('minLevel')} onChange={(e) => set({ minLevel: e.target.value })}>
                <option value="">{t('mk.any')}</option>
                {LEVELS.map((n) => <option key={n} value={n}>{t('mk.levelMin', { n })}</option>)}
              </select>
            </label>
          </fieldset>
        </aside>

        <div className="stack" style={{ minWidth: 0 }}>
          <div className="mk-toolbar">
            <span className="small muted" role="status" data-testid="result-count">{total == null ? ' ' : t('mk.results', { n: total.toLocaleString(intlLocale()) })}</span>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn ghost filters-toggle" aria-expanded={filtersOpen} aria-controls="market-filters" onClick={() => setFiltersOpen((o) => !o)}><SlidersHorizontal className="size-4" aria-hidden /> {t('market.filters')}</button>
              <label className="mk-sort small">
                <span>{t('sort.label')}</span>
                <select value={sort} onChange={(e) => set({ sort: e.target.value })}>
                  {SORTS.map((k) => <option key={k} value={k}>{t(`mk.sort.${k}` as MessageKey)}</option>)}
                </select>
              </label>
            </div>
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
          {grouped ? (
            groups === null ? (
              !error && <p className="muted">{t('market.loading')}</p>
            ) : groups.length === 0 ? (
              <Empty onClear={active ? clearAll : undefined} />
            ) : (
              <ul className="srv-grid mk-groups">
                {shownGroups.map((g) => <GroupCard key={g.key} g={g} />)}
              </ul>
            )
          ) : result === null ? (
            !error && <p className="muted">{t('market.loading')}</p>
          ) : result.items.length === 0 ? (
            <Empty onClear={active ? clearAll : undefined} />
          ) : (
            <OfferTable offers={result.items} showGame />
          )}
          {total != null && pages > 1 && <Pager page={page} pages={pages} onGo={(p) => { set({ page: p > 1 ? String(p) : '' }); window.scrollTo({ top: 0 }); }} />}
        </div>
      </div>
    </div>
  );
}

/** Listings folded into game + server cards, in the order the sort put them. */
function groupOffers(items: Offer[]): Group[] {
  const by = new Map<string, Group & { ids: Map<string, { id: string; name: string; sales: number }> }>();
  for (const o of items) {
    const field = attributesFor(o.game, 'currency')[0];
    const server = (field && o.attributes?.[field.key]) || '';
    const key = `${o.game}\u0000${server}`;
    let g = by.get(key);
    if (!g) {
      const region = field?.key !== 'region' ? o.attributes?.region ?? null : null;
      g = { key, game: o.game, server, region, field: field?.key ?? null, offers: 0, sold: 0, sellers: [], sellersCount: 0, fromMicros: null, fromCents: o.price_cents, ids: new Map() };
      by.set(key, g);
    }
    g.offers++;
    g.sold += o.sold_count ?? 0;
    if (!g.ids.has(o.seller_id)) g.ids.set(o.seller_id, { id: o.seller_id, name: o.seller_name, sales: o.seller_completed_orders ?? 0 });
    if (o.unit_price_micros != null && (g.fromMicros == null || o.unit_price_micros < g.fromMicros)) g.fromMicros = Number(o.unit_price_micros);
    if (o.price_cents < g.fromCents) g.fromCents = o.price_cents;
  }
  return [...by.values()].map(({ ids, ...g }) => {
    const sellers = [...ids.values()].sort((a, b) => b.sales - a.sales);
    return { ...g, sellers: sellers.slice(0, 4), sellersCount: sellers.length };
  });
}

function GroupCard({ g }: { g: Group }) {
  const price = usePrice();
  const to = `/games/${slugify(g.game)}/currency${g.server && g.field ? `?${new URLSearchParams({ [`attr.${g.field}`]: g.server })}` : ''}`;
  return (
    <li>
      <Link to={to} className="srv-card mk-card">
        <img className="srv-cover" src={`/games/${slugify(g.game)}.webp`} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        <span className="srv-top">
          <b className="srv-name">{g.game}{g.server ? ` ${g.server}` : ''}</b>
          {g.region && <span className="mk-region small">{g.region}</span>}
          {g.sold > 0 && <span className="srv-sold num">{t('ct.sold', { n: compact(g.sold) })}</span>}
          <span className="srv-mid">
            <SellerFaces sellers={g.sellers} total={g.sellersCount} />
            <span className="srv-count"><b className="num">{t('offers.count', { count: g.offers })}</b><span className="small muted">{t('srv.available')}</span></span>
          </span>
        </span>
        <span className="srv-bottom">
          <span className="srv-price"><span className="small muted">{t('ct.from')}</span><b className="num">{g.fromMicros != null ? price.unit(g.fromMicros) : price(g.fromCents)}</b></span>
          <span className="srv-go" aria-hidden><ArrowRight className="size-5 rtl:rotate-180" /></span>
        </span>
      </Link>
    </li>
  );
}

/** Two boxes in the viewer's currency, applied together (unit price, up to 6 decimals). */
function PriceRange({ min, max, onApply }: { min: string; max: string; onApply: (min: string, max: string) => void }) {
  const [lo, setLo] = useState(min);
  const [hi, setHi] = useState(max);
  useEffect(() => (setLo(min), setHi(max)), [min, max]);
  const ok = (v: string) => !v || /^\d{1,9}(\.\d{1,6})?$/.test(v.trim());
  return (
    <form className="mk-range" onSubmit={(e) => (e.preventDefault(), ok(lo) && ok(hi) && onApply(lo.trim(), hi.trim()))}>
      <input className="num" inputMode="decimal" aria-label={t('mk.min')} value={lo} aria-invalid={!ok(lo) || undefined} onChange={(e) => setLo(e.target.value.replace(',', '.'))} />
      <span aria-hidden>–</span>
      <input className="num" inputMode="decimal" aria-label={t('mk.max')} value={hi} aria-invalid={!ok(hi) || undefined} onChange={(e) => setHi(e.target.value.replace(',', '.'))} />
      <button type="submit" className="btn ghost sm">{t('mk.apply')}</button>
    </form>
  );
}

function Pager({ page, pages, onGo }: { page: number; pages: number; onGo: (p: number) => void }) {
  // 1 … 4 5 [6] 7 8 … 20
  const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <nav className="mk-pager" aria-label={t('mk.pages')}>
      <button type="button" className="btn ghost sm" disabled={page <= 1} onClick={() => onGo(page - 1)}>{t('market.prev')}</button>
      {nums.map((n, i) => (
        <span key={n} className="contents">
          {i > 0 && n - nums[i - 1]! > 1 && <span className="muted" aria-hidden>…</span>}
          <button type="button" className="mk-page num" aria-current={n === page ? 'page' : undefined} onClick={() => onGo(n)}>{n}</button>
        </span>
      ))}
      <button type="button" className="btn ghost sm" disabled={page >= pages} onClick={() => onGo(page + 1)}>{t('market.next')}</button>
    </nav>
  );
}

function Empty({ onClear }: { onClear?: () => void }) {
  return (
    <div className="card">
      <h3>{t('market.none')}</h3>
      <p className="muted">
        {t('market.none.text')} <Link to="/sell/new">{t('market.none.link')}</Link>.
        {onClear && <> <button type="button" className="btn ghost sm" onClick={onClear}>{t('mk.clear')}</button></>}
      </p>
    </div>
  );
}
