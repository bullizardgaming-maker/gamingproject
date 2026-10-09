/**
 * Quantity price tiers: cheaper unit prices for larger orders. No dependencies, so the web app
 * bundles this module too and shows the same prices the API charges.
 */
export interface PriceTier {
  /** Orders of at least this many units… */
  minQty: number;
  /** …pay this unit price, in the listing currency's minor units. */
  priceCents: number;
}
export const MAX_PRICE_TIERS = 5;

/** Validate tiers against the base price: quantities from 2 going up, unit prices going down. */
export function checkTiers(basePriceCents: number, tiers: PriceTier[] | undefined, kind: string): { ok: true; value: PriceTier[] } | { ok: false; error: string } {
  if (!tiers?.length) return { ok: true, value: [] };
  if (kind === 'account') return { ok: false, error: 'Accounts are sold one at a time, so they have no quantity prices' };
  if (tiers.length > MAX_PRICE_TIERS) return { ok: false, error: `Up to ${MAX_PRICE_TIERS} quantity prices` };
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let prevQty = 1;
  let prevPrice = basePriceCents;
  for (const t of sorted) {
    if (!Number.isInteger(t.minQty) || t.minQty <= prevQty) return { ok: false, error: 'Each quantity price needs a larger quantity than the one before (from 2 up)' };
    if (!Number.isInteger(t.priceCents) || t.priceCents <= 0 || t.priceCents >= prevPrice) return { ok: false, error: 'Each quantity price must be lower than the one before it and the base price' };
    prevQty = t.minQty;
    prevPrice = t.priceCents;
  }
  return { ok: true, value: sorted.map((t) => ({ minQty: t.minQty, priceCents: t.priceCents })) };
}

/** The unit price an order of `quantity` pays: the best tier it reaches, never above the base price. */
export function unitPriceFor(offer: { price_cents: number; price_tiers?: PriceTier[] | null }, quantity: number) {
  let unit = offer.price_cents;
  for (const t of offer.price_tiers ?? []) if (quantity >= t.minQty && t.priceCents < unit) unit = t.priceCents;
  return unit;
}
