import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, one, withTx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { assertSupported, getRate } from './fx.js';
import { accountId, balance, post, type Posting } from './ledger.js';

/**
 * Seller balances in the seller's own currency.
 *
 * Orders are settled and escrowed in the settlement currency. A seller whose payout currency
 * differs is credited in their currency at the mid-market rate locked on the order, so the
 * buyer's conversion is the only one: an EUR seller selling at EUR 92 gets EUR 92 minus
 * commission, and is paid out in EUR. The platform carries the currency position in between
 * (fx_position accounts) and closes it with recorded conversions.
 */
interface SellerFxOrder {
  id: string;
  seller_id: string;
  currency: string;
  seller_currency: string | null;
  seller_fx_rate: number | string | null;
}

export const sellerCurrencyOf = (o: SellerFxOrder) => o.seller_currency ?? o.currency;

/** Settlement cents -> seller-currency cents, rounding symmetrically so debits mirror credits. */
export function toSellerCurrency(o: SellerFxOrder, settlementCents: number) {
  if (sellerCurrencyOf(o) === o.currency) return settlementCents;
  const v = Math.round(Math.abs(settlementCents) * Number(o.seller_fx_rate));
  return settlementCents < 0 ? -v : v;
}

/** Seller-currency cents -> settlement cents (rounded down: never take more than the seller has). */
export function toSettlement(o: SellerFxOrder, sellerCents: number) {
  if (sellerCurrencyOf(o) === o.currency) return sellerCents;
  return Math.floor(sellerCents / Number(o.seller_fx_rate));
}

/**
 * The seller's side of a settlement-currency posting. Same currency: their balance line.
 * Different currency: posts the seller-currency leg now (fx_position -> seller balance, in
 * this transaction) and returns the settlement-currency line against fx_position.
 */
export async function sellerLeg(tx: Tx, o: SellerFxOrder, settlementCents: number, memo: string): Promise<Posting> {
  const cur = sellerCurrencyOf(o);
  if (cur === o.currency) return { account: await accountId(tx, 'seller_available', cur, o.seller_id), amountCents: settlementCents };
  const local = toSellerCurrency(o, settlementCents);
  await post(
    tx,
    [
      { account: await accountId(tx, 'fx_position', cur), amountCents: -local },
      { account: await accountId(tx, 'seller_available', cur, o.seller_id), amountCents: local },
    ],
    memo,
    o.id,
  );
  return { account: await accountId(tx, 'fx_position', o.currency), amountCents: settlementCents };
}

/** Currency and mid rate to lock on a new order for this seller. */
export async function sellerRateFor(ctx: Ctx, q: Queryable, sellerId: string, rail: string) {
  const settlement = ctx.cfg.SETTLEMENT_CURRENCY;
  const { payout_currency } = await one<{ payout_currency: string | null }>(q, 'SELECT payout_currency FROM users WHERE id = $1', [sellerId]);
  const cur = rail === 'crypto' ? settlement : (payout_currency ?? settlement);
  return { currency: cur, rate: cur === settlement ? 1 : await getRate(ctx, q, cur) };
}

export async function setPayoutCurrency(ctx: Ctx, sellerId: string, currency: string) {
  const cur = currency.toUpperCase();
  assertSupported(ctx, cur);
  await ctx.db.query('UPDATE users SET payout_currency = $2 WHERE id = $1', [sellerId, cur === ctx.cfg.SETTLEMENT_CURRENCY ? null : cur]);
  return { payoutCurrency: cur, note: 'Applies to new orders. Money already in your balance stays in its currency and can still be withdrawn.' };
}

export async function payoutCurrency(ctx: Ctx, q: Queryable, sellerId: string) {
  const { payout_currency } = await one<{ payout_currency: string | null }>(q, 'SELECT payout_currency FROM users WHERE id = $1', [sellerId]);
  return payout_currency ?? ctx.cfg.SETTLEMENT_CURRENCY;
}

/** Every currency the seller has money in (non-zero balances). */
export async function sellerBalances(q: Queryable, sellerId: string) {
  return many<{ currency: string; cents: number }>(
    q,
    `SELECT a.currency, COALESCE(SUM(e.amount_cents), 0)::bigint AS cents FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.owner_id = $1 AND a.kind = 'seller_available' GROUP BY a.currency HAVING COALESCE(SUM(e.amount_cents), 0) <> 0 ORDER BY a.currency`,
    [sellerId],
  );
}

// ---------------------------------------------------------------------------
// Treasury: currency position and conversions
// ---------------------------------------------------------------------------
/**
 * Per currency: what sellers are owed there, what the platform's position is, and what the
 * PSP should be holding. A negative position means that currency must be bought.
 */
export async function fxPosition(ctx: Ctx) {
  const currencies = ctx.cfg.SUPPORTED_CURRENCIES.split(',').map((c) => c.trim().toUpperCase());
  const out = [];
  for (const cur of currencies) {
    const bal = async (kind: 'fx_position' | 'fx_conversion' | 'gateway_clearing' | 'payouts' | 'platform_withdrawals') => balance(ctx.db, await accountId(ctx.db, kind, cur));
    const owed = await one<{ s: number }>(
      ctx.db,
      `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'seller_available' AND a.currency = $1`,
      [cur],
    );
    const pspExpected = -(await bal('gateway_clearing')) - (await bal('payouts')) - (await bal('platform_withdrawals')) - (await bal('fx_conversion'));
    out.push({ currency: cur, positionCents: await bal('fx_position'), sellerBalancesCents: owed.s, pspExpectedCents: pspExpected, shortfallCents: Math.max(0, owed.s - pspExpected) });
  }
  return out;
}

/** Record a conversion the treasury team made at the PSP or bank. */
export async function recordConversion(ctx: Ctx, adminId: string, c: { fromCurrency: string; fromCents: number; toCurrency: string; toCents: number; reference: string }) {
  const from = c.fromCurrency.toUpperCase();
  const to = c.toCurrency.toUpperCase();
  assertSupported(ctx, from);
  assertSupported(ctx, to);
  if (from === to) throw badRequest('same_currency', 'Pick two different currencies');
  return withTx(ctx.db, async (tx) => {
    const row = await one(
      tx,
      `INSERT INTO fx_conversions (from_currency, from_cents, to_currency, to_cents, reference, recorded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [from, c.fromCents, to, c.toCents, c.reference, adminId],
    );
    const memo = `fx_conversion:${row.id}`;
    // Money leaves the `from` balance and arrives in the `to` balance; the position moves with it.
    await post(tx, [
      { account: await accountId(tx, 'fx_position', from), amountCents: -c.fromCents },
      { account: await accountId(tx, 'fx_conversion', from), amountCents: c.fromCents },
    ], memo);
    await post(tx, [
      { account: await accountId(tx, 'fx_conversion', to), amountCents: -c.toCents },
      { account: await accountId(tx, 'fx_position', to), amountCents: c.toCents },
    ], memo);
    return row;
  });
}
