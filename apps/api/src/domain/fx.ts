import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
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

/**
 * Round 29d (M4, CFO 6): the Central Bank of Egypt's official rate for EGP. The CBE publishes its daily rates as a web
 * page (no API); the USD row's buy/sell mid is taken. Only EGP comes from here.
 */
export class CbeFxProvider implements FxProvider {
  readonly name = 'cbe';
  constructor(private readonly url = 'https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates') {}
  async fetch(settlement: string) {
    if (settlement !== 'USD') throw new Error('CBE rates are read against USD only');
    const res = await fetch(this.url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'text/html' } });
    if (!res.ok) throw new Error(`CBE rates ${res.status}`);
    const rate = parseCbeUsd(await res.text());
    if (!rate) throw new Error('CBE page: no US Dollar row');
    return { EGP: rate };
  }
}
/** The "US Dollar | buy | sell" row of the CBE table → mid rate (EGP per 1 USD). Exported for the parser test. */
export function parseCbeUsd(html: string): number | null {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = /US\s*Dollar\s+([\d]+(?:\.\d+)?)\s+([\d]+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  const buy = Number(m[1]);
  const sell = Number(m[2]);
  if (!(buy > 0 && sell > 0) || sell < buy || sell / buy > 1.1) return null;
  return Math.round(((buy + sell) / 2) * 1e6) / 1e6;
}

/** What a composite source reports per currency: the rate and which source gave it (and whether that was a fallback). */
export interface DetailedRate {
  rate: number;
  source: string;
  fallback: boolean;
}
export interface DetailedFxProvider extends FxProvider {
  fetchDetailed(settlement: string): Promise<Record<string, DetailedRate>>;
}
export const isDetailed = (p: FxProvider): p is DetailedFxProvider => typeof (p as DetailedFxProvider).fetchDetailed === 'function';

/**
 * Several sources in order of trust: the first one that has a currency wins. Round 29d (M4): a currency may name its
 * official source (`preferred`, e.g. EGP → cbe, EUR → ecb); a rate taken from any other source is flagged `fallback`
 * so Ops sees the official feed was down.
 */
export class CompositeFxProvider implements DetailedFxProvider {
  readonly name: string;
  constructor(private readonly providers: FxProvider[], private readonly preferred: Record<string, string> = {}) {
    this.name = providers.map((p) => p.name).join('+');
  }
  async fetchDetailed(settlement: string) {
    const out: Record<string, DetailedRate> = {};
    let ok = false;
    for (const p of this.providers) {
      try {
        const rates = await p.fetch(settlement);
        for (const [c, r] of Object.entries(rates)) if (!(c in out) && r > 0) out[c] = { rate: r, source: p.name, fallback: !!this.preferred[c] && this.preferred[c] !== p.name };
        ok = true;
      } catch {
        // a source being down must not block the others
      }
    }
    if (!ok) throw new Error('no FX source answered');
    return out;
  }
  async fetch(settlement: string) {
    return Object.fromEntries(Object.entries(await this.fetchDetailed(settlement)).map(([c, r]) => [c, r.rate]));
  }
}

export function supportedCurrencies(ctx: Ctx): string[] {
  return ctx.cfg.SUPPORTED_CURRENCIES.split(',').map((c) => c.trim().toUpperCase());
}

export function assertSupported(ctx: Ctx, currency: string) {
  if (!supportedCurrencies(ctx).includes(currency)) throw badRequest('unsupported_currency', `Supported currencies: ${supportedCurrencies(ctx).join(', ')}`);
}

/** Fetch and store rates, then re-price non-settlement listings for search. A live Finance override is left alone. */
export async function refreshRates(ctx: Ctx): Promise<number> {
  const settlement = ctx.cfg.SETTLEMENT_CURRENCY;
  const all: Record<string, DetailedRate> = isDetailed(ctx.fx)
    ? await ctx.fx.fetchDetailed(settlement)
    : Object.fromEntries(Object.entries(await ctx.fx.fetch(settlement)).map(([c, r]) => [c, { rate: r, source: ctx.fx.name, fallback: false }]));
  const wanted = supportedCurrencies(ctx).filter((c) => c !== settlement);
  let n = 0;
  for (const c of wanted) {
    const got = all[c];
    if (!got || !(got.rate > 0)) continue;
    const rate = got.rate;
    const updated = await ctx.db.query(
      `INSERT INTO fx_rates (currency, rate, source, fetched_at, fallback) VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (currency) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now(), fallback = EXCLUDED.fallback, override_until = NULL, override_note = NULL
         WHERE fx_rates.override_until IS NULL OR fx_rates.override_until < now()`,
      [c, rate, got.source, got.fallback],
    );
    if (!updated.rowCount) continue; // a Finance override still in force
    await ctx.db.query(
      `UPDATE offers SET price_settlement_cents = round(CASE WHEN sale_active AND sale_price_cents IS NOT NULL THEN sale_price_cents ELSE price_cents END / $2::numeric),
              price_settlement_micros = round(CASE WHEN sale_active AND sale_price_cents IS NOT NULL THEN sale_price_cents * 10000 ELSE COALESCE(unit_price_micros, price_cents * 10000) END / $2::numeric)
        WHERE currency = $1`,
      [c, rate],
    );
    n++;
  }
  return n;
}

/** The most recent 10:00 Cairo (the CFO's daily update time) at or before `now`. */
export function lastDailyUpdateAt(now = new Date(), hour = 10, tz = 'Africa/Cairo'): Date {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // local wall-clock offset of the zone at `now`
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = local - now.getTime();
  let target = Date.UTC(get('year'), get('month') - 1, get('day'), hour, 0, 0) - offsetMs;
  if (target > now.getTime()) target -= 86_400_000;
  return new Date(target);
}

/** Worker: the CFO's schedule — once a day at 10:00 Cairo (and whenever a currency has no rate yet). */
export async function maybeRefreshRates(ctx: Ctx) {
  const settlement = ctx.cfg.SETTLEMENT_CURRENCY;
  const wanted = supportedCurrencies(ctx).filter((c) => c !== settlement);
  const rows = await many<{ currency: string; fetched_at: string }>(ctx.db, 'SELECT currency, fetched_at FROM fx_rates');
  const missing = wanted.some((c) => !rows.some((r) => r.currency === c));
  const due = lastDailyUpdateAt(new Date(), ctx.cfg.FX_REFRESH_HOUR_CAIRO).getTime();
  const behind = rows.some((r) => new Date(r.fetched_at).getTime() < due);
  if (!missing && !behind) return 0;
  return refreshRates(ctx);
}

/**
 * Round 29d (M4): Finance overrides a rate in Ops. A change of 2 % or less applies at once; more than that waits for a
 * second approver (another fx.manage holder). An override holds for 24 hours, then the daily feed takes over again.
 */
export const FX_OVERRIDE_SECOND_APPROVER_BPS = 200;
export const FX_OVERRIDE_HOURS = 24;
export async function requestRateOverride(ctx: Ctx, actor: { id: string }, input: { currency: string; rate: number; note: string }) {
  const currency = input.currency.toUpperCase();
  if (currency === ctx.cfg.SETTLEMENT_CURRENCY) throw badRequest('settlement_currency', 'The settlement currency has no rate to override');
  assertSupported(ctx, currency);
  if (!(input.rate > 0)) throw badRequest('invalid_rate', 'Rate must be positive');
  const current = await maybeOne<{ rate: string }>(ctx.db, 'SELECT rate::text AS rate FROM fx_rates WHERE currency = $1', [currency]);
  const previous = current ? Number(current.rate) : null;
  const changeBps = previous ? Math.round((Math.abs(input.rate - previous) / previous) * 10_000) : 0;
  await ctx.db.query(`UPDATE fx_rate_overrides SET status = 'superseded', decided_at = now() WHERE currency = $1 AND status = 'pending'`, [currency]);
  const row = await one<any>(
    ctx.db,
    `INSERT INTO fx_rate_overrides (currency, rate, previous_rate, change_bps, note, requested_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
    [currency, input.rate, previous, changeBps, input.note, actor.id],
  );
  if (changeBps > FX_OVERRIDE_SECOND_APPROVER_BPS) {
    return { ...row, applied: false, needs_second_approver: true, change_bps: changeBps };
  }
  await applyOverride(ctx, row, actor.id, true);
  return { ...(await one<any>(ctx.db, 'SELECT * FROM fx_rate_overrides WHERE id = $1', [row.id])), applied: true, needs_second_approver: false, change_bps: changeBps };
}
export async function decideRateOverride(ctx: Ctx, actor: { id: string }, id: string, approve: boolean) {
  const row = await maybeOne<any>(ctx.db, 'SELECT * FROM fx_rate_overrides WHERE id = $1', [id]);
  if (!row) throw new AppError(404, 'not_found', 'Override not found');
  if (row.status !== 'pending') throw new AppError(409, 'invalid_state', `This override is ${row.status}`);
  if (row.requested_by === actor.id) throw new AppError(409, 'second_person_required', 'The second approval must come from another Finance member');
  if (!approve) {
    await ctx.db.query(`UPDATE fx_rate_overrides SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [id, actor.id]);
  } else {
    await applyOverride(ctx, row, actor.id, false);
  }
  return one<any>(ctx.db, 'SELECT * FROM fx_rate_overrides WHERE id = $1', [id]);
}
async function applyOverride(ctx: Ctx, row: { id: string; currency: string; rate: string | number; note: string }, actorId: string, self: boolean) {
  const rate = Number(row.rate);
  await ctx.db.query(
    `INSERT INTO fx_rates (currency, rate, source, fetched_at, fallback, override_until, override_note) VALUES ($1, $2, 'override', now(), false, now() + make_interval(hours => $3), $4)
       ON CONFLICT (currency) DO UPDATE SET rate = EXCLUDED.rate, source = 'override', fetched_at = now(), fallback = false, override_until = EXCLUDED.override_until, override_note = EXCLUDED.override_note`,
    [row.currency, rate, FX_OVERRIDE_HOURS, row.note],
  );
  await ctx.db.query(
    `UPDATE offers SET price_settlement_cents = round(CASE WHEN sale_active AND sale_price_cents IS NOT NULL THEN sale_price_cents ELSE price_cents END / $2::numeric),
            price_settlement_micros = round(CASE WHEN sale_active AND sale_price_cents IS NOT NULL THEN sale_price_cents * 10000 ELSE COALESCE(unit_price_micros, price_cents * 10000) END / $2::numeric)
      WHERE currency = $1`,
    [row.currency, rate],
  );
  // a self-applied small change has no second person: decided_by stays empty (the table forbids requester = decider)
  await ctx.db.query(`UPDATE fx_rate_overrides SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [row.id, self ? null : actorId]);
}
export async function listRateOverrides(ctx: Ctx) {
  return many<any>(
    ctx.db,
    `SELECT o.*, (SELECT display_name FROM users WHERE id = o.requested_by) AS requested_by_name, (SELECT display_name FROM users WHERE id = o.decided_by) AS decided_by_name
       FROM fx_rate_overrides o ORDER BY o.requested_at DESC LIMIT 50`,
  );
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

/**
 * Round 25 (B6): the rates in use, exactly as stored (8 decimals, as strings), against USD, with when each was fetched
 * (`as_of`). A checkout price in another currency is held for `quote_ttl_seconds` once locked on the order.
 */
export async function currentRates(ctx: Ctx) {
  const rows = await many<{ currency: string; rate: string; fetched_at: string; source: string; fallback: boolean; override_until: string | null }>(ctx.db, 'SELECT currency, rate::text AS rate, fetched_at, source, fallback, override_until FROM fx_rates ORDER BY currency');
  const asOf = rows.length ? rows.map((r) => new Date(r.fetched_at).getTime()).reduce((a, b) => Math.min(a, b)) : null;
  return {
    base: ctx.cfg.SETTLEMENT_CURRENCY,
    settlement: ctx.cfg.SETTLEMENT_CURRENCY,
    spreadBps: ctx.cfg.FX_SPREAD_BPS,
    quote_ttl_seconds: ctx.cfg.FX_QUOTE_TTL_MINUTES * 60,
    as_of: asOf != null ? new Date(asOf).toISOString() : null,
    exact: Object.fromEntries(rows.map((r) => [r.currency, r.rate])),
    // Round 29d (M4): `fallback` = the official feed (CBE for EGP, ECB for EUR) was down and another source answered;
    // `override_until` = a Finance override is in force.
    rates: rows.map((r) => ({ currency: r.currency, rate: r.rate, fetched_at: r.fetched_at, as_of: r.fetched_at, source: r.source, fallback: r.fallback, override_until: r.override_until && new Date(r.override_until).getTime() > Date.now() ? r.override_until : null })),
  };
}
