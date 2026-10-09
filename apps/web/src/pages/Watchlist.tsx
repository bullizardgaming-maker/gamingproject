import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, Trash2 } from 'lucide-react';
import { money } from '../api';
import { useSession } from '../session';
import { GameArt } from '../components/CatalogUi';
import { WatchButton } from '../components/WatchButton';
import { reloadWatches, removeWatch, useWatches, type Watch } from '@/lib/watches';
import { attributePairs } from '@/lib/attributes';
import { categoryLabel, slugify } from '@/lib/catalog';
import { usePageMeta } from '@/lib/seo';
import { cn } from '@/lib/utils';

function where(w: Watch) {
  const pairs = w.category && w.game ? attributePairs(w.game, w.category, w.attributes).map(([, v]) => v) : [];
  return [w.category ? categoryLabel(w.category) : 'Everything', ...pairs].join(' · ');
}
function marketLink(w: Watch) {
  const q = new URLSearchParams(Object.entries(w.attributes ?? {}).map(([k, v]) => [`attr.${k}`, v]));
  return `/games/${slugify(w.game!)}${w.category ? `/${w.category}` : ''}${q.size ? `?${q}` : ''}`;
}

/** /watchlist: every listing and market the buyer follows, with current price against target. */
export function Watchlist() {
  usePageMeta({ title: 'Watchlist' });
  const { user } = useSession();
  const list = useWatches(user?.id);
  useEffect(() => {
    if (user) reloadWatches(); // prices move: refresh on every visit
  }, [user]);

  if (!user) return <p className="muted"><Link to="/login?next=/watchlist">Sign in</Link> to see your watchlist.</p>;
  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <div>
        <div className="eyebrow">Price alerts</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>Watchlist</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          We check prices every few minutes and notify you once for each new low, or when a listing is back in stock.
        </p>
      </div>
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <div className="card stack" style={{ alignItems: 'start' }}>
          <BellRing className="size-6 text-muted-foreground" />
          <b>Nothing watched yet</b>
          <p className="muted" style={{ margin: 0 }}>Use “Price alert” on any listing, or on a game page to follow a whole market such as League of Legends boosting on EUW.</p>
          <Link className="btn" to="/games">Browse games</Link>
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
                      <span className="muted">This listing was removed</span>
                    )
                  ) : (
                    <>
                      <Link to={marketLink(w)} className="block truncate font-medium no-underline hover:underline">{w.game}</Link>
                      <div className="truncate text-xs text-muted-foreground">{where(w)}{w.cheapest ? ` · cheapest from ${w.cheapest.seller_name}` : ''}</div>
                    </>
                  )}
                </div>
                <div className="col-start-2 text-sm sm:col-start-auto sm:text-right">
                  <div className={cn('font-mono font-semibold', w.reached && 'text-released')}>
                    {w.currentCents != null && w.available ? money(w.currentCents, w.currency) : <span className="muted font-sans font-normal">{w.kind === 'offer' ? 'Out of stock' : 'No offers yet'}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {w.reached ? 'At or below your target' : w.targetCents != null ? `Target ${money(w.targetCents, w.currency)}` : w.startCents != null ? `Was ${money(w.startCents, w.currency)}` : 'Any new offer'}
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
    </div>
  );
}
