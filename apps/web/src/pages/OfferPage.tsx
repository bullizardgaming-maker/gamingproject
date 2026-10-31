import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChatCircle, Coins, Flag, Headset, Minus, Plus } from '@phosphor-icons/react';
import { api, money } from '../api';
import { useSession } from '../session';
import { OfferBadges, type Offer } from './Market';
import { WatchButton } from '../components/WatchButton';
import { CurrencyList, DeliveryTag, fmtUnits, LevelTag, OfferTable, PresenceText, Rating, SellerAvatar } from '../components/CatalogUi';
import { categoryLabel, slugify } from '@/lib/catalog';
import { usePageMeta } from '@/lib/seo';
import { useTermsVersion } from '@/lib/terms';
import { TermsChanged } from '../components/TermsChanged';
import { attributePairs } from '@/lib/attributes';
import { unitPriceFor } from '@/lib/tiers';
import { handoverFieldFor } from '../components/CharacterField';
import { DeliveryDialog, type DeliveryChoice } from '../components/DeliveryDialog';
import { METHODS, methodLabel, methodsOf } from '@/lib/delivery';
import { intlLocale, t } from '../i18n';
import { BuyerProtection } from '../components/Brand';
import { usePrice } from '@/lib/prefs';
import { effectiveMin, soldOut } from '@/lib/stock';
import { MIN_CURRENCY_ORDER_USD_CENTS, totalCentsFor } from '../../../api/src/domain/unitPrice';
import { buyerTiers, buyerUnitAt, tierFor, tierText } from '@/lib/volume';

/**
 * One offer, Eldorado-style: what you get and from whom on the left (kept short), the buy box on
 * the right, the other sellers of the same thing underneath. Currency is bought by amount.
 */
export function OfferPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useSession();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [params] = useSearchParams();
  const [qtyText, setQtyText] = useState(params.get('qty') ?? '');
  const [busy, setBusy] = useState(false);
  const terms = useTermsVersion(); // Round 23e/23f: the version loaded with the page goes with the order
  const [error, setError] = useState('');
  const [others, setOthers] = useState<Offer[]>([]);
  const [sort, setSort] = useState<'recommended' | 'price_asc' | 'min_qty_asc'>('recommended');
  const [dialog, setDialog] = useState(false);
  const [copied, setCopied] = useState(false);
  const price = usePrice();
  const lastChoice = useRef<DeliveryChoice | undefined>(undefined); // kept so accepting new Terms re-sends the same delivery choice
  usePageMeta({ title: offer?.title, description: offer ? `${offer.title} · ${offer.game}. Paid into escrow, released when you confirm delivery.` : undefined });

  useEffect(() => {
    setOffer(null);
    api<Offer>(`/offers/${id}`).then((o) => (setOffer(o), setQtyText((q) => q || String(effectiveMin(o))))).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (!offer) return;
    const q = new URLSearchParams({ game: offer.game, category: offer.category_slug, sort, pageSize: '20' });
    api<{ items: Offer[] }>(`/offers?${q}`).then((r) => setOthers(r.items)).catch(() => {});
  }, [offer, sort]);

  if (!offer) return <p className="muted">{error || t('offer.loading')}</p>;
  const isUnit = !!offer.unit_label;
  const tiers = offer.category_kind === 'account' ? [] : offer.price_tiers ?? [];
  const bundleSeparately = (offer.bundle ?? []).reduce((s, p) => s + p.price_cents * p.quantity, 0);
  const bundleSave = bundleSeparately - offer.price_cents;
  const onSale = offer.regular_price_cents != null && offer.regular_price_cents > offer.price_cents;
  const min = effectiveMin(offer); // Round 28: below the seller's minimum, the minimum is the stock left
  const gone = soldOut(offer);
  const qty = Math.max(0, Math.floor(Number(qtyText) || 0));
  const max = offer.stock; // Round 26b: the max per order is the stock
  const qtyOk = qty >= min && qty <= max;
  // Round 25: currency listings are priced per unit in micro-units, with volume discounts; the total is rounded up
  // to the cent (the order quote at checkout is the amount charged).
  const micro = offer.unit_price_micros != null ? Number(offer.unit_price_micros) : null;
  // Round 26b: tiers are % off or a fixed unit price (buyer prices, fees included).
  const volume = buyerTiers(offer);
  const unitMicros = buyerUnitAt(offer, Math.max(qty, 1));
  const reached = micro != null ? tierFor(offer.volume_discounts, Math.max(qty, 1)) : null;
  const pctOff = reached && micro != null && unitMicros != null ? Math.round(((micro - unitMicros) / micro) * 100) : 0;
  const unit = unitPriceFor(offer, Math.max(qty, 1));
  const total = unitMicros != null ? totalCentsFor(unitMicros, Math.max(qty, 1)) : unit * Math.max(qty, 1);
  const belowMin = micro != null && total < MIN_CURRENCY_ORDER_USD_CENTS;
  const own = user?.id === offer.seller_id;
  const needsCharacter = !!handoverFieldFor(offer.game, offer.category_slug);
  const methods = needsCharacter ? methodsOf(offer) : [];
  const pairs = attributePairs(offer.game, offer.category_slug, offer.attributes);
  const step = (d: number) => setQtyText(String(Math.min(max, Math.max(min, (qty || min) + d * Math.max(1, Math.round(min / 2))))));
  const gameSlug = slugify(offer.game);

  const buy = async (choice?: DeliveryChoice) => {
    lastChoice.current = choice;
    setBusy(true);
    setError('');
    try {
      // The Terms version loaded with this page goes with the order; the API refuses it if it changed meanwhile (Round 23d/23e).
      const tosVersion = await terms.ready();
      if (!tosVersion) throw Object.assign(new Error(t('legal.reloadTerms')), { code: 'terms_stale' });
      const res = await api<{ order: { id: string }; checkoutUrl: string | null }>('/orders', {
        body: { offerId: offer.id, quantity: qty, rail: 'fiat', acceptTos: true, useCredit: true, tosVersion, ...(choice ? { deliveryMethod: choice.method, deliveryInfo: choice.info, characterName: choice.info.character, saveInfo: choice.save } : {}) },
        headers: { 'Idempotency-Key': `${offer.id}:${qty}:${Math.floor(Date.now() / 60_000)}` },
      });
      if (res.checkoutUrl) window.location.assign(res.checkoutUrl);
      else nav(`/orders/${res.order.id}`);
    } catch (e: any) {
      if (e.code === 'terms_stale') {
        // Round 23f: fetch the version now in force and ask the buyer to read and accept it.
        setDialog(false); // the Terms notice sits in the buy box, so close the pop-up to show it
        await terms.onStale();
        setBusy(false);
        return;
      }
      setError(e.code === 'kyc_required' ? t('offer.verifyFirst') : e.code === 'terms_reacceptance_required' ? t('legal.acceptToContinue') : e.message);
      setBusy(false);
    }
  };
  // Share: the link carries the buyer's invite code, so friends who sign up count as referrals.
  const share = async () => {
    const ref = user ? await api<{ code: string }>('/me/referral').then((r) => r.code).catch(() => null) : null;
    const url = `${location.origin}/offers/${offer.id}${ref ? `?ref=${ref}` : ''}`;
    try {
      if (navigator.share) await navigator.share({ title: offer.title, url });
      else await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* closed the share sheet */ }
  };
  const ask = async () => {
    const room = await api<{ id: string }>('/chat/rooms', { body: { offerId: offer.id } });
    nav(`/chat/${room.id}`);
  };

  return (
    <div className="stack of">
      <nav className="crumbs" aria-label="Breadcrumb" style={{ margin: 0 }}>
        <Link to="/games">{t('game.crumb')}</Link><span>/</span>
        <Link to={`/games/${gameSlug}`}>{offer.game}</Link><span>/</span>
        <Link to={`/games/${gameSlug}/${offer.category_slug}`}>{categoryLabel(offer.category_slug)}</Link>
      </nav>
      <div className="flex items-start gap-4">
        <h1 className="pg-h1 min-w-0 flex-1" dir="auto">{isUnit ? `${offer.game} ${categoryLabel(offer.category_slug)}` : offer.title}</h1>
        <button type="button" className="btn ghost" onClick={share}><Coins className="size-4" aria-hidden /> {copied ? t('of.copied') : t('of.share')}</button>
        {user?.id !== offer.seller_id && <WatchButton target={{ offerId: offer.id }} />}
      </div>
      {offer.reserved_for && (
        <div className="notice small">
          {user?.id === offer.reserved_for ? t('req.reservedForYou') : t('req.reservedSeller')}{' '}
          {offer.request_id && <Link to={`/requests/${offer.request_id}`}>{t('req.viewRequest')}</Link>}
        </div>
      )}

      <div className="of-grid">
        <section className="card of-info" aria-label={t('offer.details')}>
          <div className="of-seller">
            <SellerAvatar name={offer.seller_name} online={offer.seller_online} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link to={`/sellers/${offer.seller_id}`} className="of-name">{offer.seller_name}</Link>
                <LevelTag offer={offer} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3">
                <Rating value={offer.seller_rating} count={offer.seller_review_count} />
                <PresenceText online={offer.seller_online} lastSeen={offer.seller_last_seen_at} />
              </div>
            </div>
            {user && !own && <button type="button" className="btn ghost sm" onClick={ask}><ChatCircle className="size-4" aria-hidden /> {t('offer.message')}</button>}
          </div>
          <OfferBadges offer={offer} />
          <dl className="of-rows">
            <div><dt>{t('ct.deliveryTime')}</dt><dd><DeliveryTag offer={offer} /></dd></div>
            {methods.length > 0 && (
              <div>
                <dt>{t('of.deliveryMethods')}</dt>
                <dd className="of-methods">{methods.map((m) => { const Icon = METHODS[m].icon; return <span key={m}><Icon className="size-4" aria-hidden /> {methodLabel(m)}</span>; })}</dd>
              </div>
            )}
            {pairs.map(([label, v]) => <div key={label}><dt>{label}</dt><dd>{v}</dd></div>)}
          </dl>
          {offer.description && (
            <div className="of-notes">
              <span className="pg-label">{t('of.sellerNotes')}</span>
              <p dir="auto">{offer.description}</p>
            </div>
          )}
          {offer.bundle && offer.bundle.length > 0 && (
            <div className="of-instr">
              <b>{t('bundle.inside')}</b>
              <ul className="m-0 mt-2 list-none p-0">
                {offer.bundle.map((p) => (
                  <li key={p.offer_id} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                    <span className="min-w-0 truncate"><span className="num">{p.quantity}×</span> <Link to={`/offers/${p.offer_id}`}>{p.title}</Link></span>
                    <span className="num text-sm text-muted-foreground">{money(p.price_cents * p.quantity, p.currency)}</span>
                  </li>
                ))}
              </ul>
              {bundleSave > 0 && <div className="small text-released">{t('bundle.saving', { separately: money(bundleSeparately, offer.currency), amount: money(bundleSave, offer.currency) })}</div>}
            </div>
          )}
          {offer.high_risk_secondary && <div className="alert">{t('offer.highRisk')}</div>}
        </section>

        <aside className="card of-buy pg-sticky" aria-label={t('offer.buyBox')}>
          <p className="of-avail num">{t('of.available', { n: offer.stock.toLocaleString(intlLocale()) })}</p>
          <div className="of-qty">
            <div className="of-stepper">
              <button type="button" aria-label={t('offer.less')} onClick={() => step(-1)} disabled={qty <= min}><Minus className="size-4" aria-hidden /></button>
              <label className="sr-only" htmlFor="of-qty">{t('offer.quantity')}</label>
              <input id="of-qty" className="num" type="number" inputMode="numeric" min={min} max={max} value={qtyText} onChange={(e) => setQtyText(e.target.value)} aria-invalid={!qtyOk || undefined} />
              {isUnit && <span className="of-unit" aria-hidden>{offer.unit_label}</span>}
              <button type="button" className="of-plus" aria-label={t('offer.more')} onClick={() => step(1)} disabled={qty >= max}><Plus className="size-4" aria-hidden /></button>
            </div>
            <p className="of-unitprice small muted num">
              {onSale && micro == null && <span className="line-through" style={{ marginInlineEnd: 6 }}>{price(offer.regular_price_cents!)}</span>}
              {t('of.unitPrice', { price: unitMicros != null ? price.unit(unitMicros) : price(unit) })}{isUnit ? ` / ${offer.unit_label}` : ''}
              {pctOff > 0 && <span className="text-released"> · {t('vd.off', { n: pctOff })}</span>}
              {min > 1 && <> · {t('ct.minShort', { n: min.toLocaleString(intlLocale()) })}</>}
            </p>
            {onSale && offer.sale_ends_at && <p className="small text-released" style={{ margin: 0, textAlign: 'center' }}>{t('sale.endsOn', { when: new Date(offer.sale_ends_at).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>}
          </div>
          {volume.length > 0 && micro != null && (
            <div className="pg-seg of-volume" role="group" aria-label={t('vd.title')}>
              {volume.map((v) => (
                <button key={v.minQty} type="button" aria-pressed={reached?.minQty === v.minQty} onClick={() => setQtyText(String(v.minQty))}>
                  {tierText(v, price.unit, intlLocale())}
                </button>
              ))}
            </div>
          )}
          {tiers.length > 0 && micro == null && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="pg-seg" role="group" aria-label={t('tier.title')}>
                {[{ minQty: 1, priceCents: offer.price_cents }, ...tiers].map((tr) => (
                  <button key={tr.minQty} type="button" aria-pressed={unit === tr.priceCents && qty >= tr.minQty} onClick={() => setQtyText(String(tr.minQty))}>
                    {t('tier.row', { qty: tr.minQty, price: money(tr.priceCents, offer.currency) })}
                  </button>
                ))}
              </div>
              {unit < offer.price_cents && <div className="small text-released">{t('tier.saving', { amount: money((offer.price_cents - unit) * qty, offer.currency), each: money(unit, offer.currency) })}</div>}
            </div>
          )}
          <div className="of-total"><span>{t('offer.total')}</span><b className="num" data-testid="offer-total">{price(total)}</b></div>
          {belowMin && <p className="small muted" style={{ margin: 0 }} role="status">{t('vd.minOrder', { amount: price(MIN_CURRENCY_ORDER_USD_CENTS) })}</p>}
          {terms.stale && <TermsChanged busy={busy} onAccept={() => { terms.accepted(); void buy(lastChoice.current); }} />}
          {error && !dialog && <div className="alert small" role="alert">{error} {error === t('offer.verifyFirst') && <Link to="/account">{t('offer.verifyNow')}</Link>}</div>}
          {!user ? (
            <Link className="btn go lg block" to={`/login?next=/offers/${offer.id}`}>{t('offer.signInToBuy')}</Link>
          ) : own ? (
            <p className="muted small" style={{ margin: 0 }}>{t('offer.yours')}</p>
          ) : (
            gone ? <p className="alert small" role="status" style={{ margin: 0 }} data-testid="sold-out">{t('of.soldOut')}</p> :
            <button className="btn go lg block" disabled={busy || !qtyOk || belowMin} onClick={() => (methods.length ? (setError(''), setDialog(true)) : buy())}>
              {busy && !dialog ? t('offer.opening') : t('of.buyNow')}
            </button>
          )}
          <ul className="of-trust">
            <li className="of-bp"><BuyerProtection short /></li>
            <li className="of-help"><Headset className="size-4" aria-hidden /> <Link to="/support/new" className="of-help-link"><b>{t('offer.support')} 24/7</b></Link></li>
          </ul>
          <p className="of-id small muted">
            <span>{t('of.offerId')} <span className="num" data-testid="offer-id">#{offer.public_id ?? offer.id}</span></span>
            <Link to={`/support/new?${new URLSearchParams({ category: 'report', offer: offer.id })}`}><Flag className="size-3.5" aria-hidden /> {t('of.report')}</Link>
          </p>
          {methods.length > 0 && (
            <DeliveryDialog open={dialog} game={offer.game} methods={methods} busy={busy} error={error} onClose={() => setDialog(false)} onContinue={(c) => buy(c)} />
          )}
        </aside>
      </div>

      {others.some((o) => o.id !== offer.id) && (
        <section className="of-others" aria-labelledby="of-others-title">
          <div className="ct-head">
            <h2 id="of-others-title">{t('offer.otherSellers', { n: others.filter((o) => o.id !== offer.id).length })}</h2>
            {isUnit && (
              <div className="pg-seg" role="group" aria-label={t('sort.label')}>
                {([['recommended', 'ct.sort.recommended'], ['price_asc', 'ct.sort.cheapest'], ['min_qty_asc', 'ct.sort.minQty']] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{t(label)}</button>
                ))}
              </div>
            )}
          </div>
          {isUnit ? <CurrencyList offers={others} current={offer.id} /> : <OfferTable offers={others.filter((o) => o.id !== offer.id).slice(0, 6)} />}
        </section>
      )}
    </div>
  );
}
