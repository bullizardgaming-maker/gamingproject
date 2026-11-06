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

const COUNTRY_REGIONS: Record<Exclude<Region, 'global'>, string> = {
  middle_east: 'EG SA AE QA KW BH OM JO LB SY IQ IR IL PS YE TR LY TN DZ MA SD',
  europe: 'GB IE FR DE ES PT IT NL BE LU CH AT DK SE NO FI IS PL CZ SK HU RO BG GR HR SI RS BA ME MK AL XK EE LV LT UA MD BY RU CY MT AD MC SM VA LI GI FO GL',
  america: 'US CA MX BR AR CL CO PE VE EC BO PY UY GT HN SV NI CR PA CU DO HT JM TT BS BB PR BZ GY SR',
  asia: 'CN JP KR TW HK MO IN PK BD LK NP BT MV ID MY SG TH VN PH MM KH LA BN MN KZ UZ KG TJ TM AF AZ GE AM AU NZ',
};
const REGION_BY_COUNTRY = new Map<string, Region>();
for (const [region, codes] of Object.entries(COUNTRY_REGIONS)) for (const c of codes.split(' ')) REGION_BY_COUNTRY.set(c, region as Region);
/** Round 29c: the region of a connection country — shown in security emails instead of the country name. */
export const regionForCountry = (country: string | null | undefined): Region => REGION_BY_COUNTRY.get(normCountry(country) ?? '') ?? 'global';

const ISO2 = /^[A-Z]{2}$/;
export const normCountry = (c: string | null | undefined) => {
  const v = c ? c.trim().toUpperCase() : null;
  return v && ISO2.test(v) ? v : null;
};
const list = (raw: string) => new Set(raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => ISO2.test(c)));
export const sanctionedCountries = (ctx: Ctx) => list(ctx.cfg.SANCTIONED_COUNTRIES);
export const cryptoBlockedCountries = (ctx: Ctx) => list(ctx.cfg.CRYPTO_BLOCKED_COUNTRIES);
export const isSanctionedCountry = (ctx: Ctx, country: string | null | undefined) => !!normCountry(country) && sanctionedCountries(ctx).has(normCountry(country)!);
/**
 * Security audit (Nov 2026): Cloudflare marks Tor exits as "T1" and connections it can't place as "XX". Tor is treated like
 * a sanctioned country (it is how a blocked user would hide) and gets no crypto; an unknown country can't withdraw.
 * requestMeta() reports "XX" when the country header is configured but missing on a request that came through Cloudflare.
 */
export const TOR_COUNTRY = 'T1';
export const UNKNOWN_COUNTRY = 'XX';
const raw = (c: string | null | undefined) => (c ? c.trim().toUpperCase() : null);
export const isCryptoBlockedCountry = (ctx: Ctx, country: string | null | undefined) => raw(country) === TOR_COUNTRY || (!!normCountry(country) && cryptoBlockedCountries(ctx).has(normCountry(country)!));

export const NOT_AVAILABLE_HERE_MSG = "Bullizard isn't available here";
/** 451 country_not_supported when the connection's country (or the withdrawal country) is sanctioned. */
export function assertNotSanctioned(ctx: Ctx, country: string | null | undefined, what: 'signup' | 'buy' | 'sell' | 'withdraw') {
  if (isSanctionedCountry(ctx, country) || raw(country) === TOR_COUNTRY || (what === 'withdraw' && raw(country) === UNKNOWN_COUNTRY)) {
    throw new AppError(451, 'country_not_supported', NOT_AVAILABLE_HERE_MSG, { action: what });
  }
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
