import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BadgeCheck, CalendarDays, MessageCircle, PackageCheck, Star, Timer } from 'lucide-react';
import { api, assetUrl } from '../api';
import { Avatar, OfferTable, TrustBadge } from '../components/CatalogUi';
import { cn } from '@/lib/utils';
import type { Offer } from './Market';
import { usePageMeta } from '@/lib/seo';
import { OnlineDot, lastSeenLabel, replyLabel } from '@/lib/presence';
import { t } from '../i18n';

interface Profile {
  id: string;
  display_name: string;
  member_since: string;
  identity_verified: boolean;
  completed_orders: number;
  active_listings: number;
  on_time_delivery_pct: number | string | null;
  online?: boolean;
  trust_level?: string;
  last_seen_at?: string | null;
  response_minutes?: number | null;
  shop_paused: boolean;
  shop_paused_until: string | null;
  shop_pause_message: string | null;
  rating: { average: number | string | null; count: number; positive_pct: number | string | null };
  storefront?: { intro: string; accent: string; banner_url: string | null; pinned: Offer[] };
  reviews: Array<{ id: string; rating: number; comment: string; seller_reply: string | null; created_at: string; buyer_name: string; offer_title: string | null }>;
}

const since = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'long', year: 'numeric' });
const ago = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString();
};

/** A seller's public storefront: trust stats, every live listing grouped by game, and reviews. */
export function SellerPage() {
  const { id = '' } = useParams();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [tab, setTab] = useState<'offers' | 'reviews'>('offers');
  const [game, setGame] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setProfile(null);
    setOffers(null);
    api<Profile>(`/sellers/${id}?limit=30`).then(setProfile).catch((e) => setError(e.message));
    api<{ items: Offer[] }>(`/offers?seller=${id}&pageSize=60&sort=best_selling`).then((r) => setOffers(r.items)).catch(() => setOffers([]));
  }, [id]);

  usePageMeta({
    title: profile ? `${profile.display_name} — seller` : undefined,
    description: profile ? `${profile.display_name} on Bullizard: ${profile.completed_orders} completed orders, ${profile.active_listings} live offers.` : undefined,
  });
  const games = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of offers ?? []) m.set(o.game, (m.get(o.game) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [offers]);

  if (!profile) return <p className="muted">{error || 'Loading seller…'}</p>;
  const r = profile.rating;
  const shown = (offers ?? []).filter((o) => !game || o.game === game);

  const shop = profile.storefront;
  return (
    <div className="stack">
      {shop?.banner_url && <img className="shop-banner" src={assetUrl(shop.banner_url)} alt={`${profile.display_name} shop banner`} />}
      <div className="card seller-head" style={{ padding: 24, borderTop: `4px solid var(--shop-${shop?.accent ?? 'steel'})` }}>
        <Avatar name={profile.display_name} className="size-20 text-2xl" />
        <div className="min-w-0">
          <h1 style={{ fontSize: 36, margin: 0 }} className="flex flex-wrap items-center gap-2">
            {profile.display_name}
            {profile.identity_verified && (
              <span className="chip released"><BadgeCheck className="size-3.5" /> ID verified</span>
            )}
            <TrustBadge level={profile.trust_level} />
          </h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" /> Selling since {since(profile.member_since)}</span>
            <span className="inline-flex items-center gap-1.5"><PackageCheck className="size-4" /> {profile.completed_orders.toLocaleString()} completed orders</span>
            {profile.on_time_delivery_pct != null && <span className="inline-flex items-center gap-1.5"><Timer className="size-4" /> {Number(profile.on_time_delivery_pct)}% delivered on time</span>}
            {replyLabel(profile.response_minutes) && <span className="inline-flex items-center gap-1.5"><MessageCircle className="size-4" /> {replyLabel(profile.response_minutes)}</span>}
            {profile.online ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-released"><OnlineDot /> {t('presence.online')}</span>
            ) : (
              lastSeenLabel(profile.last_seen_at) && <span>{lastSeenLabel(profile.last_seen_at)}</span>
            )}
          </div>
          {shop?.intro && <p style={{ margin: '12px 0 0', maxWidth: '70ch', whiteSpace: 'pre-line' }}>{shop.intro}</p>}
          {profile.shop_paused && <div className="notice" style={{ marginTop: 12 }}>{profile.shop_pause_message || 'This shop is taking a short break.'}</div>}
        </div>
        <div className="rounded-xl border border-border bg-background px-5 py-3 text-center">
          <div className="flex items-center justify-center gap-1.5 font-mono text-3xl font-semibold">
            <Star className="size-6 fill-held text-held" />
            {r.count ? Number(r.average).toFixed(2) : '—'}
          </div>
          <div className="text-xs text-muted-foreground">
            {r.count ? `${r.count.toLocaleString()} reviews · ${Number(r.positive_pct)}% positive` : 'No reviews yet'}
          </div>
        </div>
      </div>

      {shop && shop.pinned.length > 0 && (
        <section className="stack" aria-labelledby="pinned-title" style={{ gap: 8 }}>
          <h2 id="pinned-title" style={{ fontSize: 20, margin: 0, borderInlineStart: `4px solid var(--shop-${shop.accent})`, paddingInlineStart: 10 }}>Featured</h2>
          <OfferTable offers={shop.pinned} showGame showSeller={false} />
        </section>
      )}

      <div className="game-tabs" role="tablist">
        <a href="#offers" role="tab" aria-selected={tab === 'offers'} className={cn(tab === 'offers' && 'active')} onClick={(e) => (e.preventDefault(), setTab('offers'))}>
          Offers <span className="count">{profile.active_listings}</span>
        </a>
        <a href="#reviews" role="tab" aria-selected={tab === 'reviews'} className={cn(tab === 'reviews' && 'active')} onClick={(e) => (e.preventDefault(), setTab('reviews'))}>
          Reviews <span className="count">{r.count.toLocaleString()}</span>
        </a>
      </div>

      {tab === 'offers' ? (
        <>
          {games.length > 1 && (
            <div className="filters" role="group" aria-label="Game" style={{ marginBottom: 0 }}>
              <button aria-pressed={!game} onClick={() => setGame('')}>All games</button>
              {games.map(([g, n]) => (
                <button key={g} aria-pressed={game === g} onClick={() => setGame(g)}>{g} <span className="muted">{n}</span></button>
              ))}
            </div>
          )}
          {offers === null ? <p className="muted">Loading offers…</p> : <OfferTable offers={shown} showGame showSeller={false} empty="This seller has no live offers right now." />}
        </>
      ) : profile.reviews.length === 0 ? (
        <div className="card muted">No written reviews yet.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {r.count > profile.reviews.length && (
            <p className="small muted" style={{ margin: 0, padding: '14px 20px', borderBottom: '1px solid var(--rule)' }}>
              Showing the {profile.reviews.length} most recent written reviews of {r.count.toLocaleString()}.
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {profile.reviews.map((rv) => (
              <li key={rv.id} className="border-b border-border px-5 py-4 last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex">
                    {Array.from({ length: 5 }, (_, i) => <Star key={i} className={cn('size-4', i < rv.rating ? 'fill-held text-held' : 'text-border')} />)}
                  </span>
                  <b className="text-sm">{rv.buyer_name}</b>
                  <span className="text-xs text-muted-foreground">{ago(rv.created_at)}</span>
                  {rv.offer_title && (
                    <span className="text-xs text-muted-foreground">
                      · bought {rv.offer_title}
                    </span>
                  )}
                </div>
                {rv.comment && <p style={{ margin: '6px 0 0' }}>{rv.comment}</p>}
                {rv.seller_reply && (
                  <div className="mt-2 border-s-2 border-border ps-3 text-sm text-muted-foreground">
                    <b className="text-foreground">{profile.display_name}:</b> {rv.seller_reply}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="small muted">Reviews can only be left by buyers who paid for and received an order. Ratings count every review, including ones without a comment.</p>
    </div>
  );
}
