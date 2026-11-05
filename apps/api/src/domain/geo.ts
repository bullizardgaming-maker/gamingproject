import type { Ctx } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';

/**
 * Round 29 (1): regions, not countries (CEO, 5 Nov). Bullizard never shows a country name: where a place is shown or
 * chosen it is one of the five regions. The only country a user types is the one on the withdrawal form, so we can
 * list the methods available there.
 *  - `CRYPTO_BLOCKED_COUNTRIES` (EG): crypto is hidden / refused at checkout by the CONNECTION's country
 *    (Cloudflare CF-IPCountry) → 403 `method_unavailable_here`. A VPN user sees crypto; the Terms carry that.
 *  - `SANCTIONED_COUNTRIES` (IR, KP, SY, CU): blocked by connection country (sign-up, buy, sell) and by the withdrawal
 *    country (withdraw) → 451 `country_not_supported`. (Crimea / Donetsk / Luhansk are regions the edge header cannot
 *    name; the name/wallet screening covers them.)
 *  - The IP country is stored on sessions and orders for staff and feeds the fraud score; it never blocks on its own.
 */
export const REGIONS = ['asia', 'middle_east', 'america', 'europe', 'global'] as const;
export type Region = (typeof REGIONS)[number];
export const REGION_LABELS: Record<Region, string> = { asia: 'Asia', middle_east: 'Middle East', america: 'America', europe: 'Europe', global: 'Global' };
export const isRegion = (v: unknown): v is Region => (REGIONS as readonly unknown[]).includes(v);

const ISO2 = /^[A-Z]{2}$/;
export const normCountry = (c: string | null | undefined) => {
  const v = c ? c.trim().toUpperCase() : null;
  return v && ISO2.test(v) ? v : null;
};
const list = (raw: string) => new Set(raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => ISO2.test(c)));
export const sanctionedCountries = (ctx: Ctx) => list(ctx.cfg.SANCTIONED_COUNTRIES);
export const cryptoBlockedCountries = (ctx: Ctx) => list(ctx.cfg.CRYPTO_BLOCKED_COUNTRIES);
export const isSanctionedCountry = (ctx: Ctx, country: string | null | undefined) => !!normCountry(country) && sanctionedCountries(ctx).has(normCountry(country)!);
export const isCryptoBlockedCountry = (ctx: Ctx, country: string | null | undefined) => !!normCountry(country) && cryptoBlockedCountries(ctx).has(normCountry(country)!);

export const NOT_AVAILABLE_HERE_MSG = "Bullizard isn't available here";
/** 451 country_not_supported when the connection's country (or the withdrawal country) is sanctioned. */
export function assertNotSanctioned(ctx: Ctx, country: string | null | undefined, what: 'signup' | 'buy' | 'sell' | 'withdraw') {
  if (isSanctionedCountry(ctx, country)) throw new AppError(451, 'country_not_supported', NOT_AVAILABLE_HERE_MSG, { action: what });
}

export const METHOD_UNAVAILABLE_MSG = "This payment method isn't available here yet — you can still browse and sell";
/** 403 method_unavailable_here when the connection's country is one where crypto is hidden (Egypt). */
export function assertCryptoAllowedHere(ctx: Ctx, ipCountry: string | null | undefined) {
  if (isCryptoBlockedCountry(ctx, ipCountry)) throw new AppError(403, 'method_unavailable_here', METHOD_UNAVAILABLE_MSG, { method: 'crypto' });
}

/** The country typed on the withdrawal form: ISO-3166 alpha-2, never a sanctioned one. */
export function cleanWithdrawalCountry(ctx: Ctx, raw: string | null | undefined): string {
  const c = normCountry(raw);
  if (!c) throw badRequest('invalid_country', 'Pick the country you withdraw in');
  assertNotSanctioned(ctx, c, 'withdraw');
  return c;
}
