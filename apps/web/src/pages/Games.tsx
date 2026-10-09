import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BadgeCheck, Search, ShieldCheck, Zap } from 'lucide-react';
import { api } from '../api';
import { CATEGORY_ICON, GameArt, OfferTable } from '../components/CatalogUi';
import { CATEGORY_META, CATEGORY_ORDER, categoryLabel, slugify, useGames, type GameEntry } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { usePrice } from '@/lib/prefs';
import type { Offer } from './Market';
import { usePageMeta } from '@/lib/seo';
import { attributesFor } from '@/lib/attributes';
import { WatchButton } from '../components/WatchButton';

type AttrFacet = { key: string; value: string; count: number };

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const letterOf = (g: string) => (/^[a-z]/i.test(g) ? g[0]!.toUpperCase() : '#');

/** /games: every game with live offers, A–Z, each with direct links into its categories. */
export function Games() {
  usePageMeta({ title: 'All games A–Z', description: 'Every game with live offers on Bullizard: accounts, currency, items, keys, top-ups and boosting, all escrow-protected.' });
  const { games, error } = useGames();
  const [params, setParams] = useSearchParams();
  const filter = params.get('q') ?? '';
  const cat = params.get('category') ?? '';

  const shown = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return (games ?? []).filter((g) => (!t || g.game.toLowerCase().includes(t)) && (!cat || g.categories.some((c) => c.slug === cat)));
  }, [games, filter, cat]);
  const groups = useMemo(() => {
    const m = new Map<string, GameEntry[]>();
    for (const g of shown) m.set(letterOf(g.game), [...(m.get(letterOf(g.game)) ?? []), g]);
    return m;
  }, [shown]);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'end' }}>
        <div>
          <div className="eyebrow">Game directory</div>
          <h1 style={{ fontSize: 44, margin: 0 }}>All games A–Z</h1>
        </div>
        <label className="relative" style={{ flex: '0 1 340px' }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input aria-label="Filter games" placeholder="Filter games" value={filter} onChange={(e) => set('q', e.target.value)} style={{ paddingLeft: 36 }} />
        </label>
      </div>
      <div className="filters" role="group" aria-label="Category" style={{ marginBottom: 0 }}>
        <button aria-pressed={!cat} onClick={() => set('category', '')}>Everything</button>
        {CATEGORY_ORDER.map((slug) => (
          <button key={slug} aria-pressed={cat === slug} onClick={() => set('category', slug)}>{CATEGORY_META[slug]!.label}</button>
        ))}
      </div>
      <nav className="az-bar" aria-label="Jump to letter">
        {LETTERS.map((l) => (groups.has(l) ? <a key={l} href={`#letter-${l}`}>{l}</a> : <span key={l}>{l}</span>))}
      </nav>
      {error && <div className="alert">{error}</div>}
      {games === null ? (
        <p className="muted">Loading games…</p>
      ) : shown.length === 0 ? (
        <div className="card muted">No games match. Try another name or category.</div>
      ) : (
        <div className="stack" style={{ marginTop: 24 }}>
          {[...groups.entries()].map(([letter, list]) => (
            <section key={letter} id={`letter-${letter}`} className="grid gap-4 border-t border-border pt-5 md:grid-cols-[64px_1fr]" style={{ scrollMarginTop: 130 }}>
              <div className="font-display text-4xl font-bold leading-none text-muted-foreground">{letter}</div>
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((g) => (
                  <div key={g.game} className="flex gap-3">
                    <Link to={`/games/${slugify(g.game)}`} className="shrink-0" tabIndex={-1}>
                      <GameArt game={g.game} size="sm" className="h-11 w-16 rounded-lg" />
                    </Link>
                    <div className="min-w-0">
                      <Link to={`/games/${slugify(g.game)}`} className="block truncate font-semibold no-underline hover:underline">{g.game}</Link>
                      <div className="flex flex-wrap gap-x-2.5 text-[13px] text-muted-foreground">
                        {g.categories.map((c) => (
                          <Link key={c.slug} to={`/games/${slugify(g.game)}/${c.slug}`} className="no-underline hover:text-foreground hover:underline">
                            {categoryLabel(c.slug)} <span className="font-mono text-[11px]">{c.count}</span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const SORTS: Record<string, string> = {
  price_asc: 'Lowest price',
  rating: 'Best-rated seller',
  best_selling: 'Most sales',
  newest: 'Newest',
  price_desc: 'Highest price',
};

/** /games/:slug(/:category): one game's market, split into category tabs, as a comparison table. */
export function GamePage() {
  const { slug = '', category = '' } = useParams();
  const nav = useNavigate();
  const { games, error: gamesError } = useGames();
  const price = usePrice();
  const [params, setParams] = useSearchParams();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [facets, setFacets] = useState<AttrFacet[]>([]);
  const entry = games?.find((g) => slugify(g.game) === slug);
  usePageMeta({
    title: entry ? `${entry.game} ${category ? categoryLabel(category).toLowerCase() : 'marketplace'}` : undefined,
    description: entry
      ? `${entry.offers} ${entry.game} offers from ${entry.sellers} sellers${category ? ` in ${categoryLabel(category).toLowerCase()}` : ''}. Compare price, delivery time and seller rating; every order is held in escrow.`
      : undefined,
  });
  const get = (k: string) => params.get(k) ?? '';
  const sort = get('sort') || 'price_asc';

  const query = useMemo(() => {
    if (!entry) return null;
    const q = new URLSearchParams({ game: entry.game, sort, pageSize: '20' });
    if (category) q.set('category', category);
    for (const k of ['delivery', 'ownerVerified', 'minRating', 'q']) if (params.get(k)) q.set(k, params.get(k)!);
    // Game-specific fields only apply within one category (each category has its own set).
    if (category) for (const [k, v] of params) if (k.startsWith('attr.') && v) q.set(k, v);
    return q;
  }, [entry, category, sort, params]);

  useEffect(() => {
    if (!query) return;
    setOffers(null);
    setPage(1);
    api<{ items: Offer[]; total: number; hasMore: boolean; facets?: { attributes?: AttrFacet[] } }>(`/offers?${query}`)
      .then((r) => (setOffers(r.items), setTotal(r.total), setHasMore(r.hasMore), setFacets(r.facets?.attributes ?? [])))
      .catch((e) => setError(e.message));
  }, [query]);

  const more = async () => {
    const next = page + 1;
    const r = await api<{ items: Offer[]; hasMore: boolean }>(`/offers?${query}&page=${next}`);
    setOffers((o) => [...(o ?? []), ...r.items]);
    setHasMore(r.hasMore);
    setPage(next);
  };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  if (!games) return <p className="muted">{gamesError || 'Loading…'}</p>;
  if (!entry)
    return (
      <div className="card stack">
        <h2>We don’t have that game yet</h2>
        <p className="muted">There are no live offers for it right now.</p>
        <div className="row"><Link className="btn" to="/games">Browse all games</Link><Link className="btn ghost" to="/sell">Be the first to sell</Link></div>
      </div>
    );

  const tabs = CATEGORY_ORDER.filter((s) => entry.categories.some((c) => c.slug === s));
  const meta = category ? CATEGORY_META[category] : null;
  const prices = offers?.map((o) => o.price_cents) ?? [];

  return (
    <div className="stack">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/games">Games</Link><span>/</span>
        {category ? <><Link to={`/games/${slug}`}>{entry.game}</Link><span>/</span><span>{categoryLabel(category)}</span></> : <span>{entry.game}</span>}
      </nav>
      <div className="game-banner">
        <GameArt game={entry.game} size="lg" className="absolute inset-0 [&>span]:hidden" />
        <div className="inner">
          <GameArt game={entry.game} className="hidden aspect-[16/10] w-40 shrink-0 rounded-xl ring-2 ring-white/25 sm:block" />
          <div className="min-w-0">
            <div className="eyebrow" style={{ color: 'rgba(255,255,255,.7)' }}>{category ? categoryLabel(category) : 'Marketplace'}</div>
            <h1>{entry.game}{category ? ` ${categoryLabel(category).toLowerCase()}` : ''}</h1>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-sm text-white/80">
              <span>{entry.offers} offers</span>
              <span>{entry.sellers} sellers</span>
              <span>from {price(entry.min_price_cents)}</span>
              {entry.instant > 0 && <span className="inline-flex items-center gap-1"><Zap className="size-3.5" /> {entry.instant} instant</span>}
            </div>
          </div>
        </div>
      </div>

      <nav className="game-tabs" aria-label={`${entry.game} categories`}>
        <NavLink to={`/games/${slug}`} end>All offers <span className="count">{entry.offers}</span></NavLink>
        {tabs.map((s) => {
          const Icon = CATEGORY_ICON[s]!;
          return (
            <NavLink key={s} to={`/games/${slug}/${s}`}>
              <Icon className="size-4" /> {categoryLabel(s)} <span className="count">{entry.categories.find((c) => c.slug === s)!.count}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="toolbar" style={{ marginTop: 0 }}>
        <label className="relative" style={{ flex: '1 1 220px', maxWidth: 320 }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label={`Search ${entry.game} offers`}
            placeholder={`Search in ${entry.game}`}
            defaultValue={get('q')}
            key={slug}
            onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== get('q') && set('q', e.target.value.trim())}
            style={{ paddingLeft: 34, height: 38 }}
          />
        </label>
        <label><input type="checkbox" checked={get('delivery') === 'instant'} onChange={(e) => set('delivery', e.target.checked ? 'instant' : '')} /> Instant delivery</label>
        {(!category || category === 'accounts') && (
          <label><input type="checkbox" checked={get('ownerVerified') === 'true'} onChange={(e) => set('ownerVerified', e.target.checked ? 'true' : '')} /> Owner-verified</label>
        )}
        <label><input type="checkbox" checked={get('minRating') === '4.8'} onChange={(e) => set('minRating', e.target.checked ? '4.8' : '')} /> Sellers rated 4.8+</label>
        <select aria-label="Sort" value={sort} onChange={(e) => set('sort', e.target.value)} style={{ width: 190, marginLeft: 'auto', height: 38, padding: '6px 10px' }}>
          {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {category && <AttributeFilters game={entry.game} category={category} facets={facets} params={params} set={set} clear={(keys) => { const next = new URLSearchParams(params); keys.forEach((k) => next.delete(k)); setParams(next, { replace: true }); }} />}

      {meta && (
        <div className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm', meta.protection === '14d' ? 'border-released/30 bg-released/5' : 'border-held/30 bg-held/5')} style={{ marginTop: 0 }}>
          {meta.protection === '14d' ? <BadgeCheck className="mt-0.5 size-4 shrink-0 text-released" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-held" />}
          <span>
            {meta.protection === '14d'
              ? 'Accounts are insured for 14 days after delivery. Listings marked owner-verified come with the original registration email.'
              : 'Your payment stays in escrow for 72 hours after delivery so you can check everything arrived as described.'}
          </span>
        </div>
      )}

      {error && <div className="alert">{error}</div>}
      {offers === null ? (
        <p className="muted">Loading offers…</p>
      ) : (
        <>
          <div className="row spread small muted" style={{ marginTop: 8 }}>
            <span>{total} offer{total === 1 ? '' : 's'}{prices.length > 1 ? ` · ${price(Math.min(...prices))} – ${price(Math.max(...prices))}` : ''}</span>
            <span className="flex items-center gap-3">
              <Link to="/sell" className="small">Sell {entry.game} {category ? categoryLabel(category).toLowerCase() : 'items'}</Link>
              <WatchButton
                label={category ? 'Alert me on new lows' : `Watch ${entry.game}`}
                target={{
                  game: entry.game,
                  category: category || undefined,
                  attributes: category ? Object.fromEntries([...params].filter(([k, v]) => k.startsWith('attr.') && v).map(([k, v]) => [k.slice(5), v])) : undefined,
                }}
              />
            </span>
          </div>
          <OfferTable
            offers={offers}
            showGame={!category}
            empty={
              <>
                Nothing matches these filters.{' '}
                <button className="cursor-pointer border-0 bg-transparent p-0 underline" onClick={() => nav(`/games/${slug}${category ? `/${category}` : ''}`)}>Clear filters</button>
              </>
            }
          />
          {hasMore && <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={more}>Show more offers</button>}
        </>
      )}
    </div>
  );
}

/**
 * Server / region / platform / rank pickers for one game and category, G2G-style. Each option
 * shows how many live offers it has given the other filters; options with none are still listed
 * (greyed) so the full range is visible.
 */
function AttributeFilters({ game, category, facets, params, set, clear }: { game: string; category: string; facets: AttrFacet[]; params: URLSearchParams; set: (k: string, v: string) => void; clear: (keys: string[]) => void }) {
  const defs = attributesFor(game, category);
  if (!defs.length) return null;
  const active = defs.filter((d) => params.get(`attr.${d.key}`));
  return (
    <div className="flex flex-wrap items-end gap-2.5" role="group" aria-label={`${game} filters`}>
      {defs.map((d) => {
        const counts = new Map(facets.filter((f) => f.key === d.key).map((f) => [f.value, f.count]));
        // Free-text fields (e.g. a WoW realm) offer the values sellers have used.
        const options = d.type === 'select' ? [...d.options!] : [...counts.keys()].sort();
        const cur = params.get(`attr.${d.key}`) ?? '';
        if (!options.length && !cur) return null;
        return (
          <label key={d.key} className="grid gap-1 text-xs font-medium text-muted-foreground" style={{ flex: '0 1 180px' }}>
            {d.label}
            <select
              value={cur}
              onChange={(e) => set(`attr.${d.key}`, e.target.value)}
              className={cn(cur && 'border-foreground')}
              style={{ height: 38, padding: '6px 10px' }}
            >
              <option value="">Any {d.label.toLowerCase()}</option>
              {options.map((o) => {
                const n = counts.get(o) ?? 0;
                return <option key={o} value={o} disabled={!n && o !== cur}>{o}{` (${n})`}</option>;
              })}
            </select>
          </label>
        );
      })}
      {active.length > 0 && (
        <button type="button" className="btn ghost" style={{ height: 38, fontSize: 14 }} onClick={() => clear(active.map((d) => `attr.${d.key}`))}>
          Clear {active.length === 1 ? active[0]!.label.toLowerCase() : 'filters'}
        </button>
      )}
    </div>
  );
}
