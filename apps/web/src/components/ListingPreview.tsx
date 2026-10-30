import { DeliveryTag, LevelTag, Rating, SellerAvatar } from './CatalogUi';
import { OfferBadges, type Offer } from '../pages/Market';
import { categoryLabel } from '@/lib/catalog';
import { attributePairs } from '@/lib/attributes';
import { unitPriceFor } from '@/lib/tiers';
import { METHODS, methodLabel, methodsOf } from '@/lib/delivery';
import { handoverFieldFor } from './CharacterField';
import { usePrice } from '@/lib/prefs';
import { intlLocale, t } from '../i18n';
import { totalCentsFor, unitMicrosFor } from '../../../api/src/domain/unitPrice';

/**
 * Round 26 (B10): the listing exactly as buyers will see it on its offer page, from POST /offers/preview (buyer
 * prices, fees included), before it is published. Nothing is saved until "Publish".
 */
export function ListingPreview({ offer, review, busy, error, publishLabel, onEdit, onPublish }: {
  offer: Offer;
  review: boolean;
  busy: boolean;
  error: string;
  publishLabel: string;
  onEdit: () => void;
  onPublish: () => void;
}) {
  const price = usePrice();
  const isUnit = !!offer.unit_label;
  const min = offer.min_qty ?? 1;
  const micro = offer.unit_price_micros != null ? Number(offer.unit_price_micros) : null;
  const unitMicros = micro != null ? unitMicrosFor(micro, offer.volume_discounts ?? [], min) : null;
  const unit = unitPriceFor(offer, min);
  const total = unitMicros != null ? totalCentsFor(unitMicros, min) : unit * min;
  const methods = handoverFieldFor(offer.game, offer.category_slug) ? methodsOf(offer) : [];
  const pairs = attributePairs(offer.game, offer.category_slug, offer.attributes);
  const n = (v: number) => v.toLocaleString(intlLocale());

  return (
    <section className="stack lp" aria-labelledby="lp-title" data-testid="listing-preview">
      <div className="notice lp-banner" role="status">
        <b>{t('lst.previewTitle')}</b> {t('lst.previewText')}
      </div>
      <div className="of">
        <h2 id="lp-title" className="pg-h1" dir="auto" style={{ margin: '0 0 12px' }}>{isUnit ? `${offer.game} ${categoryLabel(offer.category_slug)}` : offer.title}</h2>
        <div className="of-grid">
          <section className="card of-info" aria-label={t('offer.details')}>
            <div className="of-seller">
              <SellerAvatar name={offer.seller_name} online={offer.seller_online} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5"><span className="of-name">{offer.seller_name}</span><LevelTag offer={offer} /></div>
                <Rating value={offer.seller_rating} count={offer.seller_review_count} />
              </div>
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
          </section>
          <aside className="card of-buy" aria-label={t('offer.buyBox')}>
            <p className="of-avail num">{t('of.available', { n: n(offer.stock) })}</p>
            <p className="of-unitprice small muted num" style={{ margin: 0 }}>
              {t('of.unitPrice', { price: unitMicros != null ? price.unit(micro!) : price(offer.price_cents) })}{isUnit ? ` / ${offer.unit_label}` : ''}
            </p>
            <dl className="of-rows lp-limits">
              <div><dt>{t('lst.minPerOrder')}</dt><dd className="num">{n(min)}</dd></div>
              <div><dt>{t('lst.maxPerOrder')}</dt><dd className="num">{offer.max_qty != null ? n(offer.max_qty) : t('lst.noMax')}</dd></div>
            </dl>
            <div className="of-total"><span>{t('lst.totalFor', { n: n(min) })}</span><b className="num" data-testid="preview-total">{price(total)}</b></div>
            {review && <div className="notice small" role="status">{t('lst.willReview')}</div>}
            {error && <div className="alert small" role="alert">{error}</div>}
            <button type="button" className="btn lg block" disabled={busy} onClick={onPublish}>{publishLabel}</button>
            <button type="button" className="btn ghost block" disabled={busy} onClick={onEdit}>{t('lst.backToEdit')}</button>
          </aside>
        </div>
      </div>
    </section>
  );
}
