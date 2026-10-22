import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, notFound, AppError } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { NowPaymentsProvider } from '../providers/payments/nowpayments.js';
import { handlePaymentCaptured, lockOrder, type Order } from './orders.js';
import { checkoutByRef, handleCheckoutCaptured } from './cart.js';
import { accountId, post } from './ledger.js';
import { enqueueEmail } from './notifications.js';
import { withScope } from './events.js';
import { appendMessage } from './chat.js';

/**
 * Crypto checkout (migration 053). The buyer picks a coin on our order page; we create a
 * NOWPayments payment and show the address and exact amount. Status changes arrive by IPN:
 *  - finished/confirmed with enough paid: the order is funded exactly like a card capture
 *    (handlePaymentCaptured), settled at what reached the store wallet.
 *  - partially_paid: the shortfall is shown and the buyer creates a top-up payment that shares the
 *    first payment's purchase id; once the payments together cover the price, the order is funded.
 *  - expired/failed: nothing happens here; the unpaid-order reaper cancels the order when its
 *    payment window lapses (a late deposit is still accepted and refunded by hand).
 * Refunds are manual: a queue for the CFO, booked as `refunds_payable` until the coins are sent.
 */
const COIN_NAMES: Record<string, string> = {
  btc: 'Bitcoin', eth: 'Ethereum', ltc: 'Litecoin', usdttrc20: 'Tether (TRC-20)', usdterc20: 'Tether (ERC-20)', usdtbsc: 'Tether (BEP-20)',
  usdc: 'USD Coin', usdcerc20: 'USD Coin (ERC-20)', usdcbsc: 'USD Coin (BEP-20)', usdcsol: 'USD Coin (Solana)', trx: 'TRON', bnb: 'BNB', sol: 'Solana',
  doge: 'Dogecoin', xmr: 'Monero', ton: 'Toncoin', xrp: 'XRP', matic: 'Polygon', bch: 'Bitcoin Cash', dai: 'Dai',
};
export const coinName = (c: string) => COIN_NAMES[c] ?? c.toUpperCase();

function provider(ctx: Ctx): NowPaymentsProvider {
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'crypto_unavailable', 'Crypto checkout is not configured');
  return ctx.payments;
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
  title: string;
}

async function payable(q: Queryable, ref: PayableRef, buyerId: string, forPaying = true): Promise<Payable> {
  let p: Payable | null;
  if ('orderId' in ref) {
    const o = await maybeOne<any>(q, 'SELECT o.*, f.title FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.id = $1', [ref.orderId]);
    p = o && { kind: 'order', id: o.id, buyer_id: o.buyer_id, status: o.status, payment_provider: o.payment_provider, payment_ref: o.payment_ref, charged_cents: Number(o.charged_cents), currency: o.currency, presentment_amount_cents: Number(o.presentment_amount_cents), presentment_currency: o.presentment_currency, title: `${o.title} x${o.quantity}` };
  } else {
    const c = await maybeOne<any>(
      q,
      `SELECT c.*, (SELECT SUM(o.charged_cents) FROM orders o WHERE o.checkout_id = c.id)::bigint AS charged_cents,
              (SELECT min(o.currency) FROM orders o WHERE o.checkout_id = c.id) AS currency, (SELECT count(*)::int FROM orders o WHERE o.checkout_id = c.id) AS n
         FROM checkouts c WHERE c.id = $1`,
      [ref.checkoutId],
    );
    p = c && { kind: 'checkout', id: c.id, buyer_id: c.buyer_id, status: c.status, payment_provider: c.payment_provider, payment_ref: c.payment_ref, charged_cents: Number(c.charged_cents ?? 0), currency: c.currency ?? 'USD', presentment_amount_cents: Number(c.presentment_amount_cents ?? 0), presentment_currency: c.presentment_currency ?? 'USD', title: `Bullizard order: ${c.n} item${c.n === 1 ? '' : 's'}` };
  }
  if (!p || p.buyer_id !== buyerId) throw notFound('orderId' in ref ? 'Order' : 'Checkout');
  if (forPaying) {
    if (p.status !== 'awaiting_payment') throw conflict('invalid_state', `This ${p.kind} is ${p.status}`);
    if (p.payment_provider !== 'nowpayments') throw conflict('not_crypto', `This ${p.kind} is not paid with crypto`);
  }
  return p;
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

/** Coins the buyer can pay with: only those whose minimum fits what is still owed. */
export async function coinsFor(ctx: Ctx, ref: PayableRef, buyerId: string) {
  const np = provider(ctx);
  const p = await payable(ctx.db, ref, buyerId);
  const owed = p.charged_cents - (await paidSoFarCents(ctx.db, p));
  const coins = await np.coinsFor(usd(owed));
  return { owedCents: owed, currency: p.currency, coins: coins.map((c) => ({ ...c, name: coinName(c.coin) })) };
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
  actually_paid: string;
  actually_paid_usd: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
}

const VIEW = 'id, payment_id, pay_currency, pay_address, pay_extra_id, pay_amount::text, price_usd::text, actually_paid::text, actually_paid_usd::text, status, expires_at, created_at';

export async function paymentsFor(q: Queryable, ref: PayableRef) {
  const p = 'orderId' in ref ? { kind: 'order', id: ref.orderId } : { kind: 'checkout', id: ref.checkoutId };
  const rows = await many<CryptoPaymentView>(q, `SELECT ${VIEW} FROM crypto_payments WHERE ${whereRef(p)} ORDER BY created_at`, [p.id]);
  return rows.map((r) => ({ ...r, pay_currency_name: coinName(r.pay_currency) }));
}
export const paymentsForOrder = (q: Queryable, orderId: string) => paymentsFor(q, { orderId });

/** The buyer picked a coin: create the payment for what is still owed (the whole price, or the top-up after an underpayment). */
export async function startCryptoPayment(ctx: Ctx, ref: PayableRef, buyerId: string, coin: string) {
  const np = provider(ctx);
  const o = await payable(ctx.db, ref, buyerId);
  const open = await maybeOne<{ id: string; payment_id: string; pay_currency: string; expires_at: string | null }>(
    ctx.db,
    `SELECT id, payment_id, pay_currency, expires_at FROM crypto_payments WHERE ${whereRef(o)} AND status IN ('waiting', 'confirming', 'confirmed', 'sending') ORDER BY created_at DESC LIMIT 1`,
    [o.id],
  );
  if (open && (!open.expires_at || new Date(open.expires_at) > new Date())) {
    throw new AppError(409, 'payment_open', `A ${coinName(open.pay_currency)} payment is already waiting for your transfer`, { paymentId: open.payment_id });
  }
  const owed = o.charged_cents - (await paidSoFarCents(ctx.db, o));
  if (owed <= 0) throw conflict('already_paid', 'This order is paid; waiting for the network to confirm');
  const coins = await np.coinsFor(usd(owed));
  if (!coins.some((c) => c.coin === coin)) throw badRequest('coin_unavailable', `${coinName(coin)} can’t be used for this amount`);
  const first = await maybeOne<{ purchase_id: string | null }>(ctx.db, `SELECT purchase_id FROM crypto_payments WHERE ${whereRef(o)} ORDER BY created_at LIMIT 1`, [o.id]);
  const p = await np.createPayment({
    amountUsd: usd(owed),
    coin,
    orderId: o.id,
    description: o.title,
    ipnCallbackUrl: `${ctx.apiBaseUrl}/v1/payments/webhook/nowpayments`,
    purchaseId: first?.purchase_id ?? null,
    sandboxCase: ctx.cfg.NOWPAYMENTS_SANDBOX_CASE,
  });
  // The address stays valid well past the estimate's expiry; give the order a full hour from now to be paid.
  const row = await withTx(ctx.db, async (tx) => {
    const r = await one<CryptoPaymentView>(
      tx,
      `INSERT INTO crypto_payments (order_id, checkout_id, payment_id, purchase_id, pay_currency, pay_address, pay_extra_id, pay_amount, price_usd, status, expires_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${VIEW}`,
      [
        o.kind === 'order' ? o.id : null, o.kind === 'checkout' ? o.id : null, String(p.payment_id), p.purchase_id != null ? String(p.purchase_id) : null, p.pay_currency.toLowerCase(), p.pay_address,
        p.payin_extra_id ?? null, p.pay_amount, usd(owed), p.payment_status ?? 'waiting', p.expiration_estimate_date ?? null, JSON.stringify(p),
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
  const row = await maybeOne<{ status: string }>(ctx.db, `SELECT status FROM crypto_payments WHERE ${whereRef(o)} AND payment_id = $2`, [o.id, paymentId]);
  if (!row) throw notFound('Payment');
  if (['finished', 'failed', 'refunded', 'expired'].includes(row.status)) return paymentsFor(ctx.db, ref);
  try {
    const p = await np.getPayment(paymentId);
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
  const row = await maybeOne<{ id: string; order_id: string | null; checkout_id: string | null; status: string }>(ctx.db, 'SELECT id, order_id, checkout_id, status FROM crypto_payments WHERE payment_id = $1', [ev.paymentId]);
  if (!row) {
    ctx.log.warn({ paymentId: ev.paymentId, orderId: ev.orderId }, 'IPN for an unknown crypto payment');
    return null;
  }
  // A deposit's USD value: NOWPayments reports it when it has one; otherwise value the coins at the payment's own rate.
  const paidUsd = ev.actuallyPaidUsd ?? (ev.payAmount > 0 ? (ev.actuallyPaid / ev.payAmount) * ev.priceUsd : 0);
  await ctx.db.query(
    `UPDATE crypto_payments SET status = $2, actually_paid = $3, actually_paid_usd = $4, outcome_amount = $5, outcome_currency = $6, raw = $7, updated_at = now() WHERE id = $1`,
    [row.id, ev.status, ev.actuallyPaid, PAID_STATUSES.has(ev.status) ? paidUsd : null, ev.outcomeAmount, ev.outcomeCurrency, JSON.stringify(ev.raw ?? {})],
  );

  const ref: PayableRef = row.order_id ? { orderId: row.order_id } : { checkoutId: row.checkout_id! };
  const buyerId = (await one<{ buyer_id: string }>(ctx.db, row.order_id ? 'SELECT buyer_id FROM orders WHERE id = $1' : 'SELECT buyer_id FROM checkouts WHERE id = $1', [row.order_id ?? row.checkout_id])).buyer_id;
  const target = await payable(ctx.db, ref, buyerId, false);
  if (target.status !== 'awaiting_payment') return target; // already funded (or cancelled: a late deposit is refunded by hand)
  if (!PAID_STATUSES.has(ev.status)) return target;

  const paid = await paidSoFarCents(ctx.db, target);
  const tolerance = Math.floor((target.charged_cents * ctx.cfg.CRYPTO_UNDERPAY_TOLERANCE_BPS) / 10_000);
  if (paid + tolerance < target.charged_cents) {
    if (ev.status === 'partially_paid' && row.status !== 'partially_paid') {
      const link = target.kind === 'order' ? target.id : `cart:${target.id}`;
      await enqueueEmail(ctx.db, target.buyer_id, 'crypto_underpaid', { order_id: link, paid_cents: paid, owed_cents: target.charged_cents - paid, currency: target.currency }, `crypto_underpaid:${ev.paymentId}`);
    }
    return target;
  }
  // Enough has arrived. What reached the store wallet in USDT/USDC is the settled amount; the gap is the provider's fee.
  const settled = await settledCents(ctx.db, target, target.charged_cents);
  const captured: Extract<PaymentEvent, { type: 'payment.captured' }> = {
    type: 'payment.captured',
    ref: target.payment_ref!,
    orderId: target.id,
    amountCents: target.presentment_amount_cents,
    currency: target.presentment_currency,
    details: { settledAmountCents: settled, feeCents: Math.max(0, target.charged_cents - settled), raw: { payments: await paymentsFor(ctx.db, ref) } },
  };
  if (target.kind === 'checkout' && (await checkoutByRef(ctx.db, target.payment_ref!))) return handleCheckoutCaptured(ctx, captured);
  return handlePaymentCaptured(ctx, captured);
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
    if (room) await appendMessage(s, room.id, null, 'system', `The buyer gave a ${coinName(input.currency.toLowerCase())} address for the refund; the treasury sends it within three working days.`);
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
