import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { accountId, post } from './ledger.js';
import { enqueueEmail } from './notifications.js';
import type { TxScope } from './events.js';
import { isCryptoBlockedCountry } from './geo.js';

/**
 * Round 29b (CFO, 5 Nov): the wallet. Every user has one; it holds a balance per currency (USD from crypto; EGP from the
 * Egyptian methods once the PSP is live; EUR). "Add funds" is a deposit through a method with its own fee, minimum and
 * maximum (DEPOSIT_METHODS_JSON; the CFO table is the default). The deposit fee is the payment provider's charge and is
 * never refunded. A crypto deposit is a NOWPayments invoice: the amount plus the 0.5 % processing fee, credited to the
 * USD balance when NOWPayments says finished (same boundaries as an order). Crypto deposits are hidden where checkout
 * crypto is hidden (the connection's country).
 */
export const DEPOSIT_METHODS = ['crypto', 'card_egypt', 'wallet', 'instapay'] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export interface DepositRule {
  pctBps: number;
  fixedCents: number;
  minCents: number;
  maxCents: number;
  currency: 'USD' | 'EGP';
  enabled: boolean;
  label: string;
}
export const CFO_DEPOSIT_METHODS: Record<DepositMethod, DepositRule> = {
  crypto: { pctBps: 0, fixedCents: 0, minCents: 500, maxCents: 200_000, currency: 'USD', enabled: true, label: 'Crypto (USDT & more)' },
  card_egypt: { pctBps: 375, fixedCents: 400, minCents: 5_000, maxCents: 5_000_000, currency: 'EGP', enabled: false, label: 'Card (Egypt)' },
  wallet: { pctBps: 375, fixedCents: 400, minCents: 5_000, maxCents: 3_000_000, currency: 'EGP', enabled: false, label: 'Mobile wallet' },
  instapay: { pctBps: 375, fixedCents: 400, minCents: 5_000, maxCents: 5_000_000, currency: 'EGP', enabled: false, label: 'InstaPay' },
};
export function depositMethodTable(ctx: Ctx): Record<DepositMethod, DepositRule> {
  const out: Record<DepositMethod, DepositRule> = { ...CFO_DEPOSIT_METHODS };
  const raw = ctx.cfg.DEPOSIT_METHODS_JSON?.trim();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEPOSIT_METHODS_JSON is not valid JSON');
  }
  for (const m of DEPOSIT_METHODS) {
    const e = (parsed as any)?.[m];
    if (!e) continue;
    const r = { ...out[m] };
    for (const f of ['pctBps', 'fixedCents', 'minCents', 'maxCents'] as const) if (e[f] != null) r[f] = Number(e[f]);
    if (typeof e.enabled === 'boolean') r.enabled = e.enabled;
    if (typeof e.label === 'string') r.label = e.label;
    out[m] = r;
  }
  return out;
}

/** The methods a user can add funds with here: crypto hidden where the connection is from a CRYPTO_BLOCKED_COUNTRIES country. */
export function depositMethodsFor(ctx: Ctx, ipCountry: string | null | undefined) {
  const t = depositMethodTable(ctx);
  // Crypto is hidden (not listed) where the connection is from Egypt — the same rule as /payment-methods at checkout.
  const cryptoHidden = isCryptoBlockedCountry(ctx, ipCountry);
  return DEPOSIT_METHODS.filter((id) => !(id === 'crypto' && cryptoHidden)).map((id) => ({
    id, label: t[id].label, currency: t[id].currency, enabled: t[id].enabled,
    fee: { pct_bps: t[id].pctBps, fixed_cents: t[id].fixedCents },
    // Crypto: the buyer also pays NOWPayments' processing fee on top (NOWPAYMENTS_FEE_BPS), like an order.
    processing_fee_bps: id === 'crypto' ? ctx.cfg.NOWPAYMENTS_FEE_BPS : 0,
    min_cents: t[id].minCents, max_cents: t[id].maxCents,
    unavailable_reason: !t[id].enabled ? 'coming_soon' : null,
  }));
}

export function depositQuote(ctx: Ctx, method: DepositMethod, amountCents: number) {
  const r = depositMethodTable(ctx)[method];
  if (amountCents < r.minCents) throw badRequest('below_minimum', `The minimum deposit for this method is ${(r.minCents / 100).toFixed(2)} ${r.currency}`, { minCents: r.minCents, currency: r.currency });
  if (amountCents > r.maxCents) throw badRequest('above_maximum', `The maximum deposit for this method is ${(r.maxCents / 100).toFixed(2)} ${r.currency}`, { maxCents: r.maxCents, currency: r.currency });
  const fee = Math.ceil((amountCents * r.pctBps) / 10_000) + r.fixedCents;
  const processingFee = method === 'crypto' ? Math.ceil((amountCents * ctx.cfg.NOWPAYMENTS_FEE_BPS) / 10_000) : 0;
  return { method, currency: r.currency, amountCents, feeCents: fee, processingFeeCents: processingFee, totalCents: amountCents + fee + processingFee };
}

/** A deposit row as the web sees it. */
export const VIEW = 'id, user_id, method, currency, amount_cents, fee_cents, total_cents, status, payment_provider, credited_at, created_at, updated_at';

/** Creates the deposit (awaiting_payment); the caller starts the crypto invoice on it. */
export async function createDeposit(ctx: Ctx, userId: string, input: { method: DepositMethod; amountCents: number; ipCountry?: string | null }) {
  const t = depositMethodTable(ctx)[input.method];
  if (!t.enabled) throw new AppError(409, 'method_coming_soon', 'This way of adding funds is coming soon');
  if (input.method !== 'crypto') throw new AppError(409, 'method_coming_soon', 'This way of adding funds is coming soon');
  if (isCryptoBlockedCountry(ctx, input.ipCountry)) throw new AppError(403, 'method_unavailable_here', "This payment method isn't available here yet — you can still browse and sell", { method: 'crypto' });
  const q = depositQuote(ctx, input.method, input.amountCents);
  // CFO: a new account (first 7 days) adds at most NEW_ACCOUNT_MAX_PAID_USD_PER_DAY a day.
  const u = await one<{ age_hours: number; today: string }>(
    ctx.db,
    `SELECT EXTRACT(EPOCH FROM (now() - u.created_at)) / 3600 AS age_hours,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM wallet_deposits d WHERE d.user_id = u.id AND d.status IN ('awaiting_payment', 'credited') AND d.created_at > now() - interval '24 hours')::text AS today
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (Number(u.age_hours) < 24 * 7 && Number(u.today) + q.amountCents > ctx.cfg.NEW_ACCOUNT_MAX_PAID_USD_PER_DAY * 100) {
    throw new AppError(429, 'velocity_limit', `New accounts can add up to $${ctx.cfg.NEW_ACCOUNT_MAX_PAID_USD_PER_DAY} a day during their first week`, { limit: 'deposit_usd', max: ctx.cfg.NEW_ACCOUNT_MAX_PAID_USD_PER_DAY });
  }
  // One open crypto deposit at a time: the previous one lapses.
  await ctx.db.query(`UPDATE wallet_deposits SET status = 'cancelled', updated_at = now() WHERE user_id = $1 AND status = 'awaiting_payment' AND created_at < now() - interval '2 hours'`, [userId]);
  return one<any>(
    ctx.db,
    `INSERT INTO wallet_deposits (user_id, method, currency, amount_cents, fee_cents, total_cents, payment_provider, payment_ref, ip_country)
     VALUES ($1, $2, $3, $4, $5, $6, 'nowpayments', 'dep_' || replace(gen_random_uuid()::text, '-', ''), $7) RETURNING ${VIEW}`,
    [userId, input.method, q.currency, q.amountCents, q.feeCents, q.amountCents + q.feeCents, input.ipCountry ?? null],
  );
}

export async function depositOf(q: Queryable, userId: string, id: string) {
  const d = await maybeOne<any>(q, `SELECT ${VIEW} FROM wallet_deposits WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!d) throw notFound('Deposit');
  return d;
}
export const listDeposits = (q: Queryable, userId: string) => many<any>(q, `SELECT ${VIEW} FROM wallet_deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);

/**
 * The money arrived (same checks as an order): the amount lands in the wallet, the processing fee the buyer paid on top
 * covers NOWPayments' charge, anything else is FX gain / loss. Called inside the apply transaction with the row locked.
 */
export async function creditDeposit(s: TxScope, deposit: { id: string; user_id: string; currency: string; amount_cents: number; fee_cents: number }, money: { settledCents: number; feeCents: number; processingFeeCents: number; overpaidCents: number }) {
  const cur = await one<{ status: string }>(s.tx, 'SELECT status FROM wallet_deposits WHERE id = $1 FOR UPDATE', [deposit.id]);
  if (cur.status !== 'awaiting_payment') throw conflict('invalid_state', `This deposit is ${cur.status}`);
  const amount = Number(deposit.amount_cents);
  const fx = money.settledCents - amount - money.overpaidCents - money.processingFeeCents;
  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'gateway_clearing', deposit.currency), amountCents: -money.settledCents },
      { account: await accountId(s.tx, 'user_credit', deposit.currency, deposit.user_id), amountCents: amount + money.overpaidCents },
      ...(money.processingFeeCents > 0 ? [{ account: await accountId(s.tx, 'treasury', deposit.currency), amountCents: money.processingFeeCents }] : []),
      ...(fx !== 0 ? [{ account: await accountId(s.tx, 'fx_pnl', deposit.currency), amountCents: fx }] : []),
    ],
    'wallet_deposit',
  );
  if (money.feeCents > 0) {
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'gateway_clearing', deposit.currency), amountCents: money.feeCents },
        { account: await accountId(s.tx, 'treasury', deposit.currency), amountCents: -money.feeCents },
      ],
      'psp_fee',
    );
  }
  await s.tx.query(`UPDATE wallet_deposits SET status = 'credited', credited_at = now(), updated_at = now() WHERE id = $1`, [deposit.id]);
  await enqueueEmail(s.tx, deposit.user_id, 'wallet_deposit_credited', { amount_cents: amount, overpaid_cents: money.overpaidCents, processing_fee_cents: money.processingFeeCents, currency: deposit.currency });
  s.notifyUser(deposit.user_id, 'wallet.deposit_credited', { depositId: deposit.id, amountCents: amount + money.overpaidCents });
}

/**
 * Round 29b (CFO 7): top-up → withdraw without spending is allowed, but a repeated pattern is reviewed by staff before
 * the money leaves: TOPUP_REVIEW_CYCLES+ credited deposits in 30 days with under TOPUP_REVIEW_SPENT_PCT spent, or any
 * deposit above TOPUP_REVIEW_CYCLE_MAX_CENTS in 30 days. Returns the reasons in words (empty = nothing to review).
 */
export async function topupWithdrawReview(ctx: Ctx, q: Queryable, userId: string): Promise<string[]> {
  const r = await one<{ deposits: number; deposited: string; biggest: string; spent: string }>(
    q,
    `SELECT (SELECT count(*)::int FROM wallet_deposits d WHERE d.user_id = $1 AND d.status = 'credited' AND d.credited_at > now() - interval '30 days') AS deposits,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM wallet_deposits d WHERE d.user_id = $1 AND d.status = 'credited' AND d.credited_at > now() - interval '30 days')::text AS deposited,
            (SELECT COALESCE(MAX(amount_cents), 0)::bigint FROM wallet_deposits d WHERE d.user_id = $1 AND d.status = 'credited' AND d.credited_at > now() - interval '30 days')::text AS biggest,
            (SELECT COALESCE(SUM(credit_cents), 0)::bigint FROM orders o WHERE o.buyer_id = $1 AND o.paid_at > now() - interval '30 days' AND o.status NOT IN ('cancelled'))::text AS spent`,
    [userId],
  );
  const reasons: string[] = [];
  const deposited = Number(r.deposited), spent = Number(r.spent), biggest = Number(r.biggest);
  if (!r.deposits) return reasons;
  const spentPct = deposited > 0 ? Math.round((spent * 100) / deposited) : 0;
  if (r.deposits >= ctx.cfg.TOPUP_REVIEW_CYCLES && spentPct < ctx.cfg.TOPUP_REVIEW_SPENT_PCT) reasons.push(`${r.deposits} top-ups in 30 days ($${(deposited / 100).toFixed(2)}) with ${spentPct} % spent — withdrawing without buying`);
  if (biggest > ctx.cfg.TOPUP_REVIEW_CYCLE_MAX_CENTS && spentPct < ctx.cfg.TOPUP_REVIEW_SPENT_PCT) reasons.push(`A top-up of $${(biggest / 100).toFixed(2)} in the last 30 days with ${spentPct} % spent`);
  return reasons;
}
