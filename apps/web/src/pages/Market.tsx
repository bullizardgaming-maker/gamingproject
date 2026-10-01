import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { api } from '../api';
import { CATEGORY_ICON, OfferTable } from '../components/CatalogUi';
import { CATEGORY_ORDER, categoryLabel, popular, slugify, useGames } from '@/lib/catalog';
import { cn } from '@/lib/utils';

interface Category {
  slug: string;
  name: string;
  kind: string;
}

export interface Offer {
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
}

export function OfferBadges({ offer }: { offer: Offer }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      {offer.delivery_mode === 'auto' && <span className="chip released">Instant delivery</span>}
      {offer.category_kind === 'account' ? (
        <>
          <span className="chip held">14-day insurance</span>
          {offer.high_risk_secondary ? <span className="chip disputed">High risk · secondary market</span> : <span className="chip released">Owner verified</span>}
        </>
      ) : (
        <span className="chip held">72h inspection</span>
      )}
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

const SORT_LABELS: Record<string, string> = {
  relevance: 'Best match',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  rating: 'Seller rating',
  best_selling: 'Best-selling sellers',
};

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
  const title = q ? `Results for “${q}”` : category ? categoryLabel(category) : 'All offers';
  // Games that sell in this category, as quick links (the way a category landing page works).
  const gamesHere = games ? popular(games.filter((g) => !category || g.categories.some((c) => c.slug === category)), 14) : [];

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'end' }}>
        <div>
          <div className="eyebrow">{q ? 'Search' : 'Market'}</div>
          <h1 style={{ fontSize: 40, margin: 0 }}>{title}</h1>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: String(new FormData(e.currentTarget).get('q') ?? '') });
          }}
          style={{ minWidth: 260, flex: '0 1 360px' }}
        >
          <input name="q" defaultValue={q} key={q} placeholder="Search listings" aria-label="Search" />
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
        <aside className={cn('card stack lg:sticky lg:top-[132px]', !filtersOpen && 'max-lg:hidden')} style={{ padding: 16 }} aria-label="Filters">
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Category</div>
            <div className="filters" role="group" aria-label="Category" style={{ flexDirection: 'column', gap: 2, marginBottom: 0 }}>
              <button className="side-filter" aria-pressed={!category} onClick={() => set({ category: '' })}>
                <span>All</span>
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
              Instant delivery
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={get('ownerVerified') === 'true'} onChange={(e) => set({ ownerVerified: e.target.checked ? 'true' : '' })} />
              Owner-verified accounts
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={get('minRating') === '4.8'} onChange={(e) => set({ minRating: e.target.checked ? '4.8' : '' })} />
              Sellers rated 4.8+
            </label>
            <label className="field">
              Max price ($)
              <input type="number" min={0} defaultValue={get('maxPrice') ? Number(get('maxPrice')) / 100 : ''}
                onBlur={(e) => set({ maxPrice: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : '' })} />
            </label>
          </div>
        </aside>

        <div className="stack" style={{ minWidth: 0 }}>
          <div className="row spread small">
            <span className="muted">{result ? `${result.total} offer${result.total === 1 ? '' : 's'}` : ' '}</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost filters-toggle" onClick={() => setFiltersOpen((o) => !o)}><SlidersHorizontal className="size-4" /> Filters</button>
              <select value={get('sort') || (q ? 'relevance' : 'newest')} onChange={(e) => set({ sort: e.target.value })} style={{ width: 200 }} aria-label="Sort">
                {Object.entries(SORT_LABELS).filter(([k]) => q || k !== 'relevance').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          {error && <div className="alert">{error}</div>}
          {result === null ? (
            <p className="muted">Loading listings…</p>
          ) : result.items.length === 0 ? (
            <div className="card">
              <h3>No listings match</h3>
              <p className="muted">Try another category or search term, or <Link to="/sell">list something yourself</Link>.</p>
            </div>
          ) : (
            <>
              <OfferTable offers={result.items} showGame />
              <div className="row">
                <button className="btn ghost" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
                <span className="small muted">Page {page} of {Math.max(1, Math.ceil(result.total / result.pageSize))}</span>
                <button className="btn ghost" disabled={!result.hasMore} onClick={() => set({ page: String(page + 1) })}>Next</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
