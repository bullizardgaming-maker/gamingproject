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

export function Market() {
  const [params, setParams] = useSearchParams();
  const [categories, setCategories] = useState<Category[]>([]);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState('');
  const category = params.get('category') ?? '';
  const q = params.get('q') ?? '';

  useEffect(() => {
    api<Category[]>('/categories').then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (category) qs.set('category', category);
    if (q) qs.set('q', q);
    setOffers(null);
    api<Offer[]>(`/offers?${qs}`).then(setOffers).catch((e) => setError(e.message));
  }, [category, q]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ fontSize: 40 }}>Market</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set('q', String(new FormData(e.currentTarget).get('q') ?? ''));
          }}
          style={{ minWidth: 260, flex: '0 1 360px' }}
        >
          <input name="q" defaultValue={q} placeholder="Search games or listings" aria-label="Search" />
        </form>
      </div>
      <div className="filters" role="group" aria-label="Category">
        <button aria-pressed={!category} onClick={() => set('category', '')}>All</button>
        {categories.map((c) => (
          <button key={c.slug} aria-pressed={category === c.slug} onClick={() => set('category', c.slug)}>
            {c.name}
          </button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      {offers === null ? (
        <p className="muted">Loading listings…</p>
      ) : offers.length === 0 ? (
        <div className="card">
          <h3>No listings match</h3>
          <p className="muted">Try another category or search term, or <Link to="/sell">list something yourself</Link>.</p>
        </div>
      ) : (
        <div className="grid three">
          {offers.map((o) => (
            <Link key={o.id} to={`/offers/${o.id}`} className="card offer">
              <div className="eyebrow" style={{ marginBottom: 0 }}>{o.game}</div>
              <div className="title">{o.title}</div>
              <OfferBadges offer={o} />
              <div className="row spread">
                <span className="price">{money(o.price_cents, o.currency)}</span>
                <span className="small muted">{o.stock} in stock · {o.seller_name}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
