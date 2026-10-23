import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SlidersHorizontal } from '@phosphor-icons/react';
import { api } from '../api';
import { CATEGORY_ICON, OfferTable } from '../components/CatalogUi';
import { CATEGORY_ORDER, categoryLabel, popular, slugify, useGames } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { usePageMeta } from '@/lib/seo';
import { t, type MessageKey } from '../i18n';
import type { PriceTier } from '@/lib/tiers';
import { SaveSearchButton, paramsFromUrl } from '../components/SaveSearchButton';

interface Category {
  slug: string;
  name: string;
  kind: string;
}

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
  /** Currency sold by amount: price_cents (= price_per_unit_cents) is per one `unit_label` ("1M"), bought from `min_qty` up to `stock` (= stock_qty). */
  unit_label?: string | null;
  unit_size?: number | null;
  min_qty?: number | null;
  price_per_unit_cents?: number;
  stock_qty?: number;
  featured?: boolean;
  is_bundle?: boolean;
  /** Account listings: warranty after escrow releases, in days (0 = none). */
  warranty_days?: number;
  min_buyer_reputation?: 'good' | null;
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
      {offer.min_buyer_reputation && <span className="chip held" title={t('minRep.badgeHint')}>{t('minRep.badge')}</span>}
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

const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'rating', 'best_selling', 'trust'] as const;

export function Market() {
  const [params, setParams] = useSearchParams();
  const [categories, setCategories] = useState<Category[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { games } = useGames();
  const get = (k: string) => params.get(k) ?? '';
  const q = get('q');
  const category = get('category');

  useEffect(() => {
    api<Category[]>('/categories').then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    setResult(null);
    api<SearchResult>(`/offers?${params}`).then(setResult).catch((e) => setError(e.message));
  }, [params]);

  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };
  const countFor = (slug: string) => result?.facets.categories.find((c) => c.category_slug === slug)?.count ?? 0;
  const page = Number(get('page') || 1);
  const ordered = [...categories].sort((a, b) => CATEGORY_ORDER.indexOf(a.slug) - CATEGORY_ORDER.indexOf(b.slug));
  const title = q ? t('market.resultsFor', { q }) : category ? categoryLabel(category) : t('market.all');
  usePageMeta({ title, description: `${title} on Bullizard: compare offers by price, delivery time and seller rating. Every order is held in escrow.` });
  // Games that sell in this category, as quick links (the way a category landing page works).
  const gamesHere = games ? popular(games.filter((g) => !category || g.categories.some((c) => c.slug === category)), 14) : [];

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'end' }}>
        <div>
          <div className="eyebrow">{q ? t('market.searchEyebrow') : t('market.eyebrow')}</div>
          <h1 style={{ fontSize: 40, margin: 0 }}>{title}</h1>
          <div style={{ marginTop: 8 }}><SaveSearchButton params={paramsFromUrl(params)} name={title} /></div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: String(new FormData(e.currentTarget).get('q') ?? '') });
          }}
          style={{ minWidth: 260, flex: '0 1 360px' }}
        >
          <input name="q" defaultValue={q} key={q} placeholder={t('market.search')} aria-label={t('market.search')} />
        </form>
      </div>

      {!q && gamesHere.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {gamesHere.map((g) => (
            <Link key={g.game} to={`/games/${slugify(g.game)}${category ? `/${category}` : ''}`} className="chip" style={{ textDecoration: 'none', fontSize: 13 }}>
              {g.game}
            </Link>
          ))}
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[230px_1fr]">
        <aside id="market-filters" className={cn('card stack lg:sticky lg:top-[132px]', !filtersOpen && 'max-lg:hidden')} style={{ padding: 16 }} aria-label={t('market.filters')}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>{t('market.category')}</div>
            <div className="filters" role="group" aria-label={t('market.category')} style={{ flexDirection: 'column', gap: 2, marginBottom: 0 }}>
              <button className="side-filter" aria-pressed={!category} onClick={() => set({ category: '' })}>
                <span>{t('market.allCats')}</span>
                <span className="mono small">{result ? result.facets.categories.reduce((s, c) => s + c.count, 0) : ''}</span>
              </button>
              {ordered.map((c) => {
                const Icon = CATEGORY_ICON[c.slug];
                return (
                  <button key={c.slug} className="side-filter" aria-pressed={category === c.slug} onClick={() => set({ category: c.slug })}>
                    <span className="inline-flex items-center gap-2">{Icon && <Icon className="size-4" />}{categoryLabel(c.slug)}</span>
                    <span className="mono small">{countFor(c.slug)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="stack small" style={{ borderTop: '1px solid var(--rule)', paddingTop: 14 }}>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={get('delivery') === 'instant'} onChange={(e) => set({ delivery: e.target.checked ? 'instant' : '' })} />
              {t('filter.instant')}
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={get('ownerVerified') === 'true'} onChange={(e) => set({ ownerVerified: e.target.checked ? 'true' : '' })} />
              {t('market.ownerVerified')}
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={get('minRating') === '4.8'} onChange={(e) => set({ minRating: e.target.checked ? '4.8' : '' })} />
              {t('filter.rated')}
            </label>
            <label className="field">
              {t('market.maxPrice')}
              <input type="number" min={0} defaultValue={get('maxPrice') ? Number(get('maxPrice')) / 100 : ''}
                onBlur={(e) => set({ maxPrice: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : '' })} />
            </label>
          </div>
        </aside>

        <div className="stack" style={{ minWidth: 0 }}>
          <div className="row spread small">
            <span className="muted">{result ? t('offers.count', { count: result.total }) : ' '}</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost filters-toggle" aria-expanded={filtersOpen} aria-controls="market-filters" onClick={() => setFiltersOpen((o) => !o)}><SlidersHorizontal className="size-4" /> {t('market.filters')}</button>
              <select value={get('sort') || (q ? 'relevance' : 'newest')} onChange={(e) => set({ sort: e.target.value })} style={{ width: 200 }} aria-label={t('sort.label')}>
                {SORTS.filter((k) => q || k !== 'relevance').map((k) => <option key={k} value={k}>{t(`sort.${k}` as MessageKey)}</option>)}
              </select>
            </div>
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
          {result === null ? (
            <p className="muted">{t('market.loading')}</p>
          ) : result.items.length === 0 ? (
            <div className="card">
              <h3>{t('market.none')}</h3>
              <p className="muted">{t('market.none.text')} <Link to="/sell">{t('market.none.link')}</Link>.</p>
            </div>
          ) : (
            <>
              <OfferTable offers={result.items} showGame />
              <div className="row">
                <button className="btn ghost" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>{t('market.prev')}</button>
                <span className="small muted">{t('market.page', { page, pages: Math.max(1, Math.ceil(result.total / result.pageSize)) })}</span>
                <button className="btn ghost" disabled={!result.hasMore} onClick={() => set({ page: String(page + 1) })}>{t('market.next')}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
