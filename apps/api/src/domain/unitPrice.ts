/**
 * Round 25: currency listings priced per unit in micro-units (6 decimals) and their volume discounts. Kept free of
 * imports so the web app can use the same rules and show the prices the API charges.
 *
 *  - A unit price is an integer number of micro-units of the listing currency: 123 = 0.000123 per unit.
 *  - An order's total is quantity × unit price, rounded UP to the cent.
 *  - Volume discounts (Round 26b): up to four tiers "from this many units: X % off (1–50) or a fixed unit price"; the
 *    tier reached applies; a percent tier's unit price is rounded up to the micro-unit.
 *  - Delivery time (Round 26b): any whole number of minutes from 1 to 72 h; the Round 25 list values stay valid.
 */
export const MICROS_PER_CENT = 10_000;
export const MICROS_PER_UNIT = 1_000_000;

/** Smallest order total for a currency listing, in USD cents ($1.00). */
export const MIN_CURRENCY_ORDER_USD_CENTS = 100;

export const DELIVERY_TIMES = { '15m': 15, '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440 } as const;
export type DeliveryTime = keyof typeof DELIVERY_TIMES;
export const DELIVERY_TIME_KEYS = Object.keys(DELIVERY_TIMES) as DeliveryTime[];
export const isDeliveryTime = (v: unknown): v is DeliveryTime => typeof v === 'string' && v in DELIVERY_TIMES;
/** Round 26b: the seller types the delivery speed (minutes or hours); any whole number of minutes from 1 to 72 h. */
export const MIN_DELIVERY_MINUTES = 1;
export const MAX_DELIVERY_MINUTES = 72 * 60;
/** The list entry for a number of minutes (the smallest one that is not shorter), e.g. 90 → '3h'; over 24 h → '24h'. */
export function deliveryTimeFor(minutes: number): DeliveryTime {
  return DELIVERY_TIME_KEYS.find((k) => DELIVERY_TIMES[k] >= minutes) ?? '24h';
}
/** "45m", "2h", "90" (minutes) → minutes; null when malformed or outside 1 min – 72 h. */
export function parseDeliveryMinutes(v: string | number): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= MIN_DELIVERY_MINUTES && v <= MAX_DELIVERY_MINUTES ? v : null;
  const m = /^\s*(\d{1,5})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const minutes = m[2] && /^h/i.test(m[2]) ? n * 60 : n;
  return minutes >= MIN_DELIVERY_MINUTES && minutes <= MAX_DELIVERY_MINUTES ? minutes : null;
}
/** Minutes → the shortest human form: 45 → "45m", 120 → "2h", 90 → "1h 30m". */
export function formatDeliveryMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

/**
 * Round 26b: a tier is "from this many units, X % off" or "from this many units, this unit price" (micro-units).
 * `percentOff` is the Round 25 spelling of a percent tier and is still accepted on input; stored tiers carry `type`.
 */
export interface VolumeDiscount {
  /** Orders of at least this many units… */
  minQty: number;
  type: 'percent' | 'fixed';
  /** percent: 1–50 (% off the base unit price); fixed: the unit price in micro-units, below the base and below the previous tier. */
  value: number;
}
export type VolumeDiscountInput = VolumeDiscount | { minQty: number; percentOff: number };
export const MAX_VOLUME_DISCOUNTS = 4;
export const MAX_VOLUME_PERCENT = 50;

/** The Round 25 spelling ({minQty, percentOff}) as a typed tier; a typed tier passes through. */
export function normaliseTier(t: VolumeDiscountInput): VolumeDiscount {
  if ('percentOff' in t && (t as { type?: unknown }).type == null) return { minQty: t.minQty, type: 'percent', value: t.percentOff };
  const v = t as VolumeDiscount;
  return { minQty: v.minQty, type: v.type, value: v.value };
}

/** "0.000123" → 123. Up to 6 decimals, no sign, no exponent; ".14" means 0.14. Null when malformed. */
export function parseUnitPrice(v: string): number | null {
  const m = /^(\d{0,9})(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m || (m[1] === '' && m[2] == null)) return null;
  const micros = Number(m[1] || '0') * MICROS_PER_UNIT + Number((m[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
}

/** 123 → "0.000123" (always six decimals). */
export function formatUnitPrice(micros: number): string {
  const whole = Math.floor(micros / MICROS_PER_UNIT);
  return `${whole}.${String(micros % MICROS_PER_UNIT).padStart(6, '0')}`;
}
/** 140000 → "0.14", 123 → "0.000123": full precision, trailing zeros trimmed (what the web shows). */
export function formatUnitPriceTrimmed(micros: number): string {
  return formatUnitPrice(micros).replace(/\.?0+$/, '');
}

/**
 * Validate tiers against the base unit price: quantities above the listing's minimum and rising; percent tiers 1–50 %
 * and rising; fixed tiers below the base unit price; each tier's effective unit price below the previous tier's.
 */
export function checkVolumeDiscounts(tiers: VolumeDiscountInput[] | undefined | null, minQty = 1, baseMicros?: number): { ok: true; value: VolumeDiscount[] } | { ok: false; error: string } {
  if (!tiers?.length) return { ok: true, value: [] };
  if (tiers.length > MAX_VOLUME_DISCOUNTS) return { ok: false, error: `Up to ${MAX_VOLUME_DISCOUNTS} volume discounts` };
  const sorted = tiers.map(normaliseTier).sort((a, b) => a.minQty - b.minQty);
  let prevQty = minQty;
  let prevMicros = baseMicros ?? Number.MAX_SAFE_INTEGER;
  for (const t of sorted) {
    if (!Number.isSafeInteger(t.minQty) || t.minQty <= prevQty) return { ok: false, error: 'Each volume discount needs a larger quantity than the one before (and than the minimum order)' };
    if (t.type !== 'percent' && t.type !== 'fixed') return { ok: false, error: 'A volume discount is a % off or a fixed unit price' };
    if (t.type === 'percent') {
      if (!Number.isInteger(t.value) || t.value < 1 || t.value > MAX_VOLUME_PERCENT) return { ok: false, error: `A volume discount is 1 to ${MAX_VOLUME_PERCENT}% off` };
    } else {
      if (!Number.isSafeInteger(t.value) || t.value < 1) return { ok: false, error: 'A fixed-price tier is a unit price of at least 0.000001' };
      if (baseMicros != null && t.value >= baseMicros) return { ok: false, error: 'A fixed-price tier must be below the base unit price' };
    }
    const micros = baseMicros != null ? tierMicros(baseMicros, t) : t.type === 'fixed' ? t.value : Number.MAX_SAFE_INTEGER - t.value;
    if (micros >= prevMicros) return { ok: false, error: 'Each volume discount must be cheaper than the one before it' };
    prevQty = t.minQty;
    prevMicros = micros;
  }
  return { ok: true, value: sorted };
}

/** The unit price a tier gives, in micro-units: the base less the percent (rounded up), or the fixed price. */
export function tierMicros(baseMicros: number, t: VolumeDiscount): number {
  if (t.type === 'fixed') return Math.min(t.value, baseMicros);
  return Number((BigInt(baseMicros) * BigInt(100 - t.value) + 99n) / 100n);
}

/** The tier an order of `quantity` reaches (the highest minQty not above it), or null. */
export function tierFor(tiers: readonly VolumeDiscountInput[] | null | undefined, quantity: number): VolumeDiscount | null {
  let best: VolumeDiscount | null = null;
  for (const raw of tiers ?? []) {
    const t = normaliseTier(raw);
    if (quantity >= t.minQty && (!best || t.minQty > best.minQty)) best = t;
  }
  return best;
}

/** The % off an order of `quantity` gets against the base price (0 when it reaches no tier). Fixed tiers are expressed as the % they amount to. */
export function volumePercentFor(tiers: readonly VolumeDiscountInput[] | null | undefined, quantity: number, baseMicros?: number): number {
  const t = tierFor(tiers, quantity);
  if (!t) return 0;
  if (t.type === 'percent') return t.value;
  if (!baseMicros) return 0;
  return Math.round(((baseMicros - Math.min(t.value, baseMicros)) / baseMicros) * 100 * 100) / 100;
}

/** The unit price an order of `quantity` pays: the tier it reaches (percent rounded up to the micro-unit, or the fixed price), else the base. */
export function unitMicrosFor(baseMicros: number, tiers: readonly VolumeDiscountInput[] | null | undefined, quantity: number): number {
  const t = tierFor(tiers, quantity);
  return t ? tierMicros(baseMicros, t) : baseMicros;
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
