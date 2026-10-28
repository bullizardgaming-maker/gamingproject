/**
 * Round 25: currency listings priced per unit in micro-units (6 decimals) and their volume discounts. Kept free of
 * imports so the web app can use the same rules and show the prices the API charges.
 *
 *  - A unit price is an integer number of micro-units of the listing currency: 123 = 0.000123 per unit.
 *  - An order's total is quantity × unit price, rounded UP to the cent.
 *  - Volume discounts: up to four tiers "from this many units, this % off" (1–50 %); the best tier reached applies, and
 *    the discounted unit price is rounded up to the micro-unit.
 *  - Delivery time: one of a fixed list.
 */
export const MICROS_PER_CENT = 10_000;
export const MICROS_PER_UNIT = 1_000_000;

/** Smallest order total for a currency listing, in USD cents ($1.00). */
export const MIN_CURRENCY_ORDER_USD_CENTS = 100;

export const DELIVERY_TIMES = { '15m': 15, '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440 } as const;
export type DeliveryTime = keyof typeof DELIVERY_TIMES;
export const DELIVERY_TIME_KEYS = Object.keys(DELIVERY_TIMES) as DeliveryTime[];
export const isDeliveryTime = (v: unknown): v is DeliveryTime => typeof v === 'string' && v in DELIVERY_TIMES;
/** The list entry for a number of minutes (the smallest one that is not shorter), e.g. 90 → '3h'. */
export function deliveryTimeFor(minutes: number): DeliveryTime {
  return DELIVERY_TIME_KEYS.find((k) => DELIVERY_TIMES[k] >= minutes) ?? '24h';
}

export interface VolumeDiscount {
  /** Orders of at least this many units… */
  minQty: number;
  /** …get this much off the unit price (1–50). */
  percentOff: number;
}
export const MAX_VOLUME_DISCOUNTS = 4;
export const MAX_VOLUME_PERCENT = 50;

/** "0.000123" → 123. Up to 6 decimals, no sign, no exponent. Null when malformed. */
export function parseUnitPrice(v: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) return null;
  const micros = Number(m[1]) * MICROS_PER_UNIT + Number((m[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
}

/** 123 → "0.000123" (always six decimals). */
export function formatUnitPrice(micros: number): string {
  const whole = Math.floor(micros / MICROS_PER_UNIT);
  return `${whole}.${String(micros % MICROS_PER_UNIT).padStart(6, '0')}`;
}

/** Validate tiers: quantities above the listing's minimum and rising, discounts 1–50 % and rising. */
export function checkVolumeDiscounts(tiers: VolumeDiscount[] | undefined | null, minQty = 1): { ok: true; value: VolumeDiscount[] } | { ok: false; error: string } {
  if (!tiers?.length) return { ok: true, value: [] };
  if (tiers.length > MAX_VOLUME_DISCOUNTS) return { ok: false, error: `Up to ${MAX_VOLUME_DISCOUNTS} volume discounts` };
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let prevQty = minQty;
  let prevPct = 0;
  for (const t of sorted) {
    if (!Number.isSafeInteger(t.minQty) || t.minQty <= prevQty) return { ok: false, error: 'Each volume discount needs a larger quantity than the one before (and than the minimum order)' };
    if (!Number.isInteger(t.percentOff) || t.percentOff < 1 || t.percentOff > MAX_VOLUME_PERCENT) return { ok: false, error: `A volume discount is 1 to ${MAX_VOLUME_PERCENT}% off` };
    if (t.percentOff <= prevPct) return { ok: false, error: 'Each volume discount must be bigger than the one before it' };
    prevQty = t.minQty;
    prevPct = t.percentOff;
  }
  return { ok: true, value: sorted.map((t) => ({ minQty: t.minQty, percentOff: t.percentOff })) };
}

/** The % off an order of `quantity` gets (0 when it reaches no tier). */
export function volumePercentFor(tiers: readonly VolumeDiscount[] | null | undefined, quantity: number): number {
  let pct = 0;
  for (const t of tiers ?? []) if (quantity >= t.minQty && t.percentOff > pct) pct = t.percentOff;
  return pct;
}

/** The unit price an order of `quantity` pays: the base less the best tier's discount, rounded up to the micro-unit. */
export function unitMicrosFor(baseMicros: number, tiers: readonly VolumeDiscount[] | null | undefined, quantity: number): number {
  const pct = volumePercentFor(tiers, quantity);
  if (!pct) return baseMicros;
  return Number((BigInt(baseMicros) * BigInt(100 - pct) + 99n) / 100n);
}

/** quantity × unit price, rounded UP to the cent. Exact for any safe integers (BigInt). */
export function totalCentsFor(unitMicros: number, quantity: number): number {
  const p = BigInt(unitMicros) * BigInt(quantity);
  const c = (p + BigInt(MICROS_PER_CENT - 1)) / BigInt(MICROS_PER_CENT);
  return Number(c);
}

/** The buyer's unit price for a seller's unit price at a commission rate (gross-up, rounded up). */
export function grossMicros(sellerMicros: number, rateBps: number): number {
  return Number((BigInt(sellerMicros) * 10_000n + BigInt(10_000 - rateBps) - 1n) / BigInt(10_000 - rateBps));
}

/** The price of one unit in cents, rounded up (what price_cents holds for a currency listing). */
export const centsForMicros = (micros: number) => Math.max(1, Math.ceil(micros / MICROS_PER_CENT));
