import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne } from '../db.js';
import { AppError, badRequest } from '../lib/errors.js';

/**
 * Exchange rates. Internally everything (escrow, ledger, seller balances,
 * commission tiers) is in the settlement currency. Other currencies appear at
 * two edges only:
 *  - listings may be priced in EUR/EGP; the price is converted at order time
 *  - buyers may pay in EUR/EGP; the amount is fixed at order time with the
 *    rate plus a small spread, and never changes afterwards (locked at checkout)
 * Rates are stored as "units of X per 1 settlement unit".
 */
export interface FxProvider {
  readonly name: string;
  fetch(settlement: string): Promise<Record<string, number>>;
}

export class StaticFxProvider implements FxProvider {
  readonly name = 'static';
  constructor(private readonly rates: Record<string, number>) {}
  async fetch() {
    return this.rates;
  }
}

/** European Central Bank daily reference rates (free, no key). Published against EUR; rebased here. */
export class EcbFxProvider implements FxProvider {
  readonly name = 'ecb';
  async fetch(settlement: string) {
    const res = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ECB rates ${res.status}`);
    const xml = await res.text();
    const perEur: Record<string, number> = { EUR: 1 };
    for (const m of xml.matchAll(/currency='([A-Z]{3})' rate='([\d.]+)'/g)) perEur[m[1]!] = Number(m[2]);
    const base = perEur[settlement];
    if (!base) throw new Error(`ECB has no rate for ${settlement}`);
    return Object.fromEntries(Object.entries(perEur).filter(([c]) => c !== settlement).map(([c, r]) => [c, r / base]));
  }
}

/** open.er-api.com: free daily rates against any base, covering EGP and other non-ECB currencies. */
export class OpenRatesFxProvider implements FxProvider {
  readonly name = 'open-er-api';
  async fetch(settlement: string) {
    const res = await fetch(`https://open.er-api.com/v6/latest/${settlement}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`open.er-api ${res.status}`);
    const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (body.result !== 'success' || !body.rates) throw new Error('open.er-api: no rates');
    return Object.fromEntries(Object.entries(body.rates).filter(([c]) => c !== settlement));
  }
}

/** Several sources in order of trust: the first one that has a currency wins. */
export class CompositeFxProvider implements FxProvider {
  readonly name: string;
  constructor(private readonly providers: FxProvider[]) {
    this.name = providers.map((p) => p.name).join('+');
  }
  async fetch(settlement: string) {
    const out: Record<string, number> = {};
    let ok = false;
    for (const p of this.providers) {
      try {
        const rates = await p.fetch(settlement);
        for (const [c, r] of Object.entries(rates)) if (!(c in out)) out[c] = r;
        ok = true;
      } catch {
        // a source being down must not block the others
      }
    }
    if (!ok) throw new Error('no FX source answered');
    return out;
  }
}

export function supportedCurrencies(ctx: Ctx): string[] {
  return ctx.cfg.SUPPORTED_CURRENCIES.split(',').map((c) => c.trim().toUpperCase());
}

export function assertSupported(ctx: Ctx, currency: string) {
  if (!supportedCurrencies(ctx).includes(currency)) throw badRequest('unsupported_currency', `Supported currencies: ${supportedCurrencies(ctx).join(', ')}`);
}

/** Fetch and store rates, then re-price non-settlement listings for search. */
export async function refreshRates(ctx: Ctx): Promise<number> {
  const settlement = ctx.cfg.SETTLEMENT_CURRENCY;
  const all = await ctx.fx.fetch(settlement);
  const wanted = supportedCurrencies(ctx).filter((c) => c !== settlement);
  let n = 0;
  for (const c of wanted) {
    const rate = all[c];
    if (!rate || !(rate > 0)) continue;
    await ctx.db.query(
      `INSERT INTO fx_rates (currency, rate, source, fetched_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (currency) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
      [c, rate, ctx.fx.name],
    );
    await ctx.db.query(
      `UPDATE offers SET price_settlement_cents = round(CASE WHEN sale_active AND sale_price_cents IS NOT NULL THEN sale_price_cents ELSE price_cents END / $2::numeric) WHERE currency = $1`,
      [c, rate],
    );
    n++;
  }
  return n;
}

/** Worker: refresh hourly. */
export async function maybeRefreshRates(ctx: Ctx) {
  const stale = await maybeOne(ctx.db, `SELECT 1 FROM fx_rates WHERE fetched_at > now() - interval '1 hour' LIMIT 1`);
  if (stale) return 0;
  return refreshRates(ctx);
}

/** Units of `currency` per 1 settlement unit. Refuses stale rates rather than pricing with old data. */
export async function getRate(ctx: Ctx, q: Queryable, currency: string): Promise<number> {
  if (currency === ctx.cfg.SETTLEMENT_CURRENCY) return 1;
  assertSupported(ctx, currency);
  let row = await maybeOne<{ rate: number; fetched_at: string }>(q, 'SELECT rate, fetched_at FROM fx_rates WHERE currency = $1', [currency]);
  if (!row) {
    await refreshRates(ctx).catch((err) => ctx.log.warn({ err: (err as Error).message }, 'fx refresh failed'));
    row = await maybeOne(q, 'SELECT rate, fetched_at FROM fx_rates WHERE currency = $1', [currency]);
  }
  if (!row || Date.now() - new Date(row.fetched_at).getTime() > ctx.cfg.FX_MAX_AGE_HOURS * 3_600_000) {
    throw new AppError(503, 'fx_unavailable', `Payments in ${currency} are temporarily unavailable. Try ${ctx.cfg.SETTLEMENT_CURRENCY}.`);
  }
  return Number(row.rate);
}

export async function currentRates(ctx: Ctx) {
  const rows = await many<{ currency: string; rate: number; fetched_at: string }>(ctx.db, 'SELECT currency, rate, fetched_at FROM fx_rates ORDER BY currency');
  return { settlement: ctx.cfg.SETTLEMENT_CURRENCY, spreadBps: ctx.cfg.FX_SPREAD_BPS, rates: rows };
}
