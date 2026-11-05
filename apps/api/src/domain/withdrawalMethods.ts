import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { getRate } from './fx.js';
import { normCountry } from './geo.js';

/**
 * Round 29 (2) + CFO decisions (5 Nov): withdrawal methods and what each asks for.
 *  - usdt:     network (BEP-20 / TRC-20) + address — sent by NOWPayments. Fee 3.99 % + $1, min $5 (BEP-20) / $10 (TRC-20), max $5,000.
 *  - wallet:   a mobile-wallet phone number (Vodafone Cash & co.) — sent by Finance by hand. 6 % + EGP 10, min EGP 100, max EGP 30,000.
 *  - instapay: an InstaPay address (name@bank) or the phone linked to it — sent by Finance. 6 % + EGP 5, min EGP 100, max EGP 50,000.
 *  - bank: later.
 * The balance is USD; an EGP method is quoted at the CFO rate table (CBE rate + the 1 % margin) and the payout amount in
 * EGP is fixed on the withdrawal. Fee rules come from WITHDRAWAL_FEES_JSON (keys below); the CFO table is the default.
 * The phone / IPA is encrypted at rest, used for the payout only, and confirmed by the emailed code like an address change.
 */
export const WITHDRAWAL_METHODS = ['usdt', 'wallet', 'instapay'] as const;
export type WithdrawalMethod = (typeof WITHDRAWAL_METHODS)[number];
export const MANUAL_METHODS: ReadonlySet<string> = new Set(['wallet', 'instapay']);
export const isWithdrawalMethod = (m: unknown): m is WithdrawalMethod => (WITHDRAWAL_METHODS as readonly unknown[]).includes(m);

/** A fee rule key: the method, or the method + network for USDT. */
export type FeeKey = 'usdt_bep20' | 'usdt_trc20' | 'wallet' | 'instapay';
export interface FeeRule {
  /** Percentage, in basis points. */
  pctBps: number;
  /** Fixed part, in minor units of `currency`. */
  fixedCents: number;
  /** A floor on the fee (the pre-CFO "6 %, at least $1.50" model), in minor units of `currency`; 0 = none. */
  minFeeCents?: number;
  /** Smallest withdrawal, in minor units of `currency`. */
  minCents: number;
  /** Largest single payout, in minor units of `currency`. */
  maxCents: number;
  /** The currency the rule (and the payout) is in. */
  currency: 'USD' | 'EGP';
}
export const CFO_WITHDRAWAL_FEES: Record<FeeKey, FeeRule> = {
  usdt_bep20: { pctBps: 399, fixedCents: 100, minCents: 500, maxCents: 500_000, currency: 'USD' },
  usdt_trc20: { pctBps: 399, fixedCents: 100, minCents: 1_000, maxCents: 500_000, currency: 'USD' },
  wallet: { pctBps: 600, fixedCents: 1_000, minCents: 10_000, maxCents: 3_000_000, currency: 'EGP' },
  instapay: { pctBps: 600, fixedCents: 500, minCents: 10_000, maxCents: 5_000_000, currency: 'EGP' },
};
export const NETWORK_KEYS: Record<string, FeeKey> = { usdtbsc: 'usdt_bep20', usdttrc20: 'usdt_trc20' };
export const feeKeyFor = (method: WithdrawalMethod, network?: string | null): FeeKey => (method === 'usdt' ? NETWORK_KEYS[(network ?? 'usdtbsc').toLowerCase()] ?? 'usdt_bep20' : method);

export function withdrawalFeeTable(ctx: Ctx): Record<FeeKey, FeeRule> {
  const out: Record<FeeKey, FeeRule> = { ...CFO_WITHDRAWAL_FEES };
  const raw = ctx.cfg.WITHDRAWAL_FEES_JSON?.trim();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WITHDRAWAL_FEES_JSON is not valid JSON');
  }
  for (const k of Object.keys(out) as FeeKey[]) {
    const e = (parsed as any)?.[k];
    if (!e) continue;
    const r: FeeRule = { ...out[k] };
    for (const f of ['pctBps', 'fixedCents', 'minCents', 'maxCents', 'minFeeCents'] as const) {
      if (e[f] == null) continue;
      if (!Number.isInteger(Number(e[f])) || Number(e[f]) < 0) throw new Error(`WITHDRAWAL_FEES_JSON.${k}.${f} must be a non-negative integer`);
      r[f] = Number(e[f]);
    }
    if (e.bps != null) r.pctBps = Number(e.bps); // the Round 29 spelling
    if (e.currency === 'USD' || e.currency === 'EGP') r.currency = e.currency;
    if (r.pctBps > 5000) throw new Error(`WITHDRAWAL_FEES_JSON.${k}.pctBps is too high`);
    out[k] = r;
  }
  return out;
}

export interface FeeQuote {
  key: FeeKey;
  rule: FeeRule;
  /** Fee and net in USD cents (the balance currency). */
  feeCents: number;
  netCents: number;
  /** The payout currency and amount the user receives (USD = net; EGP = net × rate). */
  payoutCurrency: 'USD' | 'EGP';
  payoutAmountCents: number;
  /** Units of the payout currency per USD, margin included (1 for USD). */
  rate: number;
  /** The minimum / maximum in USD cents, for the form. */
  minUsdCents: number;
  maxUsdCents: number;
}
/** The rate used for an EGP method: the CFO table rate (CBE) plus the FX margin (FX_SPREAD_BPS, 1 %). */
async function payoutRate(ctx: Ctx, q: Queryable, currency: 'USD' | 'EGP') {
  if (currency === 'USD') return 1;
  return (await getRate(ctx, q, currency)) * (1 - ctx.cfg.FX_SPREAD_BPS / 10_000);
}
/**
 * The fee for a withdrawal of `amountCents` (USD) through a method: `pct` of the amount plus the fixed part (converted
 * from the rule's currency), never more than the amount. Throws `below_minimum` / `above_maximum` with the limits in USD.
 */
export async function withdrawalFeeQuote(ctx: Ctx, q: Queryable, method: WithdrawalMethod, network: string | null | undefined, amountCents: number): Promise<FeeQuote> {
  const key = feeKeyFor(method, network);
  const rule = withdrawalFeeTable(ctx)[key];
  const rate = await payoutRate(ctx, q, rule.currency);
  const toUsd = (c: number) => Math.ceil(c / rate);
  const minUsdCents = toUsd(rule.minCents);
  const maxUsdCents = Math.floor(rule.maxCents / rate);
  if (amountCents < minUsdCents) throw badRequest('below_minimum', `The minimum withdrawal for this method is ${(rule.minCents / 100).toFixed(2)} ${rule.currency}`, { minCents: minUsdCents, minMethodCents: rule.minCents, currency: rule.currency });
  if (amountCents > maxUsdCents) throw badRequest('above_maximum', `The maximum per payout for this method is ${(rule.maxCents / 100).toFixed(2)} ${rule.currency}`, { maxCents: maxUsdCents, maxMethodCents: rule.maxCents, currency: rule.currency });
  const feeCents = Math.min(amountCents, Math.max(toUsd(rule.minFeeCents ?? 0), Math.ceil((amountCents * rule.pctBps) / 10_000) + toUsd(rule.fixedCents)));
  const netCents = amountCents - feeCents;
  return { key, rule, feeCents, netCents, payoutCurrency: rule.currency, payoutAmountCents: rule.currency === 'USD' ? netCents : Math.floor(netCents * rate), rate, minUsdCents, maxUsdCents };
}

/**
 * What the web shows for the country picked on the withdrawal form: each method available there, the fields it asks
 * for and its fee rule(s). USDT everywhere that is not sanctioned; the manual methods where MANUAL_PAYOUT_COUNTRIES says.
 */
export function withdrawalMethodsFor(ctx: Ctx, country?: string | null) {
  const fees = withdrawalFeeTable(ctx);
  const c = normCountry(country);
  const manualHere = !!c && ctx.cfg.MANUAL_PAYOUT_COUNTRIES.split(',').map((x) => x.trim().toUpperCase()).includes(c);
  // `bps` / `minCents` are the names the web used first (frontend-requests §4); the snake_case ones carry the full CFO rule.
  const pub = (r: FeeRule) => ({ bps: r.pctBps, minCents: r.minCents, pct_bps: r.pctBps, fixed_cents: r.fixedCents, min_fee_cents: r.minFeeCents ?? 0, min_cents: r.minCents, max_cents: r.maxCents, currency: r.currency });
  const all = [
    {
      id: 'usdt', label: 'USDT (crypto)', fields: ['network', 'address'], sent_by: 'provider', available: true, currency: 'USD',
      networks: [
        { coin: 'usdtbsc', label: 'BEP-20 (BNB Smart Chain)', fee: pub(fees.usdt_bep20), default: true },
        { coin: 'usdttrc20', label: 'TRC-20 (Tron)', fee: pub(fees.usdt_trc20), default: false },
      ],
      fee: pub(fees.usdt_bep20),
    },
    { id: 'wallet', label: 'Mobile wallet', fields: ['phone'], sent_by: 'finance', available: manualHere, currency: 'EGP', fee: pub(fees.wallet) },
    { id: 'instapay', label: 'InstaPay', fields: ['ipa'], sent_by: 'finance', available: manualHere, currency: 'EGP', fee: pub(fees.instapay), hint: 'InstaPay address (name@bank) or the phone linked to it' },
  ] as const;
  return { country: c, methods: all.filter((m) => m.available) };
}
export function methodAvailableIn(ctx: Ctx, method: WithdrawalMethod, country: string) {
  return withdrawalMethodsFor(ctx, country).methods.some((m) => m.id === method);
}

/** Validates and normalises the identifier a method asks for; returns the value to encrypt and a masked hint for display. */
export function cleanIdentifier(method: WithdrawalMethod, raw: string): { value: string; hint: string } {
  const v = raw.trim();
  if (method === 'wallet') {
    const digits = v.replace(/[\s()-]/g, '');
    // E.164-ish or an Egyptian local number (01x xxxx xxxx); 8–15 digits.
    if (!/^\+?\d{8,15}$/.test(digits)) throw badRequest('invalid_phone', 'Enter the wallet’s phone number (digits only, e.g. 01012345678 or +201012345678)');
    return { value: digits, hint: `•••• ${digits.slice(-4)}` };
  }
  if (method === 'instapay') {
    const digits = v.replace(/[\s()-]/g, '');
    if (/^\+?\d{8,15}$/.test(digits)) return { value: digits, hint: `•••• ${digits.slice(-4)}` };
    if (/^[a-z0-9._-]{2,64}@[a-z0-9-]{2,32}$/i.test(v)) return { value: v.toLowerCase(), hint: `${v[0]}•••@${v.split('@')[1]!.toLowerCase()}` };
    throw badRequest('invalid_ipa', 'Enter your InstaPay address (name@bank) or the phone number linked to it');
  }
  throw badRequest('invalid_method', 'That withdrawal method takes an address, not an identifier');
}
