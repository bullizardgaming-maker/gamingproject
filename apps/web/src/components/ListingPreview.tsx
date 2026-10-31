import { DeliveryTag, SellerAvatar } from './CatalogUi';
import { categoryLabel } from '@/lib/catalog';
import { attributePairs } from '@/lib/attributes';
import { unitPriceFor } from '@/lib/tiers';
import { METHODS, methodLabel, methodsOf } from '@/lib/delivery';
import { normTiers, tierText, unitMicrosAt } from '@/lib/volume';
import { handoverFieldFor } from './CharacterField';
import { usePrice } from '@/lib/prefs';
import { intlLocale, t } from '../i18n';
import { totalCentsFor } from '../../../api/src/domain/unitPrice';

/** POST /offers/preview (HANDOFF Round 26, B10): the listing as buyers see it, plus the seller's and buyer's prices. */
export interface PreviewResponse {
  valid: boolean;
  would_need_review: boolean;
  review_reasons: string[];
  listing: {
    title: string;
    description: string;
    attributes: Record<string, string>;
    game?: string;
    category_slug?: string;
    delivery_mode?: 'auto' | 'manual';
    delivery_time?: string | null;
    delivery_minutes?: number | null;
    delivery_methods?: string[] | null;
    min_qty?: number | null;
    stock?: number;
    price_cents: number;
    unit_price_micros?: number | null;
    unit_price?: string | null;
    volume_discounts?: Array<{ minQty: number; type: 'percent' | 'fixed'; value: number } | { minQty: number; percentOff: number }>;
    price_tiers?: Array<{ minQty: number; priceCents: number }>;
    listing_state?: string;
  };
  seller: { commission_bps: number; price_cents: number; unit_price_micros: number | null; unit_price: string | null };
  buyer: { unit_price_micros: number | null; unit_price: string | null; price_cents: number; min_order_cents: number; currency: string };
}

/**
 * Round 26 (B10): the listing as buyers will see it on its offer page (buyer prices, fees included), before it is
 * published. Nothing is saved until "Publish". Unit prices at full precision (Round 26b).
 */
export function ListingPreview({ preview, game, category, stock, sellerName, busy, error, publishLabel, onEdit, onPublish }: {
  preview: PreviewResponse;
  game: string;
  category: string;
  stock: number;
  sellerName: string;
  busy: boolean;
  error: string;
  publishLabel: string;
  onEdit: () => void;
  onPublish: () => void;
}) {
  const price = usePrice();
  const l = preview.listing;
  const min = l.min_qty ?? 1;
  const micro = preview.buyer.unit_price_micros ?? l.unit_price_micros ?? null;
  const tiers = normTiers(l.volume_discounts);
  const total = micro != null ? totalCentsFor(unitMicrosAt(micro, tiers, min), min) : unitPriceFor({ price_cents: preview.buyer.price_cents ?? l.price_cents, price_tiers: l.price_tiers }, min) * min;
  const methods = handoverFieldFor(game, category) ? methodsOf({ game, category_slug: category, delivery_methods: l.delivery_methods ?? null }) : [];
  const pairs = attributePairs(game, category, l.attributes);
  const n = (v: number) => v.toLocaleString(intlLocale());

  return (
    <section className="stack lp" aria-labelledby="lp-title" data-testid="listing-preview">
      <div className="notice lp-banner" role="status">
        <b>{t('lst.previewTitle')}</b> {t('lst.previewText')}
      </div>
      <div className="of">
        <h2 id="lp-title" className="pg-h1" dir="auto" style={{ margin: '0 0 12px' }}>{l.title || `${game} ${categoryLabel(category)}`}</h2>
        <div className="of-grid">
          <section className="card of-info" aria-label={t('offer.details')}>
            <div className="of-seller">
              <SellerAvatar name={sellerName} online />
              <div className="min-w-0 flex-1"><span className="of-name">{sellerName}</span></div>
            </div>
            <dl className="of-rows">
              <div><dt>{t('ct.deliveryTime')}</dt><dd><DeliveryTag offer={{ delivery_mode: l.delivery_mode ?? 'manual', delivery_minutes: l.delivery_minutes }} /></dd></div>
              {methods.length > 0 && (
                <div>
                  <dt>{t('of.deliveryMethods')}</dt>
                  <dd className="of-methods">{methods.map((m) => { const Icon = METHODS[m].icon; return <span key={m}><Icon className="size-4" aria-hidden /> {methodLabel(m)}</span>; })}</dd>
                </div>
              )}
              {pairs.map(([label, v]) => <div key={label}><dt>{label}</dt><dd>{v}</dd></div>)}
            </dl>
            {l.description && (
              <div className="of-notes">
                <span className="pg-label">{t('of.sellerNotes')}</span>
                <p dir="auto">{l.description}</p>
              </div>
            )}
          </section>
          <aside className="card of-buy" aria-label={t('offer.buyBox')}>
            <p className="of-avail num">{t('of.available', { n: n(l.stock ?? stock) })}</p>
            <p className="of-unitprice small muted num" style={{ margin: 0 }} data-testid="preview-unit">
              {t('of.unitPrice', { price: micro != null ? price.unit(micro) : price(preview.buyer.price_cents ?? l.price_cents) })}
            </p>
            {tiers.length > 0 && micro != null && (
              <ul className="lp-tiers small" aria-label={t('vd.title')}>
                {tiers.map((x) => <li key={x.minQty} className="num">{tierText(x, price.unit, intlLocale())}</li>)}
              </ul>
            )}
            <dl className="of-rows lp-limits">
              <div><dt>{t('lst.minPerOrder')}</dt><dd className="num">{n(min)}</dd></div>
            </dl>
            <div className="of-total"><span>{t('lst.totalFor', { n: n(min) })}</span><b className="num" data-testid="preview-total">{price(total)}</b></div>
            {preview.would_need_review && <div className="notice small" role="status">{t('lst.willReview')}</div>}
            {error && <div className="alert small" role="alert">{error}</div>}
            <button type="button" className="btn lg block" disabled={busy} onClick={onPublish}>{publishLabel}</button>
            <button type="button" className="btn ghost block" disabled={busy} onClick={onEdit}>{t('lst.backToEdit')}</button>
          </aside>
        </div>
      </div>
    </section>
  );
}
