import type { Ctx } from '../context.js';
import { assertSupported } from './fx.js';

/**
 * Round 25 (B5): the ways a buyer can pay, from config (PAYMENT_METHODS_JSON) so a method can be added without code:
 *   [{ "id": "crypto", "currencies": ["USD", "EUR"], "enabled": true },
 *    { "id": "vodafone_cash", "currencies": ["EGP"], "enabled": false, "viewerCurrencies": ["EGP"] }]
 *  - `currencies`: what the method charges in. A viewer whose currency is not one of them pays in the first (an EGP
 *    viewer pays crypto in USD); `pay_currency` says which.
 *  - `viewerCurrencies` (optional): list the method only to viewers in these currencies.
 *  - Only enabled methods are listed. Settlement and payouts stay USD whatever the method.
 * A method other than crypto also needs its payment code before it can take money; listing it is all config does.
 */
export interface PaymentMethodConfig {
  id: string;
  currencies: string[];
  enabled: boolean;
  viewerCurrencies?: string[];
}

export const DEFAULT_PAYMENT_METHODS: PaymentMethodConfig[] = [{ id: 'crypto', currencies: ['USD', 'EUR'], enabled: true }];

export function paymentMethodConfig(raw: string | undefined): PaymentMethodConfig[] {
  if (!raw?.trim()) return DEFAULT_PAYMENT_METHODS;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('PAYMENT_METHODS_JSON is not valid JSON');
  }
  if (!Array.isArray(list)) throw new Error('PAYMENT_METHODS_JSON must be a JSON array');
  return list.map((m: any, i) => {
    if (!m || typeof m.id !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(m.id)) throw new Error(`PAYMENT_METHODS_JSON[${i}].id must be a lower-case id`);
    if (!Array.isArray(m.currencies) || !m.currencies.length || m.currencies.some((c: unknown) => typeof c !== 'string' || !/^[A-Z]{3}$/.test(c))) {
      throw new Error(`PAYMENT_METHODS_JSON[${i}].currencies must be ISO codes, e.g. ["USD"]`);
    }
    if (m.viewerCurrencies != null && (!Array.isArray(m.viewerCurrencies) || m.viewerCurrencies.some((c: unknown) => typeof c !== 'string' || !/^[A-Z]{3}$/.test(c)))) {
      throw new Error(`PAYMENT_METHODS_JSON[${i}].viewerCurrencies must be ISO codes`);
    }
    return { id: m.id, currencies: m.currencies, enabled: m.enabled === true, ...(m.viewerCurrencies ? { viewerCurrencies: m.viewerCurrencies } : {}) };
  });
}

/** The enabled methods for a viewer in `currency` (any when omitted), each with the currency they would pay in. */
export function paymentMethodsFor(ctx: Ctx, currency?: string) {
  if (currency) assertSupported(ctx, currency);
  return paymentMethodConfig(ctx.cfg.PAYMENT_METHODS_JSON)
    .filter((m) => m.enabled && (!currency || !m.viewerCurrencies || m.viewerCurrencies.includes(currency)))
    .map((m) => ({ id: m.id, currencies: m.currencies, enabled: true, pay_currency: currency && m.currencies.includes(currency) ? currency : m.currencies[0]! }));
}

/** The currencies crypto invoices may be priced in (USD always; EUR when the crypto method lists it). */
export function cryptoPriceCurrencies(ctx: Ctx): string[] {
  const m = paymentMethodConfig(ctx.cfg.PAYMENT_METHODS_JSON).find((x) => x.id === 'crypto' && x.enabled);
  return (m?.currencies ?? ['USD']).filter((c) => c === 'USD' || c === 'EUR');
}
