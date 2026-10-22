import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { useSession } from '../session';
import { OfferBadges, type Offer } from './Market';
import { Avatar, DeliveryTag, FoundingBadge, OfferTable, RankPill, Rating, TrustBadge } from '../components/CatalogUi';
import { categoryLabel, slugify } from '@/lib/catalog';
import { usePrice } from '@/lib/prefs';
import { usePageMeta } from '@/lib/seo';
import { attributePairs } from '@/lib/attributes';
import { WatchButton } from '../components/WatchButton';
import { unitPriceFor } from '@/lib/tiers';
import { OnlineDot, replyLabel } from '@/lib/presence';
import { addToCart } from '@/lib/cart';
import { ChatCircle as MessageCircle, ShieldCheck, ShoppingCart } from '@phosphor-icons/react';
import { OfferPriceHistory } from '../components/PriceHistory';
import { AlsoBought } from '../components/AlsoBought';
import { CharacterField, handoverFieldFor } from '../components/CharacterField';
import { intlLocale, t } from '../i18n';

export function OfferPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useSession();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [params] = useSearchParams();
  const [qty, setQty] = useState(() => Math.max(1, Math.floor(Number(params.get('qty')) || 1)));
  // Payment is crypto through NOWPayments (the API's 'fiat' rail); the on-chain contract rail is not offered.
  const rail = 'fiat' as const;
  const [reviews, setReviews] = useState<Array<{ id: string; rating: number; comment: string; created_at: string; offer_title: string | null }>>([]);
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
    api<{ reviews: typeof reviews }>(`/sellers/${offer.seller_id}?limit=3`).then((r) => setReviews((r.reviews ?? []).slice(0, 3))).catch(() => {});
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
        body: { offerId: offer.id, quantity: qty, rail, acceptTos: true, useCredit: rail === 'fiat', ...(code ? { sellerCode: code.code } : {}), ...(needsCharacter ? { characterName: character.value.trim() } : {}) },
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
  const pairs = attributePairs(offer.game, offer.category_slug, offer.attributes);
  const addCart = () => setAdded(addToCart(offer.id, isAccount ? 1 : qty) ? 'ok' : 'full');
  const ago = (iso: string) => {
    const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(-d, 'day');
  };
  return (
    <div className="stack">
    <div className="pg-split" style={{ marginTop: 0 }}>
      <div className="pg-main stack">
        <nav className="crumbs" aria-label="Breadcrumb" style={{ margin: 0 }}>
          <Link to="/games">{t('game.crumb')}</Link><span>/</span>
          <Link to={`/games/${gameSlug}`}>{offer.game}</Link><span>/</span>
          <Link to={`/games/${gameSlug}/${offer.category_slug}`}>{categoryLabel(offer.category_slug)}</Link>
        </nav>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="pg-label">{offer.game} · {categoryLabel(offer.category_slug)}</div>
            <h1 className="pg-h1" style={{ marginTop: 6 }} dir="auto">{offer.title}</h1>
          </div>
          {user?.id !== offer.seller_id && <WatchButton target={{ offerId: offer.id }} />}
        </div>
        {offer.reserved_for && (
          <div className="notice small">
            {user?.id === offer.reserved_for ? t('req.reservedForYou') : t('req.reservedSeller')}{' '}
            {offer.request_id && <Link to={`/requests/${offer.request_id}`}>{t('req.viewRequest')}</Link>}
          </div>
        )}

        <div className="card pg-seller">
          <Avatar name={offer.seller_name} className="size-[52px] text-base" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/sellers/${offer.seller_id}`} className="no-underline hover:underline" style={{ fontSize: 17, fontWeight: 700 }}>{offer.seller_name}</Link>
              {offer.seller_rank && <RankPill name={offer.seller_rank} />}
              <TrustBadge level={offer.seller_trust_level} />
              {offer.seller_founding && <FoundingBadge />}
              {offer.seller_online && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><OnlineDot /> {t('presence.online')}</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[13px] text-muted-foreground">
              <Rating value={offer.seller_rating} count={offer.seller_review_count} />
              <span>{t('offer.completed', { n: offer.seller_completed_orders })}</span>
              <span>{t('offer.idVerified')}</span>
              {replyLabel(offer.seller_response_minutes) && <span>{replyLabel(offer.seller_response_minutes)}</span>}
            </div>
          </div>
          <Link className="btn ghost sm" to={`/sellers/${offer.seller_id}`}>{t('offer.sellerProfile')}</Link>
        </div>

        <div className="card">
          <div className="row spread" style={{ marginBottom: 16 }}>
            <p className="pg-label">{t('offer.details')}</p>
            <OfferBadges offer={offer} />
          </div>
          <dl className="pg-kv">
            {pairs.map(([label, v]) => (
              <div key={label} className="contents"><dt>{label}</dt><dd>{v}</dd></div>
            ))}
            <dt>{t('table.delivery')}</dt><dd><DeliveryTag offer={offer} /></dd>
            <dt>{t('table.stock')}</dt><dd className="num">{offer.stock}</dd>
            <dt>{t('offer.sellerNote')}</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{offer.description || <span className="muted">{t('offer.noDescription')}</span>}</dd>
          </dl>
        </div>

        {offer.bundle && offer.bundle.length > 0 && (() => {
          const separately = offer.bundle.reduce((s, p) => s + p.price_cents * p.quantity, 0);
          return (
            <div className="card stack" style={{ gap: 8 }}>
              <b>{t('bundle.inside')}</b>
              <ul className="m-0 list-none p-0">
                {offer.bundle.map((p) => (
                  <li key={p.offer_id} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                    <span className="min-w-0 truncate"><span className="num">{p.quantity}×</span> <Link to={`/offers/${p.offer_id}`}>{p.title}</Link></span>
                    <span className="num text-sm text-muted-foreground">{money(p.price_cents * p.quantity, p.currency)}</span>
                  </li>
                ))}
              </ul>
              {separately > offer.price_cents && (
                <div className="small text-released">{t('bundle.saving', { separately: money(separately, offer.currency), amount: money(separately - offer.price_cents, offer.currency) })}</div>
              )}
            </div>
          );
        })()}
        {offer.high_risk_secondary && <div className="alert">{t('offer.highRisk')}</div>}

        <div className="card pg-reviews">
          <div className="row spread">
            <p className="pg-label">{t('offer.reviews')}</p>
            <Rating value={offer.seller_rating} count={offer.seller_review_count} />
          </div>
          {reviews.length === 0 ? (
            <p className="small muted" style={{ margin: '12px 0 4px' }}>{t('offer.noReviews')}</p>
          ) : reviews.map((r) => (
            <div key={r.id} className="pg-review">
              <div className="row spread">
                <b className="small">{r.comment || '★'.repeat(r.rating)}</b>
                <span className="small muted">{ago(r.created_at)}</span>
              </div>
              {r.offer_title && <span className="small muted">{r.offer_title}</span>}
            </div>
          ))}
          <Link className="small" to={`/sellers/${offer.seller_id}#reviews`}>{t('offer.allReviews')}</Link>
        </div>
        <OfferPriceHistory offerId={offer.id} game={offer.game} />
      </div>

      <aside className="card pg-buybox pg-sticky" aria-label={t('offer.buyBox')}>
        {!isAccount && (
          <label className="field">
            {t('offer.quantity')}
            <input className="num" type="number" min={1} max={offer.stock} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
          </label>
        )}
        {tiers.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="small muted">{t('tier.title')}</div>
            <div className="pg-seg" role="group" aria-label={t('tier.title')}>
              {[{ minQty: 1, priceCents: offer.price_cents }, ...tiers].map((tr) => (
                <button key={tr.minQty} type="button" aria-pressed={unit === tr.priceCents && qty >= tr.minQty} onClick={() => setQty(tr.minQty)}>
                  {t('tier.row', { qty: tr.minQty, price: money(tr.priceCents, offer.currency) })}
                </button>
              ))}
            </div>
            {unit < offer.price_cents && <div className="small text-released">{t('tier.saving', { amount: money((offer.price_cents - unit) * qty, offer.currency), each: money(unit, offer.currency) })}</div>}
          </div>
        )}
        {user && !own && <CharacterField game={offer.game} category={offer.category_slug} value={character.value} onChange={(value, ok) => setCharacter({ value, ok })} />}
        <div className="pg-rows">
          {!isAccount && <div><span className="muted">{t('table.perUnit')}</span><span className="num">{money(unit, offer.currency)}</span></div>}
          {code && code.qty === qty && <div><span className="muted">{t('code.discount')}</span><span className="num">−{money(code.discount, offer.currency)}</span></div>}
          <div className="pg-total">
            <span>{t('offer.total')}</span>
            <span className="text-end">
              {onSale && <span className="num small muted line-through" style={{ display: 'block', fontWeight: 400 }}>{money(offer.regular_price_cents! * qty, offer.currency)}</span>}
              <span className="pg-price">{money(total, offer.currency)}</span>
            </span>
          </div>
          {price(total, offer.currency).startsWith('≈') && <div className="small muted" style={{ justifyContent: 'flex-end' }}>{price(total, offer.currency)} · {t('offer.chargedIn', { currency: offer.currency })}</div>}
          {onSale && offer.sale_ends_at && <div className="small text-released" style={{ justifyContent: 'flex-end' }}>{t('sale.endsOn', { when: new Date(offer.sale_ends_at).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</div>}
        </div>
        {user && !own && (
          <div className="pg-code">
            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input aria-label={t('code.enter')} placeholder={t('code.enter')} value={codeText} onChange={(e) => setCodeText(e.target.value)} style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn ghost sm"
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
          </div>
        )}
        {added === 'ok' && <div className="notice small" role="status">{t('cart.added')} <Link to="/cart">{t('cart.view')}</Link></div>}
        {added === 'full' && <div className="alert small">{t('cart.full')}</div>}
        {error && <div className="alert" role="alert">{error} {error === t('offer.verifyFirst') && <Link to="/account">{t('offer.verifyNow')}</Link>}</div>}
        {!user ? (
          <>
            <Link className="btn go lg block" to={`/login?next=/offers/${offer.id}`}>{t('offer.signInToBuy')}</Link>
            <button className="btn ghost block" disabled={offer.stock < qty} onClick={addCart}><ShoppingCart className="size-4" /> {t('cart.add')}</button>
          </>
        ) : own ? (
          <p className="muted small">{t('offer.yours')}</p>
        ) : (
          <>
            <label className="check-row small">
              <input type="checkbox" style={{ width: 'auto' }} checked={tos} onChange={(e) => setTos(e.target.checked)} />
              {t('offer.tos')}
            </label>
            <button className="btn go lg block" disabled={!tos || busy || offer.stock < qty || (needsCharacter && !character.ok)} onClick={buy}>
              {busy ? t('offer.opening') : t('offer.pay', { amount: money(total, offer.currency) })}
            </button>
            <div className="pg-buy-more">
              <button className="btn ghost sm" disabled={offer.stock < qty} onClick={addCart}><ShoppingCart className="size-4" /> {t('cart.add')}</button>
              <button className="btn ghost sm" onClick={ask}><MessageCircle className="size-4" /> {t('offer.ask')}</button>
            </div>
          </>
        )}
        <p className="pg-note"><ShieldCheck className="size-4" aria-hidden /><span>{t('offer.heldUntil')} <Link to={isAccount ? '/help/account-insurance' : '/help/how-escrow-works'}>{t('offer.howEscrow')}</Link></span></p>
      </aside>
    </div>
    {similar.length > 0 && (
      <section className="stack" style={{ marginTop: 40 }}>
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
