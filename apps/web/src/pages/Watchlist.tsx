import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, Search, Trash2 } from 'lucide-react';
import { api, money } from '../api';
import { useSession } from '../session';
import { GameArt } from '../components/CatalogUi';
import { WatchButton } from '../components/WatchButton';
import { reloadWatches, removeWatch, useWatches, type Watch } from '@/lib/watches';
import { attributePairs } from '@/lib/attributes';
import { categoryLabel, slugify } from '@/lib/catalog';
import { usePageMeta } from '@/lib/seo';
import { cn } from '@/lib/utils';
import { t } from '../i18n';

function where(w: Watch) {
  const pairs = w.category && w.game ? attributePairs(w.game, w.category, w.attributes).map(([, v]) => v) : [];
  return [w.category ? categoryLabel(w.category) : t('watch.everything'), ...pairs].join(' · ');
}
function marketLink(w: Watch) {
  const q = new URLSearchParams(Object.entries(w.attributes ?? {}).map(([k, v]) => [`attr.${k}`, v]));
  return `/games/${slugify(w.game!)}${w.category ? `/${w.category}` : ''}${q.size ? `?${q}` : ''}`;
}

/** /watchlist: every listing and market the buyer follows, with current price against target. */
export function Watchlist() {
  usePageMeta({ title: t('watch.page.title') });
  const { user } = useSession();
  const list = useWatches(user?.id);
  useEffect(() => {
    if (user) reloadWatches(); // prices move: refresh on every visit
  }, [user]);

  if (!user) return <p className="muted"><Link to="/login?next=/watchlist">{t('watch.page.signIn')}</Link></p>;
  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <div>
        <div className="eyebrow">{t('watch.page.eyebrow')}</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>{t('watch.page.title')}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          {t('watch.page.lede')}
        </p>
      </div>
      {list === null ? (
        <p className="muted">{t('common.loading')}</p>
      ) : list.length === 0 ? (
        <div className="card stack" style={{ alignItems: 'start' }}>
          <BellRing className="size-6 text-muted-foreground" />
          <b>{t('watch.page.empty')}</b>
          <p className="muted" style={{ margin: 0 }}>{t('watch.page.empty.text')}</p>
          <Link className="btn" to="/games">{t('watch.page.browse')}</Link>
        </div>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0">
          {list.map((w) => {
            const game = w.kind === 'offer' ? w.offer?.game : w.game;
            return (
              <li key={w.id} className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 border-b border-border px-4 py-3.5 last:border-b-0 sm:grid-cols-[auto_1fr_auto_auto]">
                {game ? <GameArt game={game} size="sm" className="h-10 w-14 rounded-lg" /> : <span className="h-10 w-14" />}
                <div className="min-w-0">
                  {w.kind === 'offer' ? (
                    w.offer ? (
                      <>
                        <Link to={`/offers/${w.offer.id}`} className="block truncate font-medium no-underline hover:underline">{w.offer.title}</Link>
                        <div className="truncate text-xs text-muted-foreground">{w.offer.game} · {w.offer.seller_name}</div>
                      </>
                    ) : (
                      <span className="muted">{t('watch.removed')}</span>
                    )
                  ) : (
                    <>
                      <Link to={marketLink(w)} className="block truncate font-medium no-underline hover:underline">{w.game}</Link>
                      <div className="truncate text-xs text-muted-foreground">{where(w)}{w.cheapest ? ` · ${t('watch.cheapestFrom', { seller: w.cheapest.seller_name })}` : ''}</div>
                    </>
                  )}
                </div>
                <div className="col-start-2 text-sm sm:col-start-auto sm:text-end">
                  <div className={cn('font-mono font-semibold', w.reached && 'text-released')}>
                    {w.currentCents != null && w.available ? money(w.currentCents, w.currency) : <span className="muted font-sans font-normal">{w.kind === 'offer' ? t('watch.outOfStock') : t('watch.noOffers')}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {w.reached ? t('watch.reached') : w.targetCents != null ? t('watch.targetIs', { price: money(w.targetCents, w.currency) }) : w.startCents != null ? t('watch.was', { price: money(w.startCents, w.currency) }) : t('watch.anyNew')}
                  </div>
                </div>
                <div className="col-start-2 flex items-center gap-2 sm:col-start-auto">
                  {w.kind === 'offer' && w.offer ? (
                    <WatchButton target={{ offerId: w.offer.id }} />
                  ) : w.kind === 'game' ? (
                    <WatchButton target={{ game: w.game!, category: w.category ?? undefined, attributes: w.attributes }} />
                  ) : (
                    <button className="btn ghost" aria-label="Remove" onClick={() => removeWatch(w.id)}><Trash2 className="size-4" /></button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SavedSearches />
    </div>
  );
}

interface SavedSearch { id: string; name: string; path: string; frequency: 'hourly' | 'daily'; last_sent_at: string | null }

/** Saved searches: digests of new listings matching saved filters. */
function SavedSearches() {
  const [list, setList] = useState<SavedSearch[] | null>(null);
  const load = () => void api<SavedSearch[]>('/me/saved-searches').then(setList).catch(() => setList([]));
  useEffect(load, []);
  return (
    <section className="stack" style={{ gap: 10, marginTop: 16 }}>
      <div>
        <h2 style={{ margin: 0 }}>{t('saved.title')}</h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>{t('saved.lede')}</p>
      </div>
      {list === null ? null : list.length === 0 ? (
        <p className="small muted">{t('saved.empty')}</p>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
              <Search className="size-4 text-muted-foreground" />
              <Link to={s.path} className="min-w-0 flex-1 truncate font-medium no-underline hover:underline">{s.name}</Link>
              <select aria-label={t('saved.frequency')} value={s.frequency} style={{ width: 150, height: 34, padding: '4px 8px' }}
                onChange={async (e) => (await api(`/me/saved-searches/${s.id}`, { method: 'PATCH', body: { frequency: e.target.value } }), load())}>
                <option value="daily">{t('saved.daily')}</option>
                <option value="hourly">{t('saved.hourly')}</option>
              </select>
              <button className="btn ghost" aria-label={t('saved.delete', { name: s.name })} onClick={async () => (await api(`/me/saved-searches/${s.id}`, { method: 'DELETE' }), load())}><Trash2 className="size-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
