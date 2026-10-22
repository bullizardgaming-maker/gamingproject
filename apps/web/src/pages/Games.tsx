import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BadgeCheck, Search, ShieldCheck, Zap } from 'lucide-react';
import { api } from '../api';
import { CATEGORY_ICON, GameArt, OfferTable } from '../components/CatalogUi';
import { CATEGORY_META, categoryLabel, slugify, useCategoryOrder, useGames, type GameEntry } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { usePrice } from '@/lib/prefs';
import type { Offer } from './Market';
import { usePageMeta } from '@/lib/seo';
import { attrLabel, attributesFor } from '@/lib/attributes';
import { t, type MessageKey } from '../i18n';
import { WatchButton } from '../components/WatchButton';
import { SaveSearchButton, paramsFromUrl } from '../components/SaveSearchButton';
import { MarketPriceHistory } from '../components/PriceHistory';

type AttrFacet = { key: string; value: string; count: number };

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const letterOf = (g: string) => (/^[a-z]/i.test(g) ? g[0]!.toUpperCase() : '#');

/** /games: every game with live offers, A–Z, each with direct links into its categories. */
export function Games() {
  const categoryOrder = useCategoryOrder();
  usePageMeta({ title: t('games.title'), description: 'Every game with live offers on Bullizard: accounts, currency, items, keys, top-ups and boosting, all escrow-protected.' });
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
          <div className="eyebrow">{t('games.eyebrow')}</div>
          <h1 style={{ fontSize: 44, margin: 0 }}>{t('games.title')}</h1>
        </div>
        <Link className="btn ghost" to="/games/vote">{t('votes.link')}</Link>
        <label className="relative" style={{ flex: '0 1 340px' }}>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input aria-label={t('games.filter')} placeholder={t('games.filter')} value={filter} onChange={(e) => set('q', e.target.value)} style={{ paddingInlineStart: 36 }} />
        </label>
      </div>
      <div className="filters" role="group" aria-label={t('market.category')} style={{ marginBottom: 0 }}>
        <button aria-pressed={!cat} onClick={() => set('category', '')}>{t('games.everything')}</button>
        {categoryOrder.map((slug) => (
          <button key={slug} aria-pressed={cat === slug} onClick={() => set('category', slug)}>{CATEGORY_META[slug]!.label}</button>
        ))}
      </div>
      <nav className="az-bar" aria-label={t('games.jump')}>
        {LETTERS.map((l) => (groups.has(l) ? <a key={l} href={`#letter-${l}`}>{l}</a> : <span key={l}>{l}</span>))}
      </nav>
      {error && <div className="alert" role="alert">{error}</div>}
      {games === null ? (
        <p className="muted">{t('games.loading')}</p>
      ) : shown.length === 0 ? (
        <div className="card muted">{t('games.none')}</div>
      ) : (
        <div className="stack" style={{ marginTop: 24 }}>
          {[...groups.entries()].map(([letter, list]) => (
            <section key={letter} id={`letter-${letter}`} className="grid gap-4 border-t border-border pt-5 md:grid-cols-[64px_1fr]" style={{ scrollMarginTop: 130 }}>
              <div className="font-display text-4xl font-bold leading-none text-muted-foreground">{letter}</div>
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((g) => (
                  <div key={g.game} className="flex gap-3">
                    <Link to={`/games/${slugify(g.game)}`} className="shrink-0" tabIndex={-1} aria-hidden="true">
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

const SORTS = ['price_asc', 'rating', 'trust', 'best_selling', 'newest', 'price_desc'] as const;

/** /games/:slug(/:category): one game's market, split into category tabs, as a comparison table. */
export function GamePage() {
  const categoryOrder = useCategoryOrder();
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
  const [amount, setAmount] = useState('1');
  const entry = games?.find((g) => slugify(g.game) === slug);
  usePageMeta({
    title: entry ? `${entry.game} · ${category ? categoryLabel(category) : t('game.marketplace')}` : undefined,
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
    let stale = false; // a slower earlier request must not overwrite newer filters
    api<{ items: Offer[]; total: number; hasMore: boolean; facets?: { attributes?: AttrFacet[] } }>(`/offers?${query}`)
      .then((r) => { if (!stale) (setOffers(r.items), setTotal(r.total), setHasMore(r.hasMore), setFacets(r.facets?.attributes ?? [])); })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
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
        <h2>{t('game.missing')}</h2>
        <p className="muted">{t('game.missing.text')}</p>
        <div className="row"><Link className="btn" to="/games">{t('game.browseAll')}</Link><Link className="btn ghost" to="/sell">{t('game.beFirst')}</Link></div>
      </div>
    );

  const tabs = categoryOrder.filter((s) => entry.categories.some((c) => c.slug === s));
  const meta = category ? CATEGORY_META[category] : null;
  const prices = offers?.map((o) => o.price_cents) ?? [];

  const unitWord = category === 'currency' || category === 'items' || category === 'top-ups';
  const amountNum = Math.max(1, Math.floor(Number(amount) || 1));
  // The game's server/region switch sits in the band (G2G style) when it is a short fixed list.
  const serverDef = category ? attributesFor(entry.game, category).find((d) => ['server', 'region'].includes(d.key) && d.type === 'select' && (d.options?.length ?? 0) <= 5) : undefined;
  const serverKey = serverDef ? `attr.${serverDef.key}` : '';

  return (
    <div className="stack pg-game">
      <section className="pg-band">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/games">{t('game.crumb')}</Link><span>/</span>
          {category ? <><Link to={`/games/${slug}`}>{entry.game}</Link><span>/</span><span>{categoryLabel(category)}</span></> : <span>{entry.game}</span>}
        </nav>
        <div className="pg-band-head">
          <div className="pg-band-title">
            <GameArt game={entry.game} size="sm" className="pg-tile" />
            <div className="min-w-0">
              <h1>{entry.game}{category ? ` · ${categoryLabel(category)}` : ''}</h1>
              <span className="muted">
                {t('offers.count', { count: entry.offers })} · {t('game.sellers', { count: entry.sellers })} · {t('offers.from', { price: price(entry.min_price_cents) })}
                {entry.instant > 0 && <> · <Zap className="inline size-3.5" aria-hidden /> {t('game.instant', { n: entry.instant })}</>}
              </span>
            </div>
          </div>
          {serverDef && (
            <div className="pg-seg" role="group" aria-label={attrLabel(serverDef.label)}>
              <button type="button" aria-pressed={!get(serverKey)} onClick={() => set(serverKey, '')}>{t('game.allServers')}</button>
              {serverDef.options!.map((o) => (
                <button key={o} type="button" aria-pressed={get(serverKey) === o} onClick={() => set(serverKey, o)}>{o}</button>
              ))}
            </div>
          )}
        </div>
        <nav className="pg-tabs" aria-label={entry.game}>
          <NavLink to={`/games/${slug}`} end>{t('game.allOffers')} <span className="count">{entry.offers}</span></NavLink>
          {tabs.map((s) => {
            const Icon = CATEGORY_ICON[s]!;
            return (
              <NavLink key={s} to={`/games/${slug}/${s}`}>
                <Icon className="size-4" aria-hidden /> {categoryLabel(s)} <span className="count">{entry.categories.find((c) => c.slug === s)!.count}</span>
              </NavLink>
            );
          })}
        </nav>
      </section>

      <div className="pg-browse">
        <aside className="pg-side">
          {unitWord && (
            <div className="card pg-amount">
              <label htmlFor="pg-amount">{t('game.howMany')}</label>
              <input id="pg-amount" className="num" type="number" min={1} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="small muted">{t('game.howMany.hint')}</span>
            </div>
          )}
          <label className="relative block">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label={t('game.searchIn', { game: entry.game })}
              placeholder={t('game.searchIn', { game: entry.game })}
              defaultValue={get('q')}
              key={slug}
              onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value.trim())}
              onBlur={(e) => e.target.value.trim() !== get('q') && set('q', e.target.value.trim())}
              style={{ paddingInlineStart: 34 }}
            />
          </label>
          {category && <AttributeFilters game={entry.game} category={category} skip={serverDef?.key} facets={facets} params={params} set={set} clear={(keys) => { const next = new URLSearchParams(params); keys.forEach((k) => next.delete(k)); setParams(next, { replace: true }); }} />}
          <fieldset className="pg-opts">
            <legend className="pg-label">{t('table.delivery')}</legend>
            <label><input type="checkbox" checked={get('delivery') === 'instant'} onChange={(e) => set('delivery', e.target.checked ? 'instant' : '')} /> {t('filter.instant')}</label>
          </fieldset>
          <fieldset className="pg-opts">
            <legend className="pg-label">{t('table.seller')}</legend>
            <label><input type="checkbox" checked={get('minRating') === '4.8'} onChange={(e) => set('minRating', e.target.checked ? '4.8' : '')} /> {t('filter.rated')}</label>
            {(!category || category === 'accounts') && (
              <label><input type="checkbox" checked={get('ownerVerified') === 'true'} onChange={(e) => set('ownerVerified', e.target.checked ? 'true' : '')} /> {t('filter.ownerVerified')}</label>
            )}
          </fieldset>
          {meta && (
            <p className="pg-protect small muted">
              {meta.protection === '14d' ? <BadgeCheck className="size-4 shrink-0" aria-hidden /> : <ShieldCheck className="size-4 shrink-0" aria-hidden />}
              <span>{meta.protection === '14d' ? t('game.protect14') : t('game.protect72')}</span>
            </p>
          )}
        </aside>

        <section className="pg-results">
          {error && <div className="alert" role="alert">{error}</div>}
          {offers === null ? (
            <p className="muted">{t('game.loadingOffers')}</p>
          ) : (
            <>
              <div className="pg-toolbar">
                <span className="small muted">
                  {t('offers.count', { count: total })}{prices.length > 1 ? ` · ${price(Math.min(...prices))} – ${price(Math.max(...prices))}` : ''}
                </span>
                <label className="pg-sort small">
                  {t('sort.label')}
                  <select aria-label={t('sort.label')} value={sort} onChange={(e) => set('sort', e.target.value)}>
                    {SORTS.map((k) => <option key={k} value={k}>{t(`sort.${k}` as MessageKey)}</option>)}
                  </select>
                </label>
              </div>
              <OfferTable
                offers={offers}
                showGame={!category}
                amount={unitWord ? amountNum : undefined}
                empty={
                  <>
                    {t('game.noMatch')}{' '}
                    <button className="cursor-pointer border-0 bg-transparent p-0 underline" onClick={() => nav(`/games/${slug}${category ? `/${category}` : ''}`)}>{t('game.clear')}</button>
                  </>
                }
              />
              {hasMore && <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={more}>{t('game.more')}</button>}
              <div className="pg-after small muted">
                <span>
                  {t('req.cta')}{' '}
                  <Link to={`/requests/new?${new URLSearchParams({ game: entry.game, ...(category ? { category } : {}) })}`}>{t('req.post')}</Link>
                  {' · '}
                  <Link to="/sell">{t('game.sellThis', { game: entry.game, what: category ? categoryLabel(category) : t('game.items') })}</Link>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <SaveSearchButton params={paramsFromUrl(params, { game: entry.game, ...(category ? { category } : {}) })} name={category ? `${entry.game} · ${categoryLabel(category)}` : entry.game} />
                  <WatchButton
                    label={category ? t('game.alertLows') : t('game.watch', { game: entry.game })}
                    target={{
                      game: entry.game,
                      category: category || undefined,
                      attributes: category ? Object.fromEntries([...params].filter(([k, v]) => k.startsWith('attr.') && v).map(([k, v]) => [k.slice(5), v])) : undefined,
                    }}
                  />
                </span>
              </div>
              {category && <MarketPriceHistory game={entry.game} category={category} />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Server / region / platform / rank pickers for one game and category, G2G-style. Each option
 * shows how many live offers it has given the other filters; options with none are still listed
 * (greyed) so the full range is visible.
 */
function AttributeFilters({ game, category, skip, facets, params, set, clear }: { game: string; category: string; skip?: string; facets: AttrFacet[]; params: URLSearchParams; set: (k: string, v: string) => void; clear: (keys: string[]) => void }) {
  const defs = attributesFor(game, category).filter((d) => d.key !== skip);
  if (!defs.length) return null;
  const active = defs.filter((d) => params.get(`attr.${d.key}`));
  return (
    <div className="pg-attrs" role="group" aria-label={t('market.filters')}>
      {defs.map((d) => {
        const counts = new Map(facets.filter((f) => f.key === d.key).map((f) => [f.value, f.count]));
        // Free-text fields (e.g. a WoW realm) offer the values sellers have used.
        const options = d.type === 'select' ? [...d.options!] : [...counts.keys()].sort();
        const cur = params.get(`attr.${d.key}`) ?? '';
        if (!options.length && !cur) return null;
        return (
          <label key={d.key} className="pg-attr">
            {attrLabel(d.label)}
            <select
              value={cur}
              onChange={(e) => set(`attr.${d.key}`, e.target.value)}
              className={cn(cur && 'border-foreground')}
            >
              <option value="">{t('attr.any', { label: attrLabel(d.label).toLowerCase() })}</option>
              {options.map((o) => {
                const n = counts.get(o) ?? 0;
                return <option key={o} value={o} disabled={!n && o !== cur}>{o}{` (${n})`}</option>;
              })}
            </select>
          </label>
        );
      })}
      {active.length > 0 && (
        <button type="button" className="btn ghost sm" onClick={() => clear(active.map((d) => `attr.${d.key}`))}>
          {active.length === 1 ? t('attr.clearOne', { label: attrLabel(active[0]!.label).toLowerCase() }) : t('game.clear')}
        </button>
      )}
    </div>
  );
}
