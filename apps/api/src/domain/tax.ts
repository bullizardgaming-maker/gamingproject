import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest } from '../lib/errors.js';

export const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

export type TaxTreatment = 'standard' | 'reverse_charge' | 'outside_scope';

export interface SellerTaxProfile {
  tax_country: string | null;
  tax_id: string | null;
  tax_id_verified_at: string | null;
  is_business: boolean;
}

/**
 * Where the commission is taxed and how. The commission is a service to the seller:
 *  - EU business seller with a verified VAT number in another EU country: reverse charge (0%)
 *  - EU consumer seller: the seller's country rate (reported through OSS)
 *  - seller in the platform's own country: the platform country rate
 *  - consumer seller in a non-EU country where the platform is registered (TAX_REGISTERED_COUNTRIES): that rate
 *  - anyone else: outside the scope of our VAT (business sellers self-account)
 * A seller who hasn't said where they are is taxed like a local consumer until they do.
 */
export function taxTreatment(ctx: Ctx, p: SellerTaxProfile): { country: string; treatment: TaxTreatment } {
  const home = ctx.cfg.PLATFORM_TAX_COUNTRY;
  const country = p.tax_country ?? home;
  const verifiedBusiness = p.is_business && !!p.tax_id && !!p.tax_id_verified_at;
  if (country === home) return { country, treatment: 'standard' };
  if (EU.has(country) && EU.has(home)) return { country, treatment: verifiedBusiness ? 'reverse_charge' : 'standard' };
  const registered = ctx.cfg.TAX_REGISTERED_COUNTRIES.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (registered.includes(country) && !p.is_business) return { country, treatment: 'standard' };
  return { country, treatment: p.is_business ? 'reverse_charge' : 'outside_scope' };
}

export async function rateFor(q: Queryable, country: string, on = new Date()): Promise<number> {
  const row = await maybeOne<{ rate_bps: number }>(
    q,
    'SELECT rate_bps FROM tax_rates WHERE country = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1',
    [country, on.toISOString().slice(0, 10)],
  );
  return row?.rate_bps ?? 0;
}

/** Tax contained in a VAT-inclusive commission. */
export const taxInside = (grossCents: number, rateBps: number) => Math.round((grossCents * rateBps) / (10_000 + rateBps));

export async function taxForCommission(ctx: Ctx, q: Queryable, sellerId: string, commissionCents: number) {
  const profile = await one<SellerTaxProfile>(q, 'SELECT tax_country, tax_id, tax_id_verified_at, is_business FROM users WHERE id = $1', [sellerId]);
  const { country, treatment } = taxTreatment(ctx, profile);
  const rateBps = treatment === 'standard' ? await rateFor(q, country) : 0;
  return { country, treatment, rateBps, taxCents: taxInside(commissionCents, rateBps) };
}

// ---------------------------------------------------------------------------
// Seller tax profile
// ---------------------------------------------------------------------------
/** Loose per-country shape checks; the registry check (VIES) is authoritative. */
const VAT_FORMAT: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, HR: /^\d{11}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DK: /^\d{8}$/,
  EE: /^\d{9}$/, FI: /^\d{8}$/, FR: /^[0-9A-Z]{2}\d{9}$/, DE: /^\d{9}$/, GR: /^\d{9}$/, HU: /^\d{8}$/, IE: /^\d{7}[A-Z]{1,2}$|^\d[A-Z]\d{5}[A-Z]$/,
  IT: /^\d{11}$/, LV: /^\d{11}$/, LT: /^\d{9}$|^\d{12}$/, LU: /^\d{8}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/,
  PT: /^\d{9}$/, RO: /^\d{2,10}$/, SK: /^\d{10}$/, SI: /^\d{8}$/, ES: /^[0-9A-Z]\d{7}[0-9A-Z]$/, SE: /^\d{12}$/,
  GB: /^\d{9}$|^\d{12}$/,
};

export async function setTaxProfile(
  ctx: Ctx,
  userId: string,
  input: { country: string; isBusiness: boolean; taxId?: string | null; billingAddress?: string | null },
) {
  const country = input.country.toUpperCase();
  let taxId = input.taxId ? input.taxId.toUpperCase().replace(/[\s.-]/g, '') : null;
  // Accept numbers typed with their country prefix ("DE123456789", "EL...").
  if (taxId && (taxId.startsWith(country) || (country === 'GR' && taxId.startsWith('EL')))) taxId = taxId.slice(2);
  if (taxId && VAT_FORMAT[country] && !VAT_FORMAT[country]!.test(taxId)) throw badRequest('invalid_tax_id', `That doesn't look like a ${country} VAT number`);
  if (input.isBusiness && EU.has(country) && !taxId) throw badRequest('tax_id_required', 'EU businesses need a VAT number for reverse charge');

  const verified = taxId && EU.has(country) ? await ctx.vat.check(country, taxId) : null;
  if (verified === false) throw badRequest('tax_id_not_registered', 'VIES says this VAT number is not registered');
  await ctx.db.query(
    `UPDATE users SET tax_country = $2, is_business = $3, tax_id = $4, billing_address = $5, tax_id_verified_at = $6 WHERE id = $1`,
    [userId, country, input.isBusiness, taxId, input.billingAddress ?? null, verified ? new Date() : null],
  );
  return getTaxProfile(ctx, userId);
}

export async function getTaxProfile(ctx: Ctx, userId: string) {
  const p = await one<SellerTaxProfile & { billing_address: string | null }>(
    ctx.db,
    'SELECT tax_country, tax_id, tax_id_verified_at, is_business, billing_address FROM users WHERE id = $1',
    [userId],
  );
  const t = taxTreatment(ctx, p);
  const rateBps = t.treatment === 'standard' ? await rateFor(ctx.db, t.country) : 0;
  return {
    country: p.tax_country,
    isBusiness: p.is_business,
    taxId: p.tax_id,
    taxIdVerified: !!p.tax_id_verified_at,
    billingAddress: p.billing_address,
    commissionTax: { ...t, rateBps, note: t.treatment === 'reverse_charge' ? 'Reverse charge: you account for VAT on our commission yourself.' : undefined },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
/** Commission and tax by country and treatment for a period (the basis for OSS/VAT returns). */
export async function taxReport(ctx: Ctx, from: string, to: string) {
  return many(
    ctx.db,
    `SELECT tax_country AS country, tax_treatment AS treatment, tax_rate_bps AS rate_bps, currency,
            count(*)::int AS orders, SUM(commission_cents)::bigint AS commission_gross_cents,
            SUM(commission_tax_cents)::bigint AS tax_cents, SUM(commission_cents - commission_tax_cents)::bigint AS commission_net_cents
       FROM orders
      WHERE tax_treatment IS NOT NULL AND completed_at >= $1::date AND completed_at < $2::date
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3`,
    [from, to],
  );
}

export async function setRate(ctx: Ctx, country: string, rateBps: number, name: string, validFrom: string) {
  return one(
    ctx.db,
    `INSERT INTO tax_rates (country, rate_bps, name, valid_from) VALUES ($1, $2, $3, $4)
     ON CONFLICT (country, valid_from) DO UPDATE SET rate_bps = EXCLUDED.rate_bps, name = EXCLUDED.name RETURNING *`,
    [country.toUpperCase(), rateBps, name, validFrom],
  );
}
