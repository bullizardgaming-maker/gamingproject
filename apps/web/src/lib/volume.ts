import { MAX_VOLUME_DISCOUNTS, MAX_VOLUME_PERCENT, parseUnitPrice } from '../../../api/src/domain/unitPrice';
import { t } from '../i18n';

/**
 * Round 26b: currency prices and volume discounts on the web side.
 * A tier is `{ minQty, type, value }`: `percent` = value % off (1–50); `fixed` = value is the unit price in
 * micro-units for orders of at least minQty (lower than the base price and than the tier before it).
 * Older listings send `{ minQty, percentOff }`; `normTiers` reads both.
 */
export type TierType = 'percent' | 'fixed';
export interface VolumeTier { minQty: number; type: TierType; value: number }
type AnyTier = VolumeTier | { minQty: number; percentOff: number };

export { MAX_VOLUME_DISCOUNTS, MAX_VOLUME_PERCENT };

export const normTiers = (tiers: readonly AnyTier[] | null | undefined): VolumeTier[] =>
  (tiers ?? []).map((x) => ('type' in x ? { minQty: x.minQty, type: x.type, value: x.value } : { minQty: x.minQty, type: 'percent' as const, value: x.percentOff })).sort((a, b) => a.minQty - b.minQty);

/** The tier an order of `quantity` reaches (the one with the largest minQty not above it), if any. */
export function tierFor(tiers: readonly AnyTier[] | null | undefined, quantity: number): VolumeTier | null {
  let best: VolumeTier | null = null;
  for (const x of normTiers(tiers)) if (quantity >= x.minQty) best = x;
  return best;
}

/** Unit price of a tier for a base price: % rounded up to the micro-unit, or the fixed price (never above the base). */
export const tierMicros = (base: number, x: VolumeTier) => (x.type === 'fixed' ? Math.min(base, x.value) : Number((BigInt(base) * BigInt(100 - x.value) + 99n) / 100n));

/** The unit price an order of `quantity` pays. */
export function unitMicrosAt(base: number, tiers: readonly AnyTier[] | null | undefined, quantity: number): number {
  const x = tierFor(tiers, quantity);
  return x ? tierMicros(base, x) : base;
}

/** How much a tier takes off the base, in whole % (for labels). */
export const tierPercent = (base: number, x: VolumeTier) => (x.type === 'percent' ? x.value : base > 0 ? Math.round(((base - x.value) / base) * 100) : 0);

/** Validate tiers as the API does: rising quantities above the minimum order, each cheaper than the one before. */
export function checkTiers(tiers: VolumeTier[], minQty: number, base: number | null): { ok: true; value: VolumeTier[] } | { ok: false; error: string } {
  if (!tiers.length) return { ok: true, value: [] };
  if (tiers.length > MAX_VOLUME_DISCOUNTS) return { ok: false, error: t('vt.tooMany', { n: MAX_VOLUME_DISCOUNTS }) };
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let prevQty = minQty;
  let prevUnit = base ?? Number.MAX_SAFE_INTEGER;
  for (const x of sorted) {
    if (!Number.isSafeInteger(x.minQty) || x.minQty <= prevQty) return { ok: false, error: t('vt.qtyRising') };
    if (x.type === 'percent' && (!Number.isInteger(x.value) || x.value < 1 || x.value > MAX_VOLUME_PERCENT)) return { ok: false, error: t('vt.percentRange', { n: MAX_VOLUME_PERCENT }) };
    if (x.type === 'fixed' && !(Number.isSafeInteger(x.value) && x.value >= 1)) return { ok: false, error: t('co.priceInvalid') };
    if (base != null) {
      if (x.type === 'fixed' && x.value >= base) return { ok: false, error: t('vt.fixedBelowBase') };
      const unit = tierMicros(base, x);
      if (unit >= prevUnit) return { ok: false, error: t('vt.cheaper') };
      prevUnit = unit;
    }
    prevQty = x.minQty;
  }
  return { ok: true, value: sorted };
}

/** A typed price: "0.14", ".14" (= 0.14) or "14" → micro-units; null when it isn't a price with up to 6 decimals. */
export const parsePrice = (v: string): number | null => {
  const s = v.trim().replace(',', '.');
  return parseUnitPrice(s.startsWith('.') ? `0${s}` : s);
};

/** What the seller typed, tidied: ".14" → "0.14", "0.140000" → "0.14", "2." → "2". Unparseable text is left as is. */
export function tidyPrice(v: string): string {
  const micros = parsePrice(v);
  return micros == null ? v : microsText(micros);
}

/** Delivery speed: typed number + unit. 1 minute to 72 hours. */
export const MAX_DELIVERY_MINUTES = 72 * 60;
export function deliveryMinutesFrom(value: string, unit: 'minutes' | 'hours'): number | null {
  const n = Number(value);
  if (!value.trim() || !Number.isInteger(n) || n < 1) return null;
  const m = unit === 'hours' ? n * 60 : n;
  return m <= MAX_DELIVERY_MINUTES ? m : null;
}
export const splitMinutes = (m: number | null | undefined): { value: string; unit: 'minutes' | 'hours' } =>
  !m ? { value: '', unit: 'minutes' } : m % 60 === 0 ? { value: String(m / 60), unit: 'hours' } : { value: String(m), unit: 'minutes' };

/** A tier as buyers see it: "20,000+ · 5% off" or "20,000+ · $0.12 each" (fixed prices at full precision). */
export function tierText(x: VolumeTier & { buyerMicros?: number }, unit: (micros: number) => string, locale?: string): string {
  const qty = x.minQty.toLocaleString(locale);
  return x.type === 'fixed' ? t('vt.rowFixed', { qty, price: unit(x.buyerMicros ?? x.value) }) : t('vd.row', { qty, n: x.value });
}

/** 140000 → "0.14" (exact, trailing zeros trimmed): micro-units back into a price field. */
export function microsText(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Offer reads (HANDOFF Round 26b): `unit_price_micros` is the buyer's base price, `seller_unit_price_micros` the seller's,
 * `seller_rate_bps` the seller's commission and `volume_discounts` the seller's raw tiers (a fixed tier's value is the
 * seller's price). The buyer pays the seller's tier price grossed up at the seller's rate, like the API's quote.
 */
type PricedOffer = {
  unit_price_micros?: number | string | null;
  seller_unit_price_micros?: number | string | null;
  seller_rate_bps?: number | string | null;
  volume_discounts?: readonly AnyTier[] | null;
};
const grossUpMicros = (sellerMicros: number, rateBps: number) => Number((BigInt(sellerMicros) * 10_000n + BigInt(10_000 - rateBps) - 1n) / BigInt(10_000 - rateBps));

/** The buyer's unit price for `quantity` (micro-units), or null for listings not priced per unit. */
export function buyerUnitAt(o: PricedOffer, quantity: number): number | null {
  if (o.unit_price_micros == null) return null;
  const buyer = Number(o.unit_price_micros);
  const tier = tierFor(o.volume_discounts, quantity);
  if (!tier) return buyer;
  if (o.seller_unit_price_micros != null && o.seller_rate_bps != null) return grossUpMicros(tierMicros(Number(o.seller_unit_price_micros), tier), Number(o.seller_rate_bps));
  return tier.type === 'percent' ? tierMicros(buyer, tier) : buyer; // no seller price to gross up from: show the base
}

/** Each tier with the buyer's unit price (for the tier buttons). */
export const buyerTiers = (o: PricedOffer): Array<VolumeTier & { buyerMicros: number }> =>
  o.unit_price_micros == null ? [] : normTiers(o.volume_discounts).map((x) => ({ ...x, buyerMicros: buyerUnitAt(o, x.minQty)! }));
