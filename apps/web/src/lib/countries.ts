import { currentLocale } from '../i18n';

/**
 * Round 29 (CEO, 5 Nov): the withdrawal form is the ONLY place a country is named or chosen (to list the payout methods
 * available there); everywhere else it's a region (lib/regions.ts). Names come from the browser in the reader's language
 * (Intl.DisplayNames), so EN and AR need no list of our own. SANCTIONED countries can't withdraw (the API also blocks
 * them by connection country).
 */
export const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ ' +
  'OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');
export const SANCTIONED = new Set(['IR', 'KP', 'SY', 'CU']);

const cache = new Map<string, Intl.DisplayNames | null>();
export function countryName(code: string | null | undefined, locale = currentLocale()): string {
  if (!code) return '';
  if (!cache.has(locale)) {
    try {
      cache.set(locale, new Intl.DisplayNames([locale === 'ar' ? 'ar' : locale], { type: 'region' }));
    } catch {
      cache.set(locale, null);
    }
  }
  const dn = cache.get(locale);
  return (code === 'XK' ? 'Kosovo' : dn?.of(code)) ?? code;
}
/** Every country, named in the reader's language and sorted for it. */
export function countryOptions(locale = currentLocale()): Array<{ value: string; label: string }> {
  return COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c, locale) })).sort((a, b) => a.label.localeCompare(b.label, locale));
}
export const isSanctioned = (country: string | null | undefined) => !!country && SANCTIONED.has(country.toUpperCase());
