import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';

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
  const get = (k: string) => params.get(k) ?? '';
  const q = get('q');

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

  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ fontSize: 40 }}>Market</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: String(new FormData(e.currentTarget).get('q') ?? '') });
          }}
          style={{ minWidth: 260, flex: '0 1 360px' }}
        >
          <input name="q" defaultValue={q} key={q} placeholder="Search games or listings" aria-label="Search" />
        </form>
      </div>
      <div className="filters" role="group" aria-label="Category">
        <button aria-pressed={!get('category')} onClick={() => set({ category: '' })}>All</button>
        {categories.map((c) => (
          <button key={c.slug} aria-pressed={get('category') === c.slug} onClick={() => set({ category: c.slug })}>
            {c.name} <span className="muted">{countFor(c.slug)}</span>
          </button>
        ))}
      </div>
      <div className="row small">
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={get('delivery') === 'instant'} onChange={(e) => set({ delivery: e.target.checked ? 'instant' : '' })} />
          Instant delivery
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={get('ownerVerified') === 'true'} onChange={(e) => set({ ownerVerified: e.target.checked ? 'true' : '' })} />
          Owner-verified accounts
        </label>
        <label className="row" style={{ gap: 6 }}>
          Max price $
          <input type="number" min={0} style={{ width: 90 }} defaultValue={get('maxPrice') ? Number(get('maxPrice')) / 100 : ''}
            onBlur={(e) => set({ maxPrice: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : '' })} />
        </label>
        <select value={get('sort') || (q ? 'relevance' : 'newest')} onChange={(e) => set({ sort: e.target.value })} style={{ width: 200 }} aria-label="Sort">
          {Object.entries(SORT_LABELS).filter(([k]) => q || k !== 'relevance').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
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
          <p className="small muted">{result.total} listing{result.total === 1 ? '' : 's'}</p>
          <div className="grid three">
            {result.items.map((o) => (
              <Link key={o.id} to={`/offers/${o.id}`} className="card offer">
                <div className="eyebrow" style={{ marginBottom: 0 }}>{o.game}</div>
                <div className="title">{o.title}</div>
                <OfferBadges offer={o} />
                <div className="row spread">
                  <span className="price">{money(o.price_cents, o.currency)}</span>
                  <span className="small muted">
                    {o.seller_review_count > 0 ? `★ ${o.seller_rating} · ` : ''}{o.stock} in stock · {o.seller_name}
                  </span>
                </div>
              </Link>
            ))}
          </div>
          <div className="row">
            <button className="btn ghost" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
            <span className="small muted">Page {page} of {Math.max(1, Math.ceil(result.total / result.pageSize))}</span>
            <button className="btn ghost" disabled={!result.hasMore} onClick={() => set({ page: String(page + 1) })}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
