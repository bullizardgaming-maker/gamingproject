import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api';
import { useSession } from '../session';
import { OfferBadges, type Offer } from './Market';
import { Avatar, DeliveryTag, GameArt, OfferTable, Rating, TrustBadge } from '../components/CatalogUi';
import { categoryLabel, slugify } from '@/lib/catalog';
import { usePrice } from '@/lib/prefs';
import { usePageMeta } from '@/lib/seo';
import { attributePairs } from '@/lib/attributes';
import { WatchButton } from '../components/WatchButton';
import { unitPriceFor } from '@/lib/tiers';
import { OnlineDot, replyLabel } from '@/lib/presence';
import { addToCart } from '@/lib/cart';
import { ShoppingCart } from 'lucide-react';
import { OfferPriceHistory } from '../components/PriceHistory';
import { AlsoBought } from '../components/AlsoBought';
import { CharacterField, handoverFieldFor } from '../components/CharacterField';
import { intlLocale, t } from '../i18n';

export function OfferPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useSession();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [qty, setQty] = useState(1);
  const [rail, setRail] = useState<'fiat' | 'crypto'>('fiat');
  const [wallet, setWallet] = useState('');
  const [tos, setTos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState<Offer[]>([]);
  const [added, setAdded] = useState<'' | 'ok' | 'full'>('');
  const [codeText, setCodeText] = useState('');
  const [code, setCode] = useState<{ code: string; discount: number; qty: number } | null>(null);
  const [codeError, setCodeError] = useState('');
  const [character, setCharacter] = useState({ value: '', ok: false });
  const price = usePrice();
  usePageMeta({ title: offer?.title, description: offer ? `${offer.title} — ${offer.game}. Paid into escrow, released only after delivery checks out.` : undefined });

  useEffect(() => {
    setOffer(null);
    api<Offer>(`/offers/${id}`).then(setOffer).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (!offer) return;
    const q = new URLSearchParams({ game: offer.game, category: offer.category_slug, sort: 'price_asc', pageSize: '6' });
    api<{ items: Offer[] }>(`/offers?${q}`).then((r) => setSimilar(r.items.filter((o) => o.id !== offer.id).slice(0, 5))).catch(() => {});
  }, [offer]);

  if (!offer) return <p className="muted">{error || t('offer.loading')}</p>;
  const isAccount = offer.category_kind === 'account';
  const tiers = isAccount ? [] : offer.price_tiers ?? [];
  const unit = unitPriceFor(offer, qty);
  const total = unit * qty - (code && code.qty === qty ? code.discount : 0);
  const onSale = offer.regular_price_cents != null && offer.regular_price_cents > offer.price_cents;
  const own = user?.id === offer.seller_id;
  const needsCharacter = !!handoverFieldFor(offer.game, offer.category_slug);

  const buy = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ order: { id: string }; checkoutUrl: string | null }>('/orders', {
        body: { offerId: offer.id, quantity: qty, rail, acceptTos: true, ...(rail === 'crypto' ? { walletAddress: wallet } : {}), ...(code ? { sellerCode: code.code } : {}), ...(needsCharacter ? { characterName: character.value.trim() } : {}) },
        headers: { 'Idempotency-Key': `${offer.id}:${qty}:${rail}:${Math.floor(Date.now() / 60_000)}` },
      });
      if (res.checkoutUrl) window.location.assign(res.checkoutUrl);
      else nav(`/orders/${res.order.id}`);
    } catch (e: any) {
      setError(e.code === 'kyc_required' ? t('offer.verifyFirst') : e.message);
      setBusy(false);
    }
  };

  const ask = async () => {
    const room = await api<{ id: string }>('/chat/rooms', { body: { offerId: offer.id } });
    nav(`/chat/${room.id}`);
  };

  const gameSlug = slugify(offer.game);
  return (
    <div className="stack">
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to="/games">{t('game.crumb')}</Link><span>/</span>
      <Link to={`/games/${gameSlug}`}>{offer.game}</Link><span>/</span>
      <Link to={`/games/${gameSlug}/${offer.category_slug}`}>{categoryLabel(offer.category_slug)}</Link>
    </nav>
    <div className="order-layout" style={{ marginTop: 0 }}>
      <div className="stack">
        <div className="flex items-center gap-3">
          <GameArt game={offer.game} size="sm" className="h-10 w-14 shrink-0 rounded-lg" />
          <div className="eyebrow" style={{ margin: 0 }}>{offer.game} · {categoryLabel(offer.category_slug)}</div>
        </div>
        <h1 style={{ fontSize: 40 }}>{offer.title}</h1>
        {offer.reserved_for && (
          <div className="notice small">
            {user?.id === offer.reserved_for ? t('req.reservedForYou') : t('req.reservedSeller')}{' '}
            {offer.request_id && <Link to={`/requests/${offer.request_id}`}>{t('req.viewRequest')}</Link>}
          </div>
        )}
        <div className="row" style={{ gap: 12 }}>
          <OfferBadges offer={offer} />
          <DeliveryTag offer={offer} />
          {user?.id !== offer.seller_id && <WatchButton target={{ offerId: offer.id }} className="ms-auto" />}
        </div>
        {attributePairs(offer.game, offer.category_slug, offer.attributes).length > 0 && (
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-border bg-card p-4 sm:grid-cols-3">
            {attributePairs(offer.game, offer.category_slug, offer.attributes).map(([label, v]) => (
              <div key={label} className="min-w-0">
                <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
                <dd className="m-0 truncate font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <p style={{ whiteSpace: 'pre-wrap' }}>{offer.description || <span className="muted">{t('offer.noDescription')}</span>}</p>
        {offer.bundle && offer.bundle.length > 0 && (() => {
          const separately = offer.bundle.reduce((s, p) => s + p.price_cents * p.quantity, 0);
          return (
            <div className="card stack" style={{ gap: 8 }}>
              <b>{t('bundle.inside')}</b>
              <ul className="m-0 list-none p-0">
                {offer.bundle.map((p) => (
                  <li key={p.offer_id} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                    <span className="min-w-0 truncate"><span className="font-mono">{p.quantity}×</span> <Link to={`/offers/${p.offer_id}`}>{p.title}</Link></span>
                    <span className="font-mono text-sm text-muted-foreground">{money(p.price_cents * p.quantity, p.currency)}</span>
                  </li>
                ))}
              </ul>
              {separately > offer.price_cents && (
                <div className="small text-released">{t('bundle.saving', { separately: money(separately, offer.currency), amount: money(separately - offer.price_cents, offer.currency) })}</div>
              )}
            </div>
          );
        })()}
        <Link to={`/sellers/${offer.seller_id}`} className="card flex items-center gap-3 no-underline hover:border-foreground" style={{ padding: 14 }}>
          <Avatar name={offer.seller_name} className="size-11" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-semibold">
              {offer.seller_name}
              {offer.seller_online && <span className="inline-flex items-center gap-1 text-xs font-medium text-released"><OnlineDot /> {t('presence.online')}</span>}
              <TrustBadge level={offer.seller_trust_level} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <Rating value={offer.seller_rating} count={offer.seller_review_count} />
              <span>{t('offer.completed', { n: offer.seller_completed_orders })}</span>
              <span>{t('offer.idVerified')}</span>
              {replyLabel(offer.seller_response_minutes) && <span>{replyLabel(offer.seller_response_minutes)}</span>}
            </div>
          </div>
          <span className="small muted">{t('offer.viewShop')}</span>
        </Link>
        {offer.high_risk_secondary && (
          <div className="alert">
            {t('offer.highRisk')}
          </div>
        )}
        <OfferPriceHistory offerId={offer.id} game={offer.game} />
      </div>

      <div className="card stack">
        <div className="row spread">
          <span className="stack" style={{ gap: 0 }}>
            {onSale && <span className="mono small muted line-through">{money(offer.regular_price_cents! * qty, offer.currency)}</span>}
            <span className="mono" style={{ fontSize: 28, fontWeight: 600 }}>{money(total, offer.currency)}</span>
            {onSale && offer.sale_ends_at && <span className="small text-released">{t('sale.endsOn', { when: new Date(offer.sale_ends_at).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</span>}
            {price(total, offer.currency).startsWith('≈') && <span className="small muted">{price(total, offer.currency)} · {t('offer.chargedIn', { currency: offer.currency })}</span>}
          </span>
          <span className="small muted">{t('offer.available', { n: offer.stock })}</span>
        </div>
        {!isAccount && (
          <label className="field">
            {t('offer.quantity')}
            <input type="number" min={1} max={offer.stock} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
          </label>
        )}
        {tiers.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="small muted">{t('tier.title')}</div>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('tier.title')}>
              {[{ minQty: 1, priceCents: offer.price_cents }, ...tiers].map((tr) => (
                <button
                  key={tr.minQty}
                  type="button"
                  className={`chip cursor-pointer ${unit === tr.priceCents && qty >= tr.minQty ? 'released' : ''}`}
                  onClick={() => setQty(tr.minQty)}
                >
                  {t('tier.row', { qty: tr.minQty, price: money(tr.priceCents, offer.currency) })}
                </button>
              ))}
            </div>
            {unit < offer.price_cents && <div className="small text-released">{t('tier.saving', { amount: money((offer.price_cents - unit) * qty, offer.currency), each: money(unit, offer.currency) })}</div>}
          </div>
        )}
        {user && !own && rail === 'fiat' && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input aria-label={t('code.enter')} placeholder={t('code.enter')} value={codeText} onChange={(e) => setCodeText(e.target.value)} style={{ flex: 1 }} />
              <button
                type="button"
                className="btn ghost"
                disabled={!codeText.trim()}
                onClick={async () => {
                  setCodeError('');
                  try {
                    const q = await api<{ sellerDiscountCents: number }>('/orders/quote', { body: { offerId: offer.id, quantity: qty, sellerCode: codeText.trim() } });
                    setCode({ code: codeText.trim(), discount: q.sellerDiscountCents, qty });
                  } catch (e: any) {
                    setCode(null);
                    setCodeError(e.message);
                  }
                }}
              >
                {t('code.apply')}
              </button>
            </div>
            {code && code.qty === qty && <div className="small text-released">{t('code.applied', { code: code.code.toUpperCase(), amount: money(code.discount, offer.currency) })}</div>}
            {code && code.qty !== qty && <div className="small muted">{t('code.reapply')}</div>}
            {codeError && <div className="small" style={{ color: 'var(--disputed)' }}>{codeError}</div>}
          </div>
        )}
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>{t('offer.payWith')}</legend>
          <label className="row"><input type="radio" style={{ width: 'auto' }} checked={rail === 'fiat'} onChange={() => setRail('fiat')} /> {t('offer.card')}</label>
          <label className="row"><input type="radio" style={{ width: 'auto' }} checked={rail === 'crypto'} onChange={() => setRail('crypto')} /> {t('offer.crypto')}</label>
          {rail === 'crypto' && (
            <label className="field">
              {t('offer.wallet')}
              <input className="mono" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} />
            </label>
          )}
        </fieldset>
        {user && !own && <CharacterField game={offer.game} category={offer.category_slug} value={character.value} onChange={(value, ok) => setCharacter({ value, ok })} />}
        <div className="notice">
          {isAccount ? t('offer.escrow14') : t('offer.escrow72')}
        </div>
        <label className="check-row small">
          <input type="checkbox" style={{ width: 'auto' }} checked={tos} onChange={(e) => setTos(e.target.checked)} />
          {t('offer.tos')}
        </label>
        {added === 'ok' && <div className="notice small" role="status">{t('cart.added')} <Link to="/cart">{t('cart.view')}</Link></div>}
        {added === 'full' && <div className="alert small">{t('cart.full')}</div>}
        {error && <div className="alert" role="alert">{error} {error === t('offer.verifyFirst') && <Link to="/account">{t('offer.verifyNow')}</Link>}</div>}
        {!user ? (
          <div className="row">
            <Link className="btn go" to={`/login?next=/offers/${offer.id}`}>{t('offer.signInToBuy')}</Link>
            <button className="btn ghost" disabled={offer.stock < qty} onClick={() => setAdded(addToCart(offer.id, isAccount ? 1 : qty) ? 'ok' : 'full')}>
              <ShoppingCart className="size-4" /> {t('cart.add')}
            </button>
          </div>
        ) : own ? (
          <p className="muted small">{t('offer.yours')}</p>
        ) : (
          <div className="row">
            <button className="btn go" disabled={!tos || busy || offer.stock < qty || (needsCharacter && !character.ok) || (rail === 'crypto' && !/^0x[0-9a-fA-F]{40}$/.test(wallet))} onClick={buy}>
              {busy ? t('offer.opening') : t('offer.pay', { amount: money(total, offer.currency) })}
            </button>
            {rail === 'fiat' && (
              <button
                className="btn ghost"
                disabled={offer.stock < qty}
                onClick={() => setAdded(addToCart(offer.id, isAccount ? 1 : qty) ? 'ok' : 'full')}
              >
                <ShoppingCart className="size-4" /> {t('cart.add')}
              </button>
            )}
            <button className="btn ghost" onClick={ask}>{t('offer.ask')}</button>
          </div>
        )}
      </div>
    </div>
    {similar.length > 0 && (
      <section className="stack" style={{ marginTop: 32 }}>
        <div className="row spread">
          <h3 style={{ margin: 0 }}>{t('offer.compare', { game: offer.game, category: categoryLabel(offer.category_slug).toLowerCase() })}</h3>
          <Link to={`/games/${gameSlug}/${offer.category_slug}`} className="small">{t('home.seeAll')}</Link>
        </div>
        <OfferTable offers={similar} />
      </section>
    )}
    <AlsoBought offerId={offer.id} game={offer.game} />
    </div>
  );
}
