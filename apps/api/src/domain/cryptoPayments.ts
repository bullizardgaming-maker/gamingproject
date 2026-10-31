import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, notFound, AppError } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { NowPaymentsError, NowPaymentsProvider } from '../providers/payments/nowpayments.js';
import { getRate } from './fx.js';
import { cryptoPriceCurrencies } from './paymentMethods.js';
import { handlePaymentCapturedIn, lockOrder, type Order } from './orders.js';
import { checkoutByRef, handleCheckoutCapturedIn } from './cart.js';
import { accountId, post } from './ledger.js';
import { enqueueEmail } from './notifications.js';
import { recordSignals } from './fraud.js';
import { withScope, type TxScope } from './events.js';
import { appendMessage } from './chat.js';

/**
 * Crypto checkout (migration 053). The buyer picks a coin on our order page; we create a
 * NOWPayments payment and show the address and exact amount. Status changes arrive by IPN:
 *  - finished/confirmed with enough paid: the order is funded exactly like a card capture
 *    (handlePaymentCaptured), settled at what reached the store wallet.
 *  - partially_paid: the shortfall is shown and the buyer creates a top-up payment that shares the
 *    first payment's purchase id; once the payments together cover the price, the order is funded.
 *  - expired/failed: nothing happens here; the unpaid-order reaper cancels the order when its
 *    payment window lapses. Anything that did arrive (a partial payment) is then credited to the
 *    buyer's balance (creditPartialPayments): never refunded, spendable on a later order or
 *    withdrawable under the withdrawal rules.
 * Refunds (of funded orders) are manual: a queue for the CFO, booked as `refunds_payable` until the coins are sent.
 */
const COIN_NAMES: Record<string, string> = {
  btc: 'Bitcoin', eth: 'Ethereum', ltc: 'Litecoin', usdttrc20: 'Tether (TRC-20)', usdterc20: 'Tether (ERC-20)', usdtbsc: 'Tether (BEP-20)',
  usdc: 'USD Coin', usdcerc20: 'USD Coin (ERC-20)', usdcbsc: 'USD Coin (BEP-20)', usdcsol: 'USD Coin (Solana)', trx: 'TRON', bnb: 'BNB', sol: 'Solana',
  doge: 'Dogecoin', xmr: 'Monero', ton: 'Toncoin', xrp: 'XRP', matic: 'Polygon', bch: 'Bitcoin Cash', dai: 'Dai',
};
export const coinName = (c: string) => COIN_NAMES[c] ?? c.toUpperCase();

/** The network a coin code settles on, as buyers know it. */
const NETWORKS: Record<string, string> = {
  usdttrc20: 'TRC-20', usdtbsc: 'BEP-20', usdterc20: 'ERC-20', usdtsol: 'Solana', usdtmatic: 'Polygon', usdtton: 'TON',
  usdcmatic: 'Polygon', usdcerc20: 'ERC-20', usdc: 'ERC-20', usdcbsc: 'BEP-20', usdcsol: 'Solana', usdcarb: 'Arbitrum',
  btc: 'Bitcoin', eth: 'Ethereum', ltc: 'Litecoin', trx: 'TRON', sol: 'Solana', bnb: 'BNB Chain', doge: 'Dogecoin', xmr: 'Monero', ton: 'TON', xrp: 'XRP', matic: 'Polygon', bch: 'Bitcoin Cash', dai: 'Ethereum',
};
export const coinNetwork = (c: string) => NETWORKS[c] ?? c.toUpperCase();
/** Checkout order: the popular stablecoins and majors first, then everything else alphabetically. */
const POPULAR = ['usdttrc20', 'usdtbsc', 'usdterc20', 'usdcmatic', 'usdcerc20', 'usdc', 'btc', 'eth', 'ltc', 'trx', 'sol'];
/**
 * Round 28 (2): the buyer pays NOWPayments' processing fee on top of the order (NOWPAYMENTS_FEE_BPS, 0.5 %), rounded up
 * to the cent. Blockchain network fees are the buyer's wallet's business and are no longer estimated.
 */
export const processingFeeFor = (ctx: Ctx, chargedCents: number) => Math.ceil((Math.max(0, chargedCents) * ctx.cfg.NOWPAYMENTS_FEE_BPS) / 10_000);
/** What the buyer must send in total: the order plus the processing fee (the stored fee once the first invoice exists). */
const dueCents = (ctx: Ctx, p: { charged_cents: number; processing_fee_cents: number | null }) => p.charged_cents + (p.processing_fee_cents ?? processingFeeFor(ctx, p.charged_cents));

function provider(ctx: Ctx): NowPaymentsProvider {
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'crypto_unavailable', 'Crypto checkout is not configured');
  return ctx.payments;
}

/**
 * Round 25 (B5): a NOWPayments failure (down, slow, 5xx, an unexpected answer) is a clean 503 for the buyer, never a hang
 * or a 500. The log gets the provider's HTTP status and which call failed; never keys, addresses or bodies.
 */
export async function viaProvider<T>(ctx: Ctx, op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    const status = err instanceof NowPaymentsError ? err.status : null;
    ctx.log.warn({ provider: 'nowpayments', op, providerStatus: status, error: err instanceof Error ? err.name : 'unknown' }, 'payment provider unavailable');
    throw new AppError(503, 'payment_provider_unavailable', 'Crypto payments are unavailable right now. Try again in a few minutes.', { retryable: true });
  }
}

const usd = (cents: number) => Math.round(cents) / 100;
const toCents = (amount: number) => Math.round(amount * 100);

/** What is being paid: one order, or a cart checkout that covers several orders with one payment. */
export type PayableRef = { orderId: string } | { checkoutId: string };
interface Payable {
  kind: 'order' | 'checkout';
  id: string;
  buyer_id: string;
  status: string;
  payment_provider: string | null;
  payment_ref: string | null;
  /** Settlement-currency amount the buyer must send, after promo and credit. */
  charged_cents: number;
  currency: string;
  presentment_amount_cents: number;
  presentment_currency: string;
  /** The checkout quote: units of presentment currency per USD and when it was locked (Round 25, B6). */
  fx_rate: number;
  fx_locked_at: string | null;
  /** An order that belongs to a cart checkout (Round 25b: it is paid and quoted through the checkout only). */
  checkout_id: string | null;
  /** Round 28 (2): the processing fee fixed with the first crypto invoice; null until then (computed from config). */
  processing_fee_cents: number | null;
  title: string;
}

async function payable(q: Queryable, ref: PayableRef, buyerId: string, forPaying = true): Promise<Payable> {
  let p: Payable | null;
  if ('orderId' in ref) {
    const o = await maybeOne<any>(q, 'SELECT o.*, f.title FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.id = $1', [ref.orderId]);
    p = o && { kind: 'order', id: o.id, buyer_id: o.buyer_id, status: o.status, payment_provider: o.payment_provider, payment_ref: o.payment_ref, charged_cents: Number(o.charged_cents), currency: o.currency, presentment_amount_cents: Number(o.presentment_amount_cents), presentment_currency: o.presentment_currency, fx_rate: Number(o.fx_rate ?? 1), fx_locked_at: o.fx_locked_at ?? null, checkout_id: o.checkout_id ?? null, processing_fee_cents: o.processing_fee_cents != null && Number(o.processing_fee_cents) > 0 ? Number(o.processing_fee_cents) : null, title: `${o.title} x${o.quantity}` };
  } else {
    const c = await maybeOne<any>(
      q,
      `SELECT c.*, (SELECT SUM(o.charged_cents) FROM orders o WHERE o.checkout_id = c.id)::bigint AS charged_cents,
              (SELECT min(o.currency) FROM orders o WHERE o.checkout_id = c.id) AS currency, (SELECT count(*)::int FROM orders o WHERE o.checkout_id = c.id) AS n,
              (SELECT count(*)::int FROM orders o WHERE o.checkout_id = c.id AND o.status = 'awaiting_payment') AS open_n,
              (SELECT min(o.fx_locked_at) FROM orders o WHERE o.checkout_id = c.id) AS fx_locked_at,
              (SELECT min(o.fx_rate) FROM orders o WHERE o.checkout_id = c.id) AS fx_rate
         FROM checkouts c WHERE c.id = $1`,
      [ref.checkoutId],
    );
    // A cart whose orders all lapsed is closed even if the checkout row was never updated: a late deposit must not fund it.
    const status = c && c.status === 'awaiting_payment' && c.n > 0 && c.open_n === 0 ? 'cancelled' : c?.status;
    p = c && { kind: 'checkout', id: c.id, buyer_id: c.buyer_id, status, payment_provider: c.payment_provider, payment_ref: c.payment_ref, charged_cents: Number(c.charged_cents ?? 0), currency: c.currency ?? 'USD', presentment_amount_cents: Number(c.presentment_amount_cents ?? 0), presentment_currency: c.presentment_currency ?? 'USD', fx_rate: Number(c.fx_rate ?? 1), fx_locked_at: c.fx_locked_at ?? null, checkout_id: null, processing_fee_cents: c.processing_fee_cents != null && Number(c.processing_fee_cents) > 0 ? Number(c.processing_fee_cents) : null, title: `Bullizard order: ${c.n} item${c.n === 1 ? '' : 's'}` };
  }
  if (!p || p.buyer_id !== buyerId) throw notFound('orderId' in ref ? 'Order' : 'Checkout');
  if (forPaying) {
    if (p.status !== 'awaiting_payment') throw conflict('invalid_state', `This ${p.kind} is ${p.status}`);
    if (p.payment_provider !== 'nowpayments') throw conflict('not_crypto', `This ${p.kind} is not paid with crypto`);
  }
  return p;
}

/**
 * Round 25b (H1): an order inside a cart is quoted and paid through its checkout only. Paying or re-quoting it on its own
 * would leave the cart's orders in different currencies, and the cart's capture would be refused.
 */
function refuseCartOrder(p: Payable) {
  if (p.kind === 'order' && p.checkout_id) {
    throw new AppError(409, 'use_checkout', 'This order is part of a cart: pay and quote it through the cart checkout', { checkoutId: p.checkout_id });
  }
}

const whereRef = (p: { kind: string; id: string }) => (p.kind === 'order' ? 'order_id = $1' : 'checkout_id = $1');

/** Paid so far across this order's payments, in USD cents (what NOWPayments valued the deposits at). */
async function paidSoFarCents(q: Queryable, p: { kind: string; id: string }) {
  const r = await one<{ paid: string | null }>(
    q,
    `SELECT SUM(COALESCE(actually_paid_usd, 0))::numeric AS paid FROM crypto_payments WHERE ${whereRef(p)} AND status IN ('partially_paid', 'finished', 'confirmed', 'sending')`,
    [p.id],
  );
  return toCents(Number(r.paid ?? 0));
}

/** Coins the buyer can pay with; coins whose minimum is above what is still owed come back greyed (`available: false`). */
export async function coinsFor(ctx: Ctx, ref: PayableRef, buyerId: string) {
  const np = provider(ctx);
  const p = await payable(ctx.db, ref, buyerId);
  const paidSoFar = await paidSoFarCents(ctx.db, p);
  const fee = p.processing_fee_cents ?? processingFeeFor(ctx, p.charged_cents);
  const owed = Math.max(0, p.charged_cents - paidSoFar);
  const total = Math.max(0, p.charged_cents + fee - paidSoFar);
  const coins = await viaProvider(ctx, 'coins', async () => {
    const list = await np.coinsFor(usd(total));
    // Round 27 (3): within the deadline some minimums may still be loading — answer what is known, marked partial.
    if (!list.length && !list.partial) throw new Error('no coin minimums could be read');
    return list;
  });
  const pos = (c: string) => (POPULAR.includes(c) ? POPULAR.indexOf(c) : POPULAR.length);
  const list = coins
    .map((c) => ({
      ...c,
      name: coinName(c.coin),
      network: coinNetwork(c.coin),
      // Round 28 (2): the same processing fee whatever the coin; no network-fee estimate.
      fee_cents: fee,
      total_cents: total,
      disabled: !c.available,
      reason: c.available ? null : `Minimum for this coin is $${c.minUsd.toFixed(2)}`,
    }))
    .sort((a, b) => Number(b.available) - Number(a.available) || pos(a.coin) - pos(b.coin) || a.coin.localeCompare(b.coin));
  return { owedCents: owed, processing_fee_cents: fee, fee_bps: ctx.cfg.NOWPAYMENTS_FEE_BPS, total_cents: total, currency: p.currency, coins: list, partial: coins.partial === true };
}

export interface CryptoPaymentView {
  id: string;
  payment_id: string;
  pay_currency: string;
  pay_currency_name: string;
  pay_address: string;
  pay_extra_id: string | null;
  pay_amount: string;
  price_usd: string;
  /** Round 25: what the invoice was priced in at NOWPayments (USD or EUR), its amount there and the locked rate (EUR per USD). */
  price_currency: string;
  price_amount: string;
  fx_rate: string;
  actually_paid: string;
  actually_paid_usd: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
}

const VIEW = 'id, payment_id, pay_currency, pay_address, pay_extra_id, pay_amount::text, price_usd::text, price_currency, price_amount::text, fx_rate::text, actually_paid::text, actually_paid_usd::text, status, expires_at, created_at';
/** Columns the buyer's `state` is derived from (not sent to the buyer themselves). */
const STATE_COLS = 'applied_at, credited_cents::text, review_reason, outcome_amount::text';

/** Round 26 (A2): what the buyer should understand about a payment row, in one word. */
export type PaymentState = 'waiting' | 'confirming' | 'received_applying' | 'paid' | 'underpaid' | 'held_for_review' | 'credited_to_balance' | 'failed' | 'expired';
/** Order / checkout statuses under which no money has been applied yet. */
const UNFUNDED = new Set(['awaiting_payment', 'cancelled', 'expired']);
export function paymentState(r: { status: string; applied_at: string | null; credited_cents: string | null; review_reason: string | null; expires_at: string | null }, orderStatus: string): PaymentState {
  if (r.review_reason) return 'held_for_review';
  if (r.applied_at) return 'paid';
  if (Number(r.credited_cents ?? 0) > 0 || r.status === 'credited') return 'credited_to_balance';
  // Round 27 (1): once the order (or cart checkout) is funded, the payment is paid whatever the provider row still
  // says (an IPN applied by another path, a poll that applied it before the row caught up) — never "confirming" forever.
  if (!UNFUNDED.has(orderStatus)) return 'paid';
  switch (r.status) {
    case 'finished':
    case 'confirmed':
    case 'sending':
      // The provider has the money; the order is funded as soon as the IPN/poll applies it (or it is waiting on the rest).
      return orderStatus === 'awaiting_payment' ? 'received_applying' : 'paid';
    case 'partially_paid':
      return 'underpaid';
    case 'confirming':
      return 'confirming';
    case 'failed':
    case 'refunded':
      return 'failed';
    case 'expired':
      return 'expired';
    default:
      return r.expires_at && new Date(r.expires_at) < new Date() && orderStatus === 'awaiting_payment' ? 'expired' : 'waiting';
  }
}

export async function paymentsFor(q: Queryable, ref: PayableRef) {
  const p = 'orderId' in ref ? { kind: 'order', id: ref.orderId } : { kind: 'checkout', id: ref.checkoutId };
  const status = await maybeOne<{ status: string }>(q, p.kind === 'order' ? 'SELECT status FROM orders WHERE id = $1' : 'SELECT status FROM checkouts WHERE id = $1', [p.id]);
  const orderStatus = status?.status ?? 'awaiting_payment';
  const rows = await many<CryptoPaymentView & { applied_at: string | null; credited_cents: string | null; review_reason: string | null; outcome_amount: string | null }>(
    q, `SELECT ${VIEW}, ${STATE_COLS} FROM crypto_payments WHERE ${whereRef(p)} ORDER BY created_at`, [p.id],
  );
  return rows.map(({ applied_at, credited_cents, review_reason, outcome_amount: _o, ...r }) => ({
    ...r,
    pay_currency_name: coinName(r.pay_currency),
    state: paymentState({ ...r, applied_at, credited_cents, review_reason }, orderStatus),
    order_status: orderStatus,
  }));
}
export const paymentsForOrder = (q: Queryable, orderId: string) => paymentsFor(q, { orderId });

/**
 * Round 25 (B6): the price in `currency` the buyer was shown, held for FX_QUOTE_TTL_MINUTES. Within the hold it is the
 * order's presentment amount at the locked rate; after it (or for another currency) the order gets a fresh quote and
 * this returns `fresh: true` — the caller shows it before charging it.
 */
export async function lockFxQuote(ctx: Ctx, tx: Queryable, p: Payable, currency: string): Promise<{ currency: string; rate: number; amountCents: number; lockedUntil: string; fresh: boolean }> {
  const ttl = ctx.cfg.FX_QUOTE_TTL_MINUTES * 60_000;
  const live = p.presentment_currency === currency && !!p.fx_locked_at && Date.now() - new Date(p.fx_locked_at).getTime() < ttl;
  if (live) return { currency, rate: p.fx_rate, amountCents: p.presentment_amount_cents, lockedUntil: new Date(new Date(p.fx_locked_at!).getTime() + ttl).toISOString(), fresh: false };
  const raw = currency === ctx.cfg.SETTLEMENT_CURRENCY ? 1 : (await getRate(ctx, tx, currency)) * (1 + ctx.cfg.FX_SPREAD_BPS / 10_000);
  const rate = Math.round(raw * 1e8) / 1e8;
  const where = p.kind === 'order' ? 'id = $1' : 'checkout_id = $1';
  await tx.query(
    `UPDATE orders SET presentment_currency = $2, fx_rate = $3, presentment_amount_cents = round(charged_cents * $3::numeric), fx_locked_at = now(), version = version + 1
      WHERE ${where} AND status = 'awaiting_payment'`,
    [p.id, currency, rate],
  );
  const total = await one<{ total: string }>(tx, `SELECT COALESCE(sum(presentment_amount_cents), 0)::bigint AS total FROM orders WHERE ${where}`, [p.id]);
  if (p.kind === 'checkout') await tx.query('UPDATE checkouts SET presentment_currency = $2, presentment_amount_cents = $3 WHERE id = $1', [p.id, currency, Number(total.total)]);
  p.presentment_currency = currency;
  p.presentment_amount_cents = Number(total.total);
  p.fx_rate = rate;
  p.fx_locked_at = new Date().toISOString();
  return { currency, rate, amountCents: p.presentment_amount_cents, lockedUntil: new Date(Date.now() + ttl).toISOString(), fresh: true };
}

/** Round 25 (B6): (re)lock the checkout price in `currency` for FX_QUOTE_TTL_MINUTES and return it. */
export async function quoteFx(ctx: Ctx, ref: PayableRef, buyerId: string, currency: string) {
  if (!cryptoPriceCurrencies(ctx).includes(currency)) throw badRequest('unsupported_currency', `Crypto payments are priced in ${cryptoPriceCurrencies(ctx).join(' or ')}`);
  return withTx(ctx.db, async (tx) => {
    const p = await payable(tx, ref, buyerId);
    refuseCartOrder(p);
    await lockPayable(tx, p);
    const q = await lockFxQuote(ctx, tx, p, currency);
    return { ...q, usdCents: p.charged_cents };
  });
}

async function lockPayable(tx: Queryable, p: { kind: string; id: string }) {
  if (p.kind === 'order') await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [p.id]);
  else await tx.query('SELECT id FROM orders WHERE checkout_id = $1 ORDER BY id FOR UPDATE', [p.id]);
}

/**
 * The buyer picked a coin: create the payment for what is still owed (the whole price, or the top-up after an
 * underpayment). Round 25 (B5): priced in USD (default) or EUR; an EUR invoice is the locked quote's amount (a top-up:
 * the USD still owed at the locked rate, rounded up). If the quote has lapsed the order gets a new one and the call
 * answers 409 `fx_quote_expired` with it, so the buyer sees the new price before paying it. Settlement stays USD.
 */
export async function startCryptoPayment(ctx: Ctx, ref: PayableRef, buyerId: string, coin: string, priceCurrency = 'USD') {
  const np = provider(ctx);
  if (!cryptoPriceCurrencies(ctx).includes(priceCurrency)) throw badRequest('unsupported_currency', `Crypto payments are priced in ${cryptoPriceCurrencies(ctx).join(' or ')}`);
  const o = await payable(ctx.db, ref, buyerId);
  refuseCartOrder(o);
  const open = await maybeOne<{ id: string; payment_id: string; pay_currency: string; expires_at: string | null }>(
    ctx.db,
    `SELECT id, payment_id, pay_currency, expires_at FROM crypto_payments WHERE ${whereRef(o)} AND status IN ('waiting', 'confirming', 'confirmed', 'sending') ORDER BY created_at DESC LIMIT 1`,
    [o.id],
  );
  if (open && (!open.expires_at || new Date(open.expires_at) > new Date())) {
    throw new AppError(409, 'payment_open', `A ${coinName(open.pay_currency)} payment is already waiting for your transfer`, { paymentId: open.payment_id });
  }
  // Round 28 (2): the invoice carries the processing fee on top of the order; the fee is fixed with the first invoice.
  const fee = o.processing_fee_cents ?? processingFeeFor(ctx, o.charged_cents);
  if (o.processing_fee_cents == null && fee > 0) {
    await ctx.db.query(o.kind === 'order' ? 'UPDATE orders SET processing_fee_cents = $2 WHERE id = $1 AND processing_fee_cents = 0' : 'UPDATE checkouts SET processing_fee_cents = $2 WHERE id = $1 AND processing_fee_cents = 0', [o.id, fee]);
    o.processing_fee_cents = fee;
  }
  const owed = o.charged_cents + fee - (await paidSoFarCents(ctx.db, o));
  if (owed <= 0) throw conflict('already_paid', 'This order is paid; waiting for the network to confirm');
  // The invoice: USD as owed, or EUR at the locked quote (plus the fee at the same rate).
  let price = { currency: 'USD', amountCents: owed, rate: 1 };
  if (priceCurrency !== 'USD') {
    const q = await withTx(ctx.db, async (tx) => {
      await lockPayable(tx, o);
      return lockFxQuote(ctx, tx, o, priceCurrency);
    });
    if (q.fresh) throw new AppError(409, 'fx_quote_expired', `The ${priceCurrency} price was refreshed; check it and pay again`, { currency: q.currency, rate: q.rate, amountCents: q.amountCents, usdCents: o.charged_cents, lockedUntil: q.lockedUntil });
    price = { currency: priceCurrency, amountCents: owed === o.charged_cents + fee ? q.amountCents + Math.ceil(fee * q.rate) : Math.ceil(owed * q.rate), rate: q.rate };
  }
  const coins = await viaProvider(ctx, 'coins', () => np.coinsFor(usd(owed)));
  if (!coins.some((c) => c.coin === coin && c.available)) throw badRequest('coin_unavailable', `${coinName(coin)} can’t be used for this amount`);
  const first = await maybeOne<{ purchase_id: string | null }>(ctx.db, `SELECT purchase_id FROM crypto_payments WHERE ${whereRef(o)} ORDER BY created_at LIMIT 1`, [o.id]);
  const p = await viaProvider(ctx, 'create_payment', () =>
    np.createPayment({
      amount: price.amountCents / 100,
      priceCurrency: price.currency,
      coin,
      orderId: o.id,
      description: o.title,
      ipnCallbackUrl: `${ctx.apiBaseUrl}/v1/payments/webhook/nowpayments`,
      purchaseId: first?.purchase_id ?? null,
      sandboxCase: ctx.cfg.NOWPAYMENTS_SANDBOX_CASE,
    }),
  );
  if (!p || p.payment_id == null || !p.pay_address) {
    ctx.log.warn({ provider: 'nowpayments', op: 'create_payment', providerStatus: 200, error: 'incomplete_answer' }, 'payment provider unavailable');
    throw new AppError(503, 'payment_provider_unavailable', 'Crypto payments are unavailable right now. Try again in a few minutes.', { retryable: true });
  }
  // The address stays valid well past the estimate's expiry; give the order a full hour from now to be paid.
  const row = await withTx(ctx.db, async (tx) => {
    const r = await one<CryptoPaymentView>(
      tx,
      `INSERT INTO crypto_payments (order_id, checkout_id, payment_id, purchase_id, pay_currency, pay_address, pay_extra_id, pay_amount, price_usd, status, expires_at, raw, price_currency, price_amount, fx_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING ${VIEW}`,
      [
        o.kind === 'order' ? o.id : null, o.kind === 'checkout' ? o.id : null, String(p.payment_id), p.purchase_id != null ? String(p.purchase_id) : null, p.pay_currency.toLowerCase(), p.pay_address,
        p.payin_extra_id ?? null, p.pay_amount, usd(owed), p.payment_status ?? 'waiting', p.expiration_estimate_date ?? null, JSON.stringify(p),
        price.currency, price.amountCents / 100, price.rate,
      ],
    );
    if (o.kind === 'order') await tx.query(`UPDATE orders SET payment_expires_at = GREATEST(payment_expires_at, now() + interval '60 minutes') WHERE id = $1`, [o.id]);
    else await tx.query(`UPDATE orders SET payment_expires_at = GREATEST(payment_expires_at, now() + interval '60 minutes') WHERE checkout_id = $1`, [o.id]);
    return r;
  });
  return { ...row, pay_currency_name: coinName(row.pay_currency) };
}

/** Pulls the current status from NOWPayments (the page polls this; IPNs are the source of truth). */
export async function refreshCryptoPayment(ctx: Ctx, ref: PayableRef, buyerId: string, paymentId: string) {
  const np = provider(ctx);
  const o = await payable(ctx.db, ref, buyerId, false);
  const row = await maybeOne<{ status: string; applied_at: string | null; credited_cents: string | null; review_reason: string | null }>(ctx.db, `SELECT status, applied_at, credited_cents, review_reason FROM crypto_payments WHERE ${whereRef(o)} AND payment_id = $2`, [o.id, paymentId]);
  if (!row) throw notFound('Payment');
  // Round 26 (A1): a row the provider calls finished is final only once its money went somewhere (funded the order,
  // credited the balance, or is held for a person). A finished row that applied nothing is asked about again.
  const settledRow = row.applied_at || Number(row.credited_cents ?? 0) > 0 || row.review_reason || o.status !== 'awaiting_payment';
  if (['failed', 'refunded', 'expired'].includes(row.status) || (row.status === 'finished' && settledRow)) return paymentsFor(ctx.db, ref);
  try {
    const p = await np.getPayment(paymentId); // a failure here only means no fresh status: the list below is still answered
    await applyCryptoPayment(ctx, {
      type: 'crypto.payment',
      paymentId: String(p.payment_id),
      orderId: p.order_id ? String(p.order_id) : o.id,
      purchaseId: p.purchase_id != null ? String(p.purchase_id) : null,
      status: p.payment_status,
      payCurrency: p.pay_currency,
      payAmount: Number(p.pay_amount),
      actuallyPaid: Number(p.actually_paid ?? 0),
      actuallyPaidUsd: p.actually_paid_at_fiat != null ? Number(p.actually_paid_at_fiat) : null,
      priceUsd: Number(p.price_amount),
      outcomeAmount: p.outcome_amount != null ? Number(p.outcome_amount) : null,
      outcomeCurrency: p.outcome_currency ?? null,
      raw: p,
    });
  } catch (err) {
    ctx.log.warn({ err, paymentId }, 'crypto payment refresh failed');
  }
  return paymentsFor(ctx.db, ref);
}

const PAID_STATUSES = new Set(['finished', 'confirmed', 'sending', 'partially_paid']);

/** IPN (or a poll): store the payment's state and fund the order once enough has arrived. */
export async function applyCryptoPayment(ctx: Ctx, ev: Extract<PaymentEvent, { type: 'crypto.payment' }>) {
  const row0 = await maybeOne<{ id: string; order_id: string | null; checkout_id: string | null }>(ctx.db, 'SELECT id, order_id, checkout_id FROM crypto_payments WHERE payment_id = $1', [ev.paymentId]);
  if (!row0) {
    ctx.log.warn({ paymentId: ev.paymentId, orderId: ev.orderId }, 'IPN for an unknown crypto payment');
    return null;
  }
  const ref: PayableRef = row0.order_id ? { orderId: row0.order_id } : { checkoutId: row0.checkout_id! };
  const buyerId = (await one<{ buyer_id: string }>(ctx.db, row0.order_id ? 'SELECT buyer_id FROM orders WHERE id = $1' : 'SELECT buyer_id FROM checkouts WHERE id = $1', [row0.order_id ?? row0.checkout_id])).buyer_id;
  // The paying wallet, when the provider reports it: a shared wallet links accounts (self-referral check, fraud clusters).
  const raw = (ev.raw ?? {}) as Record<string, unknown>;
  const payer = [raw.payer_address, raw.from_address, raw.payin_address_from].find((v) => typeof v === 'string' && v.length >= 10) as string | undefined;
  if (payer) await recordSignals(ctx.db, buyerId, { wallet: payer.toLowerCase() });
  // A deposit's value in the invoice's currency: NOWPayments reports it when it has one; otherwise value the coins at the
  // payment's own rate. Round 25: an EUR invoice is valued in USD in proportion to the invoice (paid EUR / invoiced EUR ×
  // the USD it covered), so paying the EUR shown settles exactly the USD owed. Settlement stays USD.
  const inv = await one<{ price_usd: string; price_amount: string | null; price_currency: string; fx_rate: string }>(ctx.db, 'SELECT price_usd::text, price_amount::text, price_currency, fx_rate::text FROM crypto_payments WHERE id = $1', [row0.id]);
  const valued = depositUsd(inv, { ...ev, status: ev.status });
  if (!valued.ok) {
    // Round 25b (M1): we can't tell what currency NOWPayments valued an EUR deposit in. Never guess (over-crediting is
    // the risk): nothing is credited or captured, the row is flagged for manual review and Ops is alerted.
    await ctx.db.query(`UPDATE crypto_payments SET status = $2, actually_paid = $3, actually_paid_usd = NULL, outcome_amount = $4, outcome_currency = $5, raw = $6,
                               review_reason = $7, review_flagged_at = COALESCE(review_flagged_at, now()), updated_at = now() WHERE id = $1`,
      [row0.id, ev.status, ev.actuallyPaid, ev.outcomeAmount, ev.outcomeCurrency, JSON.stringify(ev.raw ?? {}), valued.reason]);
    ctx.log.error({ paymentId: ev.paymentId, reason: valued.reason }, 'crypto deposit held for manual review');
    return payable(ctx.db, ref, buyerId, false);
  }
  const paidUsd = valued.usd;

  // Round 22 (7): one transaction from the decision to the capture, holding the order row(s) and then the payment row —
  // the same order the unpaid-order reaper takes them in (cancelOrder → creditPartialPayments) — so an IPN and the reaper
  // can never both act on the same money.
  return withScope(ctx, async (s) => {
    if (row0.order_id) await lockOrder(s.tx, row0.order_id);
    else await s.tx.query('SELECT id FROM orders WHERE checkout_id = $1 ORDER BY id FOR UPDATE', [row0.checkout_id]);
    const row = await one<{ id: string; status: string; applied_at: string | null }>(s.tx, 'SELECT id, status, applied_at FROM crypto_payments WHERE id = $1 FOR UPDATE', [row0.id]);
    // A row already credited to the buyer's balance keeps that status; the deposit figures still update.
    await s.tx.query(
      `UPDATE crypto_payments SET status = CASE WHEN status = 'credited' THEN 'credited' ELSE $2 END, actually_paid = $3, actually_paid_usd = $4, outcome_amount = $5, outcome_currency = $6, raw = $7, updated_at = now() WHERE id = $1`,
      [row.id, ev.status, ev.actuallyPaid, PAID_STATUSES.has(ev.status) ? paidUsd : null, ev.outcomeAmount, ev.outcomeCurrency, JSON.stringify(ev.raw ?? {})],
    );
    const target = await payable(s.tx, ref, buyerId, false);
    if (!PAID_STATUSES.has(ev.status)) return target;
    if (target.status !== 'awaiting_payment' || row.status === 'credited' || row.applied_at) {
      // Money arriving after the order was cancelled, on top of an order already funded by other deposits, or a second
      // transfer to an address whose payment already funded the order (Round 22, 8): never lost, never counted twice —
      // the new part goes to the buyer's balance.
      await creditLateDeposit(s, row.id, target);
      return target;
    }

    const paid = await paidSoFarCents(s.tx, target);
    // Round 28 (2): the buyer owes the order plus the processing fee; the tolerance applies to that total.
    const due = dueCents(ctx, target);
    const tolerance = Math.floor((due * ctx.cfg.CRYPTO_UNDERPAY_TOLERANCE_BPS) / 10_000);
    if (paid + tolerance < due) {
      // Round 28 (1): a deposit the provider calls finished/confirmed that still values short is an underpayment — the row
      // is marked partially_paid (the provider's answer stays in `raw`) so the buyer is told, never left "confirming".
      const short = due - paid;
      await s.tx.query(`UPDATE crypto_payments SET status = 'partially_paid', apply_note = $2 WHERE id = $1 AND status <> 'credited'`, [row.id, `short by ${(short / 100).toFixed(2)} ${target.currency}: paid ${(paid / 100).toFixed(2)} of ${(due / 100).toFixed(2)} (tolerance ${(tolerance / 100).toFixed(2)})`]);
      if (row.status !== 'partially_paid') {
        const link = target.kind === 'order' ? target.id : `cart:${target.id}`;
        await enqueueEmail(s.tx, target.buyer_id, 'crypto_underpaid', { order_id: link, paid_cents: paid, owed_cents: short, currency: target.currency }, `crypto_underpaid:${ev.paymentId}`);
        if (target.kind === 'order') {
          const room = await maybeOne<{ id: string }>(s.tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [target.id]);
          if (room) await appendMessage(s, room.id, null, 'system', 'Payment arrived short. Buyer: send the rest or it goes to your balance.', [], undefined, { code: 'underpaid' });
        }
      }
      return target;
    }
    await s.tx.query('UPDATE crypto_payments SET apply_note = NULL WHERE id = $1', [row.id]);
    // Enough has arrived. `paid` is what the buyer sent, valued in USD (gross); what reached the store wallet in USDT/USDC
    // is the net; the gap is NOWPayments' fee — booked once, as psp_fee (CFO B1). Anything above the order total beyond the
    // tolerance is the buyer's money: it goes to their balance (CFO B6), not to FX gain.
    const settled = await settledCents(s.tx, target, paid);
    // The deposits that fund this order are marked with what each was worth, so anything arriving later is treated as extra.
    const funding = await many<{ id: string; actually_paid_usd: string | null; outcome_amount: string | null; outcome_currency: string | null; price_currency: string; raw: any }>(
      s.tx, `SELECT id, actually_paid_usd::text, outcome_amount::text, outcome_currency, price_currency, raw FROM crypto_payments WHERE ${whereRef(target)} AND applied_at IS NULL AND status IN ('finished', 'confirmed', 'sending', 'partially_paid') FOR UPDATE`, [target.id],
    );
    // USD invoices: the whole gap between what the buyer sent and what reached the wallet is NOWPayments' fee (CFO B1).
    // Round 25b (M1): with an EUR invoice the gap also holds the EUR→USD conversion: only the expected fee is psp_fee,
    // the rest is FX gain/loss (fx_pnl), and a gap above FX_ALERT_BPS of the order raises an Ops alert.
    const gap = paid - settled;
    const eur = funding.some((f) => f.price_currency !== 'USD');
    const fee = eur ? Math.max(0, Math.min(expectedFeeCents(ctx, funding), Math.max(gap, 0))) : Math.max(0, gap);
    const fxGap = eur ? gap - fee : 0; // > 0: FX loss, < 0: FX gain
    const fxGapBps = target.charged_cents > 0 ? Math.round((fxGap * 10_000) / target.charged_cents) : 0;
    if (eur) await s.tx.query('UPDATE crypto_payments SET fx_gap_cents = $2, fx_gap_bps = $3 WHERE id = $1', [row.id, fxGap, fxGapBps]);
    if (eur && Math.abs(fxGapBps) > ctx.cfg.FX_ALERT_BPS) ctx.log.error({ paymentId: ev.paymentId, fxGapCents: fxGap, fxGapBps }, 'crypto EUR invoice: FX gap above FX_ALERT_BPS');
    const overpaid = paid - due > tolerance ? paid - due : 0;
    // Round 28 (2): the processing fee the buyer paid on top (what arrived above the order, up to the fee) covers psp_fee.
    const processingFee = Math.max(0, Math.min(due - target.charged_cents, paid - overpaid - target.charged_cents));
    const captured: Extract<PaymentEvent, { type: 'payment.captured' }> = {
      type: 'payment.captured',
      ref: target.payment_ref!,
      orderId: target.id,
      amountCents: target.presentment_amount_cents,
      currency: target.presentment_currency,
      details: { settledAmountCents: paid, feeCents: fee, processingFeeCents: processingFee, fxGapCents: fxGap, overpaidCents: overpaid, raw: { payments: await paymentsFor(s.tx, ref) } },
    };
    for (const f of funding) await s.tx.query('UPDATE crypto_payments SET applied_at = now(), applied_cents = $2 WHERE id = $1', [f.id, settledOf(f)]);
    if (target.kind === 'checkout' && (await checkoutByRef(s.tx, target.payment_ref!))) return handleCheckoutCapturedIn(ctx, s, captured);
    return handlePaymentCapturedIn(ctx, s, captured);
  });
}

/**
 * NOWPayments' fee on the funding deposits, in USD cents: the `fee` object of its IPN (depositFee + withdrawalFee +
 * serviceFee, in the outcome stablecoin) when it sends one, else NOWPAYMENTS_FEE_BPS of the deposit.
 */
function expectedFeeCents(ctx: Ctx, rows: Array<{ actually_paid_usd: string | null; raw: any }>) {
  let cents = 0;
  for (const r of rows) {
    const f = r.raw?.fee;
    // Round 26: the IPN's fee object is in whatever coin it names (the pay coin, in NOWPayments' own example); only a
    // USD stablecoin figure is USD. Anything else falls back to the expected rate of the invoice.
    const usdCoin = f && typeof f === 'object' && typeof f.currency === 'string' && /^usd[tc]/i.test(f.currency);
    const parts = usdCoin ? [f.depositFee, f.withdrawalFee, f.serviceFee].map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
    cents += parts.length ? toCents(parts.reduce((a, b) => a + b, 0)) : Math.round((toCents(Number(r.actually_paid_usd ?? 0)) * ctx.cfg.NOWPAYMENTS_FEE_BPS) / 10_000);
  }
  return cents;
}

/**
 * A deposit's value in USD. USD invoice: what NOWPayments reports (`actually_paid_at_fiat`), else the coins at the
 * payment's own rate. EUR invoice (Round 25): in proportion to the invoice (paid EUR / invoiced EUR × the USD it
 * covered), so paying the EUR shown settles exactly the USD owed.
 *
 * Round 25b (M1) — CHECK AGAINST THE NOWPAYMENTS SANDBOX: we expect `actually_paid_at_fiat` in the invoice's
 * `price_currency` (EUR). Since that is not documented, it is cross-checked against the coins sent (actually_paid /
 * pay_amount × the invoiced EUR): within 2 % it is EUR; within 2 % of that value in USD (÷ the locked rate) it is taken as
 * USD; anything else, or an IPN whose price_currency is not the invoice's, is refused and held for manual review.
 */
export function depositUsd(
  inv: { price_usd: string; price_amount: string | null; price_currency: string; fx_rate: string },
  ev: { actuallyPaidUsd: number | null; actuallyPaid: number; payAmount: number; priceUsd: number; raw?: unknown; status?: string },
): { ok: true; usd: number } | { ok: false; reason: string } {
  // Round 28 (1): `finished` means NOWPayments received the full invoice. The sandbox (and a late IPN) can report it with
  // actually_paid 0 or missing — that is "not reported", never "nothing arrived": value it at the full pay_amount.
  const fullyPaid = (ev.status === 'finished' || ev.status === 'confirmed' || ev.status === 'sending') && !(ev.actuallyPaid > 0);
  const coinShare = fullyPaid ? 1 : ev.payAmount > 0 ? ev.actuallyPaid / ev.payAmount : 0;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // Round 26 (A1, the staging bug): NOWPayments sends `actually_paid_at_fiat: 0` whenever it has no fiat valuation —
  // its own IPN example does, the sandbox always does. Zero is "not provided", never "the buyer paid nothing": the
  // coins that arrived are valued in proportion to the invoice (actually_paid / pay_amount × the invoiced amount).
  const fiat = ev.actuallyPaidUsd != null && ev.actuallyPaidUsd > 0 ? ev.actuallyPaidUsd : null;
  // The invoice's own figure (price_usd for USD; price_amount × its USD value for EUR) is what the coins were priced at.
  const priceUsd = Number(inv.price_usd) > 0 ? Number(inv.price_usd) : ev.priceUsd;
  if (inv.price_currency === 'USD' || !Number(inv.price_amount)) return { ok: true, usd: fiat ?? round2(coinShare * priceUsd) };
  const invoiced = Number(inv.price_amount);
  const usdPerInvoiced = priceUsd / invoiced;
  const raw = (ev.raw ?? {}) as Record<string, unknown>;
  if (typeof raw.price_currency === 'string' && raw.price_currency.toUpperCase() !== inv.price_currency) {
    return { ok: false, reason: `ipn_price_currency_${raw.price_currency.toLowerCase()}` };
  }
  if (fiat == null) return { ok: true, usd: round2(coinShare * invoiced * usdPerInvoiced) };
  if (!(coinShare > 0)) return { ok: false, reason: 'fiat_value_without_coins' };
  const asEur = coinShare * invoiced;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02 * b, 0.01);
  if (near(fiat, asEur)) return { ok: true, usd: round2(fiat * usdPerInvoiced) };
  if (near(fiat, asEur / Number(inv.fx_rate))) return { ok: true, usd: round2(fiat) };
  return { ok: false, reason: 'fiat_value_currency_unknown' };
}

/** USD cents a payment row is worth: what reached the wallet in USDT/USDC, else NOWPayments' valuation of the deposit. */
const settledOf = (r: { actually_paid_usd: string | null; outcome_amount: string | null; outcome_currency: string | null }) =>
  r.outcome_amount != null && r.outcome_currency && /^usd[tc]/.test(r.outcome_currency) ? toCents(Number(r.outcome_amount)) : toCents(Number(r.actually_paid_usd ?? 0));

/**
 * A deposit that cannot fund its order any more (the order was cancelled, or it was funded by other payments), or more
 * money sent to an address whose payment already funded the order: credit the buyer's balance with what has not been
 * counted yet (settled − what funded the order − what was already credited), each top-up its own ledger entry. Row lock,
 * so a cart's sibling orders and repeated IPNs never credit the same coins twice.
 */
async function creditLateDeposit(s: TxScope, rowId: string, target: Payable) {
  const r = await one<{ id: string; payment_id: string; applied_at: string | null; applied_cents: string | null; credited_cents: string | null; actually_paid_usd: string | null; outcome_amount: string | null; outcome_currency: string | null }>(
    s.tx, 'SELECT id, payment_id, applied_at, applied_cents, credited_cents, actually_paid_usd::text, outcome_amount::text, outcome_currency FROM crypto_payments WHERE id = $1 FOR UPDATE', [rowId],
  );
  const settled = settledOf(r);
  // A row that funded the order but has no applied_cents (funded before Round 22): its whole value counted then.
  const counted = r.applied_at ? (r.applied_cents != null ? Number(r.applied_cents) : settled) : 0;
  const diff = settled - counted - Number(r.credited_cents ?? 0);
  if (diff <= 0) return 0;
  const credited = Number(r.credited_cents ?? 0) + diff;
  await s.tx.query(`UPDATE crypto_payments SET status = CASE WHEN applied_at IS NULL THEN 'credited' ELSE status END, credited_cents = $2 WHERE id = $1`, [r.id, credited]);
  const orderId = target.kind === 'order' ? target.id : null;
  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'gateway_clearing', target.currency), amountCents: -diff },
      { account: await accountId(s.tx, 'user_credit', target.currency, target.buyer_id), amountCents: diff },
    ],
    r.applied_at ? 'crypto_extra_deposit' : 'crypto_late_deposit',
    orderId,
  );
  if (orderId) {
    const room = await maybeOne<{ id: string }>(s.tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [orderId]);
    const text = r.applied_at
      ? `Another ${(diff / 100).toFixed(2)} ${target.currency} arrived after this order was paid. It is in the buyer's balance.`
      : `A payment of ${(diff / 100).toFixed(2)} ${target.currency} arrived after this order closed. It is in the buyer's balance.`;
    if (room) await appendMessage(s, room.id, null, 'system', text, [], undefined, { code: 'underpayment_kept', params: { amount_cents: diff, currency: target.currency } });
  }
  await enqueueEmail(s.tx, target.buyer_id, 'crypto_kept_in_balance', { order_id: orderId ?? `cart:${target.id}`, amount_cents: diff, currency: target.currency }, `crypto_late:${r.payment_id}:${credited}`);
  return diff;
}

async function settledCents(q: Queryable, p: { kind: string; id: string }, fallback: number) {
  const rows = await many<{ outcome_amount: string | null; outcome_currency: string | null }>(q, `SELECT outcome_amount::text, outcome_currency FROM crypto_payments WHERE ${whereRef(p)} AND status IN ($2, $3, $4, $5)`, [p.id, 'finished', 'confirmed', 'sending', 'partially_paid']);
  let sum = 0;
  for (const r of rows) {
    if (r.outcome_amount == null || !r.outcome_currency || !/^usd[tc]/.test(r.outcome_currency)) return fallback;
    sum += Number(r.outcome_amount);
  }
  return rows.length ? toCents(sum) : fallback;
}

/**
 * An order (or cart) lapsed with money on it: what reached the wallet goes to the buyer's credit
 * (gateway_clearing → user_credit), the payments are marked credited, and the buyer is told. Called
 * from cancelOrder for NOWPayments orders; idempotent per payment row.
 */
export async function creditPartialPayments(ctx: Ctx, s: TxScope, order: { id: string; buyer_id: string; currency: string; checkout_id?: string | null; payment_provider?: string | null }) {
  if (order.payment_provider !== 'nowpayments') return 0;
  const ref = order.checkout_id ? { kind: 'checkout', id: order.checkout_id } : { kind: 'order', id: order.id };
  const rows = await many<{ id: string; actually_paid_usd: string | null; outcome_amount: string | null; outcome_currency: string | null }>(
    s.tx,
    `SELECT id, actually_paid_usd::text, outcome_amount::text, outcome_currency FROM crypto_payments WHERE ${whereRef(ref)} AND status = 'partially_paid' FOR UPDATE`,
    [ref.id],
  );
  let total = 0;
  for (const r of rows) {
    // Settled at what reached the wallet (USDT/USDC), else at what NOWPayments valued the deposit.
    const settled = settledOf(r);
    await s.tx.query(`UPDATE crypto_payments SET status = 'credited', credited_cents = $2 WHERE id = $1`, [r.id, settled]);
    if (settled <= 0) continue;
    total += settled;
  }
  if (!total) return 0;
  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'gateway_clearing', order.currency), amountCents: -total },
      { account: await accountId(s.tx, 'user_credit', order.currency, order.buyer_id), amountCents: total },
    ],
    'crypto_kept_in_balance',
    order.id,
  );
  const room = await maybeOne<{ id: string }>(s.tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [order.id]);
  if (room) await appendMessage(s, room.id, null, 'system', `The payment window closed with ${(total / 100).toFixed(2)} ${order.currency} received. It is kept in the buyer's balance to spend on a later order or withdraw.`, [], undefined, { code: 'underpayment_kept', params: { amount_cents: total, currency: order.currency } });
  await enqueueEmail(s.tx, order.buyer_id, 'crypto_kept_in_balance', { order_id: order.id, amount_cents: total, currency: order.currency }, `crypto_kept:${order.id}`);
  return total;
}

// ---------------------------------------------------------------------------
// Refunds: queued for the CFO, booked as a liability until sent
// ---------------------------------------------------------------------------
/** Called where a card refund would be issued: moves the money from escrow to refunds_payable and opens a queue item. */
export async function queueCryptoRefund(tx: Tx, order: Order, amountCents: number, reason: string) {
  const existing = await maybeOne<{ id: string }>(tx, `SELECT id FROM crypto_refunds WHERE order_id = $1 AND status <> 'cancelled'`, [order.id]);
  if (existing) return existing.id;
  const r = await one<{ id: string }>(tx, 'INSERT INTO crypto_refunds (order_id, amount_cents, currency, reason) VALUES ($1, $2, $3, $4) RETURNING id', [order.id, amountCents, order.currency, reason]);
  await enqueueEmail(tx, order.buyer_id, 'crypto_refund_address', { order_id: order.id, amount_cents: amountCents, currency: order.currency }, `crypto_refund_address:${r.id}`);
  return r.id;
}

export async function setRefundAddress(ctx: Ctx, orderId: string, buyerId: string, input: { address: string; currency: string }) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId) throw notFound('Order');
    const r = await maybeOne<{ id: string; status: string }>(s.tx, `SELECT id, status FROM crypto_refunds WHERE order_id = $1 AND status <> 'cancelled' FOR UPDATE`, [orderId]);
    if (!r) throw notFound('Refund');
    if (r.status === 'sent') throw conflict('already_sent', 'This refund was already sent');
    await s.tx.query(`UPDATE crypto_refunds SET refund_address = $2, refund_currency = $3, status = 'pending', updated_at = now() WHERE id = $1`, [r.id, input.address.trim(), input.currency.toLowerCase()]);
    const room = await maybeOne<{ id: string }>(s.tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [orderId]);
    if (room) await appendMessage(s, room.id, null, 'system', `The buyer gave a ${coinName(input.currency.toLowerCase())} address for the refund; the treasury sends it within three working days.`, [], undefined, { code: 'refund_address_given', params: { coin: input.currency.toLowerCase() } });
    return refundView(s.tx, r.id);
  });
}

async function refundView(q: Queryable, id: string) {
  return one(q, `SELECT r.*, o.buyer_id, o.seller_id, u.email AS buyer_email FROM crypto_refunds r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = o.buyer_id WHERE r.id = $1`, [id]);
}

export async function refundForOrder(q: Queryable, orderId: string) {
  return maybeOne(q, `SELECT id, amount_cents, currency, reason, refund_address, refund_currency, status, tx_hash, created_at, updated_at FROM crypto_refunds WHERE order_id = $1 AND status <> 'cancelled'`, [orderId]);
}

export async function listCryptoRefunds(q: Queryable, status?: string) {
  return many(
    q,
    `SELECT r.*, u.email AS buyer_email, u.display_name AS buyer_name FROM crypto_refunds r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = o.buyer_id
      WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at LIMIT 200`,
    [status ?? null],
  );
}

/** The CFO sent the coins: record the hash and move the liability out through the gateway. */
export async function markRefundSent(ctx: Ctx, id: string, staffId: string, input: { txHash: string; note?: string }) {
  return withScope(ctx, async (s) => {
    const r = await maybeOne<{ id: string; order_id: string; amount_cents: number; currency: string; status: string }>(s.tx, 'SELECT * FROM crypto_refunds WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw notFound('Refund');
    if (r.status !== 'pending') throw conflict('invalid_state', `This refund is ${r.status}`);
    await s.tx.query(`UPDATE crypto_refunds SET status = 'sent', tx_hash = $2, decided_by = $3, note = $4, updated_at = now() WHERE id = $1`, [id, input.txHash.trim(), staffId, input.note ?? null]);
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'refunds_payable', r.currency), amountCents: -Number(r.amount_cents) },
        { account: await accountId(s.tx, 'gateway_clearing', r.currency), amountCents: Number(r.amount_cents) },
      ],
      'crypto_refund_sent',
      r.order_id,
    );
    const order = await one<Order>(s.tx, 'SELECT * FROM orders WHERE id = $1', [r.order_id]);
    await enqueueEmail(s.tx, order.buyer_id, 'crypto_refund_sent', { order_id: order.id, amount_cents: Number(r.amount_cents), currency: r.currency, tx_hash: input.txHash.trim() });
    return refundView(s.tx, id);
  });
}

// ---------------------------------------------------------------------------
// Round 26 (A3): Ops → Crypto payments. Render's free plan has no logs; this list is what staff look at instead.
// ---------------------------------------------------------------------------
export async function listCryptoPayments(q: Queryable, filter: { status?: string; q?: string; limit?: number } = {}, ctx?: Ctx) {
  const rows = await many<any>(
    q,
    `SELECT p.id, p.payment_id, p.purchase_id, p.order_id, p.checkout_id, o.ref AS order_ref, o.status AS order_status, c.status AS checkout_status,
            p.status, p.pay_currency, p.pay_amount::text, p.actually_paid::text, p.actually_paid_usd::text, p.price_usd::text, p.price_currency, p.price_amount::text, p.fx_rate::text,
            p.outcome_amount::text, p.outcome_currency, p.applied_at, p.applied_cents, p.credited_cents, p.review_reason, p.review_flagged_at, p.review_resolved_at,
            p.fx_gap_cents, p.fx_gap_bps, p.expires_at, p.created_at, p.updated_at AS last_ipn_at, p.apply_note,
            COALESCE(o.buyer_id, c.buyer_id) AS buyer_id, u.display_name AS buyer_name,
            COALESCE(o.charged_cents, (SELECT SUM(x.charged_cents) FROM orders x WHERE x.checkout_id = c.id))::bigint AS charged_cents,
            COALESCE(o.processing_fee_cents, c.processing_fee_cents, 0)::bigint AS processing_fee_cents,
            (SELECT SUM(COALESCE(s.actually_paid_usd, 0))::numeric FROM crypto_payments s
              WHERE ((p.order_id IS NOT NULL AND s.order_id = p.order_id) OR (p.checkout_id IS NOT NULL AND s.checkout_id = p.checkout_id))
                AND s.status IN ('partially_paid', 'finished', 'confirmed', 'sending'))::text AS paid_so_far
       FROM crypto_payments p
       LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN checkouts c ON c.id = p.checkout_id
       LEFT JOIN users u ON u.id = COALESCE(o.buyer_id, c.buyer_id)
      WHERE ($1::text IS NULL OR p.status = $1)
        AND ($2::text IS NULL OR p.payment_id = $2 OR o.ref = $2 OR p.order_id::text = $2 OR p.checkout_id::text = $2)
      ORDER BY p.created_at DESC LIMIT $3`,
    [filter.status ?? null, filter.q?.trim() || null, Math.min(filter.limit ?? 100, 500)],
  );
  return rows.map(({ paid_so_far, ...r }) => {
    const orderStatus = r.order_status ?? r.checkout_status ?? 'awaiting_payment';
    const state = paymentState(r, orderStatus);
    // Round 28 (1): the raw numbers and, for a deposit that has not funded its order, why — for Ops → Crypto payments.
    const charged = Number(r.charged_cents ?? 0);
    const due = charged + Number(r.processing_fee_cents ?? 0);
    const paidSoFar = toCents(Number(paid_so_far ?? 0));
    const tolerance = ctx ? Math.floor((due * ctx.cfg.CRYPTO_UNDERPAY_TOLERANCE_BPS) / 10_000) : 0;
    let why: string | null = null;
    if (r.applied_at) why = null;
    else if (r.review_reason) why = `held for manual review: ${r.review_reason}`;
    else if (Number(r.credited_cents ?? 0) > 0 || r.status === 'credited') why = 'credited to the buyer\'s balance (order not funded by this deposit)';
    else if (!UNFUNDED.has(orderStatus)) why = 'order funded by other deposits';
    else if (orderStatus !== 'awaiting_payment') why = `order is ${orderStatus}`;
    else if (['partially_paid', 'finished', 'confirmed', 'sending'].includes(r.status)) why = r.apply_note ?? `short by ${((due - paidSoFar) / 100).toFixed(2)}: paid ${(paidSoFar / 100).toFixed(2)} of ${(due / 100).toFixed(2)} (tolerance ${(tolerance / 100).toFixed(2)})`;
    else if (r.status === 'confirming') why = 'waiting for network confirmations';
    else if (['failed', 'refunded', 'expired'].includes(r.status)) why = `provider status ${r.status}`;
    else why = 'no deposit reported yet';
    return { ...r, pay_currency_name: coinName(r.pay_currency), state, due_cents: due, paid_so_far_cents: paidSoFar, tolerance_cents: tolerance, why_not_applied: why };
  });
}

/**
 * Round 28 (1): a deposit the provider called finished/confirmed that has sat unapplied for over a minute (an IPN that
 * never applied, a row updated by a path that did not run the apply) is asked about again and decided: paid, underpaid or
 * held. Called from the buyer's payment reads and the unpaid-order reaper; a provider failure only means no change.
 */
export const STUCK_AFTER_MS = 60_000;
export async function settleStuckPayments(ctx: Ctx, ref: PayableRef): Promise<number> {
  if (!(ctx.payments instanceof NowPaymentsProvider)) return 0;
  const p = 'orderId' in ref ? { kind: 'order', id: ref.orderId } : { kind: 'checkout', id: ref.checkoutId };
  const status = await maybeOne<{ status: string }>(ctx.db, p.kind === 'order' ? 'SELECT status FROM orders WHERE id = $1' : 'SELECT status FROM checkouts WHERE id = $1', [p.id]);
  if (!status || status.status !== 'awaiting_payment') return 0;
  const stuck = await many<{ payment_id: string }>(
    ctx.db,
    `SELECT payment_id FROM crypto_payments WHERE ${whereRef(p)} AND status IN ('finished', 'confirmed', 'sending') AND applied_at IS NULL
        AND review_reason IS NULL AND COALESCE(credited_cents, 0) = 0 AND updated_at < now() - make_interval(secs => $2)`,
    [p.id, STUCK_AFTER_MS / 1000],
  );
  let n = 0;
  for (const { payment_id } of stuck) {
    try {
      await recheckCryptoPayment(ctx, payment_id);
      n++;
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : err, paymentId: payment_id }, 'stuck crypto payment re-check failed');
    }
  }
  return n;
}

/**
 * Staff "Re-check with NOWPayments": ask the provider for the payment as it is now and run it through the same path an
 * IPN takes (funds the order, credits the balance, or holds it). The row's provider answer is kept on it.
 */
export async function recheckCryptoPayment(ctx: Ctx, paymentId: string) {
  const np = provider(ctx);
  const row = await maybeOne<{ id: string; order_id: string | null; checkout_id: string | null; status: string }>(ctx.db, 'SELECT id, order_id, checkout_id, status FROM crypto_payments WHERE payment_id = $1', [paymentId]);
  if (!row) throw notFound('Payment');
  const p = await viaProvider(ctx, 'get_payment', () => np.getPayment(paymentId));
  const before = row.status;
  await applyCryptoPayment(ctx, {
    type: 'crypto.payment',
    paymentId: String(p.payment_id),
    orderId: p.order_id ? String(p.order_id) : (row.order_id ?? row.checkout_id)!,
    purchaseId: p.purchase_id != null ? String(p.purchase_id) : null,
    status: p.payment_status,
    payCurrency: p.pay_currency,
    payAmount: Number(p.pay_amount),
    actuallyPaid: Number(p.actually_paid ?? 0),
    actuallyPaidUsd: p.actually_paid_at_fiat != null ? Number(p.actually_paid_at_fiat) : null,
    priceUsd: Number(p.price_amount),
    outcomeAmount: p.outcome_amount != null ? Number(p.outcome_amount) : null,
    outcomeCurrency: p.outcome_currency ?? null,
    raw: p,
  });
  const after = (await listCryptoPayments(ctx.db, { q: paymentId, limit: 1 }, ctx))[0];
  return { before, provider_status: p.payment_status, payment: after };
}
