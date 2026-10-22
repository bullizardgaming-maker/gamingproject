import type { Queryable } from '../db.js';
import { one } from '../db.js';

export interface SellerTier {
  name: 'Normal' | 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  minMonthlySalesCents: number;
  accountRateBps: number;
  otherRateBps: number;
}

/** Ordered lowest -> highest. Monthly sales = gross completed sales over the trailing 30 days. */
export const SELLER_TIERS: readonly SellerTier[] = [
  { name: 'Normal', minMonthlySalesCents: 0, accountRateBps: 1299, otherRateBps: 999 },
  { name: 'Common', minMonthlySalesCents: 300_00, accountRateBps: 1199, otherRateBps: 899 },
  { name: 'Uncommon', minMonthlySalesCents: 1_000_00, accountRateBps: 1099, otherRateBps: 799 },
  { name: 'Rare', minMonthlySalesCents: 5_000_00, accountRateBps: 999, otherRateBps: 699 },
  { name: 'Epic', minMonthlySalesCents: 10_000_00, accountRateBps: 899, otherRateBps: 599 },
  { name: 'Legendary', minMonthlySalesCents: 20_000_00, accountRateBps: 799, otherRateBps: 499 },
];

export function tierForVolume(monthlySalesCents: number): SellerTier {
  let tier = SELLER_TIERS[0]!;
  for (const t of SELLER_TIERS) if (monthlySalesCents >= t.minMonthlySalesCents) tier = t;
  return tier;
}

export function nextTier(tier: SellerTier): SellerTier | null {
  const idx = SELLER_TIERS.indexOf(tier);
  return SELLER_TIERS[idx + 1] ?? null;
}

export interface CategoryPricing {
  kind: string;
  promo_rate_bps: number | null;
}

export function commissionBps(tier: SellerTier, category: CategoryPricing): number {
  if (category.promo_rate_bps != null) return category.promo_rate_bps;
  return category.kind === 'account' ? tier.accountRateBps : tier.otherRateBps;
}

/** Commission is rounded half-up to the cent; the seller receives the exact remainder so the split always sums. */
export function splitAmount(amountCents: number, rateBps: number) {
  const commission = Math.floor((amountCents * rateBps + 5_000) / 10_000);
  return { commissionCents: commission, sellerNetCents: amountCents - commission };
}

export async function monthlySalesCents(q: Queryable, sellerId: string): Promise<number> {
  const row = await one<{ total: number }>(
    q,
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM orders
      WHERE seller_id = $1 AND status = 'completed' AND completed_at > now() - interval '30 days'`,
    [sellerId],
  );
  return row.total;
}

export async function sellerTier(q: Queryable, sellerId: string) {
  const volume = await monthlySalesCents(q, sellerId);
  const tier = tierForVolume(volume);
  const next = nextTier(tier);
  return {
    tier,
    monthlySalesCents: volume,
    next: next ? { tier: next, remainingCents: next.minMonthlySalesCents - volume } : null,
  };
}
