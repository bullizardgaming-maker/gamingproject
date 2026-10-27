import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SealCheck as BadgeCheck, Star, ThumbsDown, ThumbsUp } from '@phosphor-icons/react';
import { api, assetUrl } from '../api';
import { DeliveryTag, FoundingBadge, SellerAvatar, TrustBadge, fmtUnits } from '../components/CatalogUi';
import { categoryLabel } from '@/lib/catalog';
import { usePrice } from '@/lib/prefs';
import type { Offer } from './Market';
import { usePageMeta } from '@/lib/seo';
import { lastSeenLabel, replyLabel } from '@/lib/presence';
import { intlLocale, t } from '../i18n';
import { StorefrontEditor, languageName } from '../components/StorefrontEditor';
import { PresenceSettings } from './Sell';
import { useSession } from '../session';

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
  founding?: boolean;
  last_seen_at?: string | null;
  response_minutes?: number | null;
  shop_paused: boolean;
  shop_paused_until: string | null;
  shop_pause_message: string | null;
  rating: { average: number | string | null; count: number; positive_pct: number | string | null };
  storefront?: { intro: string; accent: string; banner_url: string | null; pinned: Offer[]; languages?: string[] };
  badges?: string[];
  reviews: Array<{ id: string; rating: number; comment: string; seller_reply: string | null; created_at: string; buyer_name: string; offer_title: string | null }>;
}

const since = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'long', year: 'numeric' });
const ago = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (d >= 30) return new Date(iso).toLocaleDateString(intlLocale());
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(-Math.min(d, 29), 'day');
};

/** A seller's public shop, G2G-style: one plain profile box, offers as cards, reviews as cards. */
export function SellerPage() {
  const { id = '' } = useParams();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [tab, setTab] = useState<'offers' | 'reviews'>('offers');
  const [game, setGame] = useState('');
  const [error, setError] = useState('');
  const { user } = useSession();
  const own = user?.id === id;
  const [editing, setEditing] = useState(false);
  const [shopSettings, setShopSettings] = useState<any>(undefined);
  useEffect(() => {
    if (own && editing && shopSettings === undefined) api<any>('/seller/dashboard').then((d) => setShopSettings(d.shop ?? null)).catch(() => setShopSettings(null));
  }, [own, editing, shopSettings]);

  useEffect(() => {
    setProfile(null);
    setOffers(null);
    api<Profile>(`/sellers/${id}?limit=30`).then(setProfile).catch((e) => setError(e.message));
    api<{ items: Offer[] }>(`/offers?seller=${id}&pageSize=60&sort=best_selling`).then((r) => setOffers(r.items)).catch(() => setOffers([]));
  }, [id, editing]); // leaving edit mode reloads the shop with the changes

  usePageMeta({
    title: profile ? `${profile.display_name} — seller` : undefined,
    description: profile ? `${profile.display_name} on Bullizard: ${profile.completed_orders} completed orders, ${profile.active_listings} live offers.` : undefined,
  });
  const games = useMemo(() => {
    const m = new Map<string, number>();
    // The categories the seller lists in: "Albion Online · Currency".
    for (const o of offers ?? []) { const k = `${o.game} · ${categoryLabel(o.category_slug)}`; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [offers]);

  if (!profile) return <p className="muted">{error || t('sp.loading')}</p>;
  const r = profile.rating;
  const shown = (offers ?? []).filter((o) => !game || `${o.game} · ${categoryLabel(o.category_slug)}` === game);
  const shop = profile.storefront;
  const reply = replyLabel(profile.response_minutes);

  return (
    <div className="stack sp">
      {shop?.banner_url && <img className="shop-banner" src={assetUrl(shop.banner_url)} alt={`${profile.display_name} shop banner`} />}
      <section className="card sp-head">
        <div className="sp-who">
          <SellerAvatar name={profile.display_name} online={profile.online} size="size-20 text-2xl" className="sp-avatar" />
          <h1 className="sp-name">{profile.display_name}</h1>
        </div>
        <div className="sp-meta">
            <div className="sp-badges">
              {profile.identity_verified && <span className="rank"><BadgeCheck className="size-3" aria-hidden /> {t('badge.idVerified')}</span>}
              <TrustBadge level={profile.trust_level} />
              {profile.founding && <FoundingBadge />}
            </div>
            <p className="sp-presence small">
              {!profile.online && lastSeenLabel(profile.last_seen_at) && <span className="presence">{lastSeenLabel(profile.last_seen_at)}</span>}
              {reply && <span className="muted">{reply}</span>}
              {!!shop?.languages?.length && <span className="muted">{t('sp.speaks', { list: shop.languages.map(languageName).join(', ') })}</span>}
            </p>
        </div>
        <dl className="sp-stats">
          <div><dt>{t('sp.positive')}</dt><dd className="num">{r.count ? `${Number(r.positive_pct)}%` : '—'}</dd></div>
          <div><dt>{t('sp.rating')}</dt><dd className="num"><Star className="size-4 text-held" weight="fill" aria-hidden /> {r.count ? Number(r.average).toFixed(2) : '—'} <span className="small muted">({r.count.toLocaleString()})</span></dd></div>
          <div><dt>{t('sp.sold')}</dt><dd className="num">{profile.completed_orders.toLocaleString()}</dd></div>
          {profile.on_time_delivery_pct != null && <div><dt>{t('sp.onTime')}</dt><dd className="num">{Number(profile.on_time_delivery_pct)}%</dd></div>}
          <div><dt>{t('sp.since')}</dt><dd>{since(profile.member_since)}</dd></div>
        </dl>
        {shop?.intro && <p className="sp-intro" dir="auto">{shop.intro}</p>}
        {own && <button type="button" className="btn ghost sm sp-edit" onClick={() => setEditing((e) => !e)}>{editing ? t('sp.done') : t('sp.edit')}</button>}
        {profile.shop_paused && <div className="notice">{profile.shop_pause_message || t('sp.paused')}</div>}
      </section>

      {own && editing && (
        <section className="stack sp-editor" aria-label={t('sp.edit')}>
          {shopSettings !== undefined && <PresenceSettings shop={shopSettings ?? undefined} />}
          <StorefrontEditor sellerId={id} />
        </section>
      )}
      {shop && shop.pinned.length > 0 && (
        <section className="stack" aria-labelledby="pinned-title" style={{ gap: 12 }}>
          <h2 id="pinned-title" className="sp-h2">{t('sp.featured')}</h2>
          <OfferCards offers={shop.pinned} />
        </section>
      )}

      <div className="sp-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'offers'} onClick={() => setTab('offers')}>
          {t('sp.offers')} <span className="muted">{profile.active_listings}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'reviews'} onClick={() => setTab('reviews')}>
          {t('sp.reviews')} <span className="muted">{r.count.toLocaleString()}</span>
        </button>
      </div>

      {tab === 'offers' ? (
        <>
          {games.length > 1 && (
            <div className="pg-seg sp-games" role="group" aria-label="Game">
              <button type="button" aria-pressed={!game} onClick={() => setGame('')}>{t('sp.allCats')}</button>
              {games.map(([g, n]) => (
                <button key={g} type="button" aria-pressed={game === g} onClick={() => setGame(g)}>{g} <span className="muted">{n}</span></button>
              ))}
            </div>
          )}
          {offers === null ? <p className="muted">{t('sp.loading')}</p> : shown.length === 0 ? <div className="card muted">{t('sp.noOffers')}</div> : <OfferCards offers={shown} />}
        </>
      ) : profile.reviews.length === 0 ? (
        <div className="card muted">{t('sp.noReviews')}</div>
      ) : (
        <>
          {r.count > profile.reviews.length && <p className="small muted" style={{ margin: 0 }}>{t('sp.showing', { n: profile.reviews.length, total: r.count.toLocaleString() })}</p>}
          <ul className="sp-reviews">
            {profile.reviews.map((rv) => {
              const good = rv.rating >= 4;
              return (
                <li key={rv.id} className="card sp-review">
                  <div className="sp-review-head">
                    <span className={good ? 'sp-thumb good' : 'sp-thumb bad'} role="img" aria-label={`${rv.rating} of 5`}>
                      {good ? <ThumbsUp className="size-4" weight="fill" aria-hidden /> : <ThumbsDown className="size-4" weight="fill" aria-hidden />}
                    </span>
                    <b className="text-sm">{rv.buyer_name} <span className="muted font-normal">· {t('reviews.verifiedBuyer')}</span></b>
                    <span className="small muted">{ago(rv.created_at)}</span>
                  </div>
                  {rv.offer_title && <span className="small muted" dir="auto">{rv.offer_title}</span>}
                  {rv.comment && <p dir="auto">{rv.comment}</p>}
                  {rv.seller_reply && (
                    <div className="sp-reply small"><b>{profile.display_name}:</b> {rv.seller_reply}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** Offer cards: game, title, delivery, stock and price; the whole card opens the offer. */
function OfferCards({ offers }: { offers: Offer[] }) {
  const price = usePrice();
  return (
    <ul className="sp-cards">
      {offers.map((o) => (
        <li key={o.id} className="sp-card">
          <span className="small muted">{o.game} · {categoryLabel(o.category_slug)}</span>
          <Link to={`/offers/${o.id}`} className="sp-card-title" dir="auto">{o.title}</Link>
          <div className="sp-card-meta small muted">
            <DeliveryTag offer={o} />
            <span className="num">{t('offer.inStock', { n: fmtUnits(o.stock, o.unit_label) })}</span>
          </div>
          <b className="sp-card-price num">{price.offer(o as any)}{o.unit_label && <span className="small muted"> / {o.unit_label}</span>}</b>
        </li>
      ))}
    </ul>
  );
}
