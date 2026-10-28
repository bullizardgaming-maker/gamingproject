import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { GameBanner } from '@/components/GameArt';
import { ArrowRight, MagnifyingGlass as Search, ShieldCheck, Lightning as Zap } from '@phosphor-icons/react';
import { api } from '../api';
import { CATEGORY_ICON, CategoriesRetry, CurrencyList, OfferTable, SellerFaces } from '../components/CatalogUi';
import { CATEGORY_META, categoryLabel, slugify, useCategoryOrder, useGames, type GameEntry } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { usePrice } from '@/lib/prefs';
import type { Offer } from './Market';
import { usePageMeta } from '@/lib/seo';
import { attrLabel, attributesFor, type AttributeDef } from '@/lib/attributes';
import { intlLocale, t, type MessageKey } from '../i18n';
import { WatchButton } from '../components/WatchButton';
import { recordBrowse } from '@/lib/recent';

type AttrFacet = { key: string; value: string; count: number };
/** GET /games/:slug/servers (Round 25, B1). */
export interface ServerSummary {
  name: string;
  offers: number;
  sellers: Array<{ id: string; name: string; avatar: string | null }>;
  sellers_count: number;
  sold: number;
  from_unit_price: string | null;
  from_unit_price_micros: number | null;
}


const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** Launch games with an SEO page (copy deck §6): title tag, description, H1, intro, FAQ. */
const SEO_SLUGS = ['aion', 'aion-2', 'albion-online', 'path-of-exile', 'path-of-exile-2'] as const;
type SeoSlug = (typeof SEO_SLUGS)[number];
const seoSlug = (slug: string): SeoSlug | null => (SEO_SLUGS as readonly string[]).includes(slug) ? (slug as SeoSlug) : null;
const seoKey = (slug: SeoSlug, field: 'title' | 'description' | 'h1' | 'intro' | 'buy' | 'servers') => `seo.${slug}.${field}` as MessageKey;

const letterOf = (g: string) => (/^[a-z]/i.test(g) ? g[0]!.toUpperCase() : '#');

/** /games: every game with live offers, A–Z, each with direct links into its categories. */
export function Games() {
  const categoryOrder = useCategoryOrder();
  usePageMeta({ title: t('games.title'), description: t('home.meta') });
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
      <CategoriesRetry />
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
  useEffect(() => {
    if (entry) recordBrowse(entry.game, category || undefined);
  }, [entry?.game, category]);
  const seo = seoSlug(slug);
  usePageMeta({
    title: entry ? (seo && !category ? t(seoKey(seo, 'title')).replace(/\s*·\s*Bullizard$/, '') : `${entry.game} · ${category ? categoryLabel(category) : t('game.marketplace')}`) : undefined,
    description: entry
      ? seo
        ? t(seoKey(seo, 'description'))
        : `${entry.offers} ${entry.game} offers from ${entry.sellers} sellers${category ? ` in ${categoryLabel(category).toLowerCase()}` : ''}. Compare price, delivery time and seller rating; every order is held until it's checked.`
      : undefined,
  });
  const get = (k: string) => params.get(k) ?? '';
  const sort = get('sort') || (category === 'currency' ? 'recommended' : 'price_asc');

  const query = useMemo(() => {
    if (!entry || !category) return null;
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

  // Currency: the buyer picks a server (or league) first; every option shows its offers and lowest price.
  const pickDef: AttributeDef | undefined = category === 'currency' && entry ? attributesFor(entry.game, category)[0] : undefined;
  const picked = pickDef ? get(`attr.${pickDef.key}`) : '';
  // Round 25 (B1): one call lists every server with its offers, sellers, sales and lowest unit price (no paging).
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [serversError, setServersError] = useState(false);
  const [serversTry, setServersTry] = useState(0);
  useEffect(() => {
    if (!entry || !pickDef) return setServers(null);
    let stale = false;
    setServers(null);
    setServersError(false);
    api<ServerSummary[]>(`/games/${slug}/servers?${new URLSearchParams({ category })}`)
      .then((r) => { if (!stale) setServers(r); })
      .catch(() => { if (!stale) (setServers([]), setServersError(true)); });
    return () => { stale = true; };
  }, [entry?.game, slug, category, pickDef?.key, serversTry]);

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

  const unitWord = category === 'items' || category === 'top-ups';
  const shownOffers = (offers ?? []).filter((o) => get('online') !== '1' || o.seller_online);
  const amountNum = Math.max(1, Math.floor(Number(amount) || 1));

  return (
    <div className="stack pg-game">
      <section className="pg-band">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/games">{t('game.crumb')}</Link><span>/</span>
          {category ? <><Link to={`/games/${slug}`}>{entry.game}</Link><span>/</span><span>{categoryLabel(category)}</span></> : <span>{entry.game}</span>}
        </nav>
        <div className="pg-band-head">
          <div className="min-w-0">
            <h1>{seo && !category ? t(seoKey(seo, 'h1')) : `${entry.game}${category ? ` · ${categoryLabel(category)}` : ''}`}</h1>
            {seo && !category && <p className="pg-seo-intro" style={{ margin: '0 0 8px', maxWidth: 640 }}>{t(seoKey(seo, 'intro'))}</p>}
            <span className="muted">
              {t('offers.count', { count: entry.offers })} · {t('game.sellers', { count: entry.sellers })} · {t('offers.from', { price: price(entry.min_price_cents) })}
            </span>
          </div>
          <GameBanner game={entry.game} height={120} className="pg-game-banner" />
        </div>
        {category && (
          <nav className="pg-tabs" aria-label={entry.game}>
            {tabs.map((s) => {
              const Icon = CATEGORY_ICON[s]!;
              return (
                <NavLink key={s} to={`/games/${slug}/${s}`}>
                  <Icon className="size-4" aria-hidden /> {categoryLabel(s)} <span className="count">{entry.categories.find((c) => c.slug === s)!.count}</span>
                </NavLink>
              );
            })}
          </nav>
        )}
      </section>

      {!category ? (
        <section className="card pg-cats" aria-labelledby="pg-cats-title">
          <h2 id="pg-cats-title" className="pg-cats-title">{t('game.pickCategory')}</h2>
          <div className="pg-cats-list">
            {tabs.map((s) => {
              const Icon = CATEGORY_ICON[s]!;
              return (
                <Link key={s} to={`/games/${slug}/${s}`} className="pg-cat">
                  <Icon className="size-[18px]" aria-hidden /> {categoryLabel(s)} <span className="count">{entry.categories.find((c) => c.slug === s)!.count}</span>
                </Link>
              );
            })}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {t('req.cta')}{' '}
            <Link to={`/requests/new?${new URLSearchParams({ game: entry.game })}`}>{t('req.post')}</Link>
          </p>
          {seo && (
            <div className="stack" style={{ gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{t('seo.buy.title')}</h3>
              <p style={{ margin: 0 }}>{t(seoKey(seo, 'buy'))}</p>
              <p className="muted" style={{ margin: 0 }}>{t(seoKey(seo, 'servers'))}</p>
            </div>
          )}
        </section>
      ) : category === 'currency' && pickDef && !picked ? (
        <section className="srv" aria-labelledby="srv-title">
          <h2 id="srv-title" className="srv-title">{pickDef.key === 'league' ? t('srv.pickLeague') : t('srv.pickServer')}</h2>
          {servers === null ? (
            <p className="muted">{t('game.loadingOffers')}</p>
          ) : serversError ? (
            <div className="alert" role="alert">{t('srv.loadFailed')} <button type="button" className="btn ghost sm" onClick={() => setServersTry((n) => n + 1)}>{t('catalog.retry')}</button></div>
          ) : (
            <ul className="srv-grid">
              {servers.map((sv) => (
                <li key={sv.name}>
                  <button type="button" className="srv-card" disabled={!sv.offers} onClick={() => set(`attr.${pickDef.key}`, sv.name)}>
                    <img className="srv-cover" src={`/games/${slug}.webp`} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                    <span className="srv-top">
                      <b className="srv-name">{entry.game} {sv.name}</b>
                      {sv.sold > 0 && <span className="srv-sold num">{t('ct.sold', { n: sv.sold.toLocaleString(intlLocale()) })}</span>}
                      <span className="srv-mid">
                        <SellerFaces sellers={sv.sellers} total={sv.sellers_count} />
                        <span className="srv-count"><b className="num">{t('offers.count', { count: sv.offers })}</b><span className="small muted">{t('srv.available')}</span></span>
                      </span>
                    </span>
                    <span className="srv-bottom">
                      {sv.from_unit_price_micros != null ? (
                        <span className="srv-price"><span className="small muted">{t('ct.from')}</span><span><b className="num">{price.unit(sv.from_unit_price_micros)}</b></span></span>
                      ) : (
                        <span className="small muted">{t('srv.none')}</span>
                      )}
                      <span className="srv-go" aria-hidden><ArrowRight className="size-5 rtl:rotate-180" /></span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : category === 'currency' ? (
        <section className="ct-wrap" aria-labelledby="ct-title">
          <div className="ct-bar">
            {pickDef && (
              <span className="srv-picked">
                <span className="small muted">{attrLabel(pickDef.label)}</span>
                <b>{picked}</b>
                <button type="button" className="btn ghost sm" onClick={() => set(`attr.${pickDef.key}`, '')}>{t('srv.change')}</button>
              </span>
            )}
            <AttributeFilters game={entry.game} category={category} facets={facets} params={params} set={set} skip={pickDef?.key} clear={(keys) => { const next = new URLSearchParams(params); keys.forEach((k) => next.delete(k)); setParams(next, { replace: true }); }} />
            <label className="ct-toggle">
              <input type="checkbox" role="switch" checked={get('online') === '1'} onChange={(e) => set('online', e.target.checked ? '1' : '')} />
              <span>{t('ct.onlineOnly')}</span>
            </label>
            <span className="ct-sell row" style={{ gap: 8, height: 'auto' }}>
              <Link className="btn ghost sm" to="/sell">{t('ct.sell', { game: entry.game, what: categoryLabel(category).toLowerCase() })}</Link>
            </span>
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
          {offers === null ? (
            <p className="muted">{t('game.loadingOffers')}</p>
          ) : (
            <>
              <div className="ct-head">
                <h2 id="ct-title">{t('ct.count', { n: shownOffers.length })}</h2>
                <div className="pg-seg" role="group" aria-label={t('sort.label')}>
                  {([['recommended', 'ct.sort.recommended'], ['price_asc', 'ct.sort.cheapest'], ['min_qty_asc', 'ct.sort.minQty']] as const).map(([k, label]) => (
                    <button key={k} type="button" aria-pressed={sort === k} onClick={() => set('sort', k)}>{t(label)}</button>
                  ))}
                </div>
              </div>
              <CurrencyList
                offers={shownOffers}
                empty={<>{t('game.noMatch')} <button className="cursor-pointer border-0 bg-transparent p-0 underline" onClick={() => nav(`/games/${slug}/${category}`)}>{t('game.clear')}</button></>}
              />
              {hasMore && <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={more}>{t('game.more')}</button>}
              {pickDef && servers?.some((sv) => sv.name !== picked && sv.offers) && (
                <section className="srv-other" aria-labelledby="srv-other-title">
                  <h3 id="srv-other-title">{pickDef.key === 'league' ? t('srv.otherLeagues') : t('srv.otherServers')}</h3>
                  <div className="srv-chips">
                    {servers!.filter((sv) => sv.name !== picked && sv.offers).map((sv) => (
                      <button key={sv.name} type="button" className="srv-chip" onClick={() => { set(`attr.${pickDef.key}`, sv.name); window.scrollTo({ top: 0 }); }}>
                        <b>{sv.name}</b> {sv.from_unit_price_micros != null && <span className="small muted num">{t('srv.from', { price: price.unit(sv.from_unit_price_micros) })}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <p className="small muted" style={{ margin: 0 }}>
                {t('req.cta')} <Link to={`/requests/new?${new URLSearchParams({ game: entry.game, category })}`}>{t('req.post')}</Link>
              </p>
            </>
          )}
        </section>
      ) : (
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
          {<AttributeFilters game={entry.game} category={category} facets={facets} params={params} set={set} clear={(keys) => { const next = new URLSearchParams(params); keys.forEach((k) => next.delete(k)); setParams(next, { replace: true }); }} />}
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
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              <span>{t('offer.guaranteeText')}</span>
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
            </>
          )}
        </section>
      </div>
      )}
    </div>
  );
}

/**
 * Server / region / platform / rank pickers for one game and category, G2G-style. Each option
 * shows how many live offers it has given the other filters; options with none are still listed
 * (greyed) so the full range is visible.
 */
function AttributeFilters({ game, category, facets, params, set, clear, skip }: { game: string; category: string; facets: AttrFacet[]; params: URLSearchParams; set: (k: string, v: string) => void; clear: (keys: string[]) => void; skip?: string }) {
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
