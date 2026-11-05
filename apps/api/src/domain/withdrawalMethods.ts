import type { Ctx } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { normCountry } from './geo.js';

/**
 * Round 29 (2): withdrawal methods and what each asks for (CEO decision 2).
 *  - usdt:     network (TRC-20 / BEP-20) + address — sent by NOWPayments.
 *  - wallet:   a mobile-wallet phone number (Egypt: Vodafone Cash, Orange Money, Etisalat Cash, WE Pay) — sent by Finance by hand.
 *  - instapay: an InstaPay address (name@bank) or the phone linked to it — sent by Finance by hand.
 *  - bank: later.
 * The phone / IPA is encrypted at rest, used for the payout only, and confirmed by the emailed code like an address change.
 * Fees per method come from WITHDRAWAL_FEES_JSON (CFO values); a method without an entry uses WITHDRAWAL_FEE_BPS / MIN.
 */
export const WITHDRAWAL_METHODS = ['usdt', 'wallet', 'instapay'] as const;
export type WithdrawalMethod = (typeof WITHDRAWAL_METHODS)[number];
export const MANUAL_METHODS: ReadonlySet<string> = new Set(['wallet', 'instapay']);

export const isWithdrawalMethod = (m: unknown): m is WithdrawalMethod => (WITHDRAWAL_METHODS as readonly unknown[]).includes(m);

export interface MethodFee {
  bps: number;
  minCents: number;
}
export function withdrawalFeeTable(ctx: Ctx): Record<WithdrawalMethod, MethodFee> {
  const base: MethodFee = { bps: ctx.cfg.WITHDRAWAL_FEE_BPS, minCents: ctx.cfg.WITHDRAWAL_FEE_MIN_CENTS };
  const out: Record<WithdrawalMethod, MethodFee> = { usdt: base, wallet: base, instapay: base };
  const raw = ctx.cfg.WITHDRAWAL_FEES_JSON?.trim();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WITHDRAWAL_FEES_JSON is not valid JSON');
  }
  for (const m of WITHDRAWAL_METHODS) {
    const e = (parsed as any)?.[m];
    if (!e) continue;
    const bps = Number(e.bps), minCents = Number(e.minCents);
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000 || !Number.isInteger(minCents) || minCents < 0) throw new Error(`WITHDRAWAL_FEES_JSON.${m} needs integer bps (0–5000) and minCents`);
    out[m] = { bps, minCents };
  }
  return out;
}

export function withdrawalFeeFor(ctx: Ctx, method: WithdrawalMethod, amountCents: number) {
  const f = withdrawalFeeTable(ctx)[method];
  return Math.min(amountCents, Math.max(f.minCents, Math.ceil((amountCents * f.bps) / 10_000)));
}

/**
 * What the web shows for the country picked on the withdrawal form: each method available there, the fields it asks
 * for and its fee rule. USDT everywhere that is not sanctioned; the manual methods where MANUAL_PAYOUT_COUNTRIES says.
 */
export function withdrawalMethodsFor(ctx: Ctx, country?: string | null) {
  const fees = withdrawalFeeTable(ctx);
  const c = normCountry(country);
  const manualHere = !!c && ctx.cfg.MANUAL_PAYOUT_COUNTRIES.split(',').map((x) => x.trim().toUpperCase()).includes(c);
  const all = [
    { id: 'usdt', label: 'USDT (crypto)', fields: ['network', 'address'], networks: ['usdttrc20', 'usdtbsc'], fee: fees.usdt, sent_by: 'provider', available: true },
    { id: 'wallet', label: 'Mobile wallet', fields: ['phone'], fee: fees.wallet, sent_by: 'finance', available: manualHere },
    { id: 'instapay', label: 'InstaPay', fields: ['ipa'], fee: fees.instapay, sent_by: 'finance', hint: 'InstaPay address (name@bank) or the phone linked to it', available: manualHere },
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
