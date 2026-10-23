import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CaretDown, ChatCircle, Headset, Minus, Plus, ShieldCheck } from '@phosphor-icons/react';
import { api, money } from '../api';
import { useSession } from '../session';
import { OfferBadges, type Offer } from './Market';
import { WatchButton } from '../components/WatchButton';
import { CurrencyTable, DeliveryTag, fmtUnits, OfferTable, PresenceText, Rating, SellerAvatar, SellerBadges } from '../components/CatalogUi';
import { categoryLabel, slugify } from '@/lib/catalog';
import { usePageMeta } from '@/lib/seo';
import { attributePairs } from '@/lib/attributes';
import { unitPriceFor } from '@/lib/tiers';
import { CharacterField, handoverFieldFor } from '../components/CharacterField';
import { intlLocale, t } from '../i18n';
import { BuyerProtection } from '../components/Brand';

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
  const [error, setError] = useState('');
  const [others, setOthers] = useState<Offer[]>([]);
  const [sort, setSort] = useState<'recommended' | 'price_asc' | 'min_qty_asc'>('recommended');
  const [character, setCharacter] = useState({ value: '', ok: false });
  usePageMeta({ title: offer?.title, description: offer ? `${offer.title} · ${offer.game}. Paid into escrow, released when you confirm delivery.` : undefined });

  useEffect(() => {
    setOffer(null);
    api<Offer>(`/offers/${id}`).then((o) => (setOffer(o), setQtyText((q) => q || String(o.min_qty ?? 1)))).catch((e) => setError(e.message));
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
  const min = offer.min_qty ?? 1;
  const qty = Math.max(0, Math.floor(Number(qtyText) || 0));
  const qtyOk = qty >= min && qty <= offer.stock;
  const unit = unitPriceFor(offer, Math.max(qty, 1));
  const total = unit * Math.max(qty, 1);
  const own = user?.id === offer.seller_id;
  const needsCharacter = !!handoverFieldFor(offer.game, offer.category_slug);
  const pairs = attributePairs(offer.game, offer.category_slug, offer.attributes);
  const step = (d: number) => setQtyText(String(Math.min(offer.stock, Math.max(min, (qty || min) + d * Math.max(1, Math.round(min / 2))))));
  const gameSlug = slugify(offer.game);

  const buy = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ order: { id: string }; checkoutUrl: string | null }>('/orders', {
        body: { offerId: offer.id, quantity: qty, rail: 'fiat', acceptTos: true, useCredit: true, ...(needsCharacter ? { characterName: character.value.trim() } : {}) },
        headers: { 'Idempotency-Key': `${offer.id}:${qty}:${Math.floor(Date.now() / 60_000)}` },
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

  return (
    <div className="stack of">
      <nav className="crumbs" aria-label="Breadcrumb" style={{ margin: 0 }}>
        <Link to="/games">{t('game.crumb')}</Link><span>/</span>
        <Link to={`/games/${gameSlug}`}>{offer.game}</Link><span>/</span>
        <Link to={`/games/${gameSlug}/${offer.category_slug}`}>{categoryLabel(offer.category_slug)}</Link>
      </nav>
      <div className="flex items-start gap-4">
        <h1 className="pg-h1 min-w-0 flex-1" dir="auto">{isUnit ? `${offer.game} ${categoryLabel(offer.category_slug)}` : offer.title}</h1>
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
                <SellerBadges badges={offer.seller_badges} />
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
            {pairs.map(([label, v]) => <div key={label}><dt>{label}</dt><dd>{v}</dd></div>)}
            <div><dt>{t('ct.deliveryTime')}</dt><dd><DeliveryTag offer={offer} /></dd></div>
            {isUnit && <div><dt>{t('ct.min')}</dt><dd className="num">{fmtUnits(min, offer.unit_label)}</dd></div>}
          </dl>
          {offer.description && (
            <details className="of-instr">
              <summary>{t('offer.instructions')} <CaretDown className="size-4" aria-hidden /></summary>
              <p dir="auto">{offer.description}</p>
            </details>
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
          <div className="of-price">
            <span className="muted">{t('offer.price')}</span>
            <span>
              {onSale && <span className="num small muted line-through" style={{ marginInlineEnd: 6 }}>{money(offer.regular_price_cents!, offer.currency)}</span>}
              <b className="num">{money(unit, offer.currency)}</b>{isUnit && <span className="muted"> / {offer.unit_label}</span>}
            </span>
          </div>
          {onSale && offer.sale_ends_at && <p className="small text-released" style={{ margin: '-8px 0 0' }}>{t('sale.endsOn', { when: new Date(offer.sale_ends_at).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>}
          <div className="of-qty">
            <div className="of-stepper">
              <button type="button" aria-label={t('offer.less')} onClick={() => step(-1)} disabled={qty <= min}><Minus className="size-4" aria-hidden /></button>
              <label className="sr-only" htmlFor="of-qty">{t('offer.quantity')}</label>
              <input id="of-qty" className="num" type="number" inputMode="numeric" min={min} max={offer.stock} value={qtyText} onChange={(e) => setQtyText(e.target.value)} aria-invalid={!qtyOk || undefined} />
              {isUnit && <span className="of-unit" aria-hidden>{offer.unit_label}</span>}
              <button type="button" aria-label={t('offer.more')} onClick={() => step(1)} disabled={qty >= offer.stock}><Plus className="size-4" aria-hidden /></button>
            </div>
            <div className="of-qty-meta small muted num">
              <span>{t('offer.minQty', { n: fmtUnits(min, offer.unit_label) })}</span>
              <span>{t('offer.inStock', { n: fmtUnits(offer.stock, offer.unit_label) })}</span>
            </div>
          </div>
          {tiers.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="small muted">{t('tier.title')}</div>
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
          {user && !own && <CharacterField game={offer.game} category={offer.category_slug} value={character.value} onChange={(value, ok) => setCharacter({ value, ok })} />}
          <div className="of-total"><span>{t('offer.total')}</span><b className="num">{money(total, offer.currency)}</b></div>
          {error && <div className="alert small" role="alert">{error} {error === t('offer.verifyFirst') && <Link to="/account">{t('offer.verifyNow')}</Link>}</div>}
          {!user ? (
            <Link className="btn go lg block" to={`/login?next=/offers/${offer.id}`}>{t('offer.signInToBuy')}</Link>
          ) : own ? (
            <p className="muted small" style={{ margin: 0 }}>{t('offer.yours')}</p>
          ) : (
            <>
              <button className="btn go lg block" disabled={busy || !qtyOk || (needsCharacter && !character.ok)} onClick={buy}>
                {busy ? t('offer.opening') : t('offer.pay', { amount: money(total, offer.currency) })}
              </button>
              <p className="small muted of-agree" style={{ margin: 0 }} data-testid="buy-agree">
                {t('offer.agree', { terms: '\u0000' }).split('\u0000')[0]}<Link to="/terms">{t('offer.agreeTerms')}</Link>{t('offer.agree', { terms: '\u0000' }).split('\u0000')[1]}
              </p>
            </>
          )}
          <ul className="of-trust">
            <li className="of-bp"><BuyerProtection /></li>
            <li><Headset className="size-4" aria-hidden /> <span><b>{t('offer.support')}</b> <Link to="/support/new">{t('offer.supportText')}</Link></span></li>
          </ul>
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
          {isUnit ? <CurrencyTable offers={others} current={offer.id} /> : <OfferTable offers={others.filter((o) => o.id !== offer.id).slice(0, 6)} />}
        </section>
      )}
    </div>
  );
}
