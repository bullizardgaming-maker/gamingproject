import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { closeChargeback, receiveChargeback } from './chargebacks.js';
import { cancelOrder, createOrder, fundWithoutCard, handlePaymentCaptured, handlePaymentCapturedIn, type CreateOrderInput } from './orders.js';
import type { TxScope } from './events.js';

/**
 * Cart checkout: several listings, possibly from several sellers, paid with one card payment.
 * Each listing becomes its own order (own escrow, delivery deadline, chat, dispute and refund),
 * created through the normal order path, so stock, fraud checks and pricing are identical. The
 * orders share one PSP payment; its capture is split back to them, refunds are made per order
 * (partial refunds of the shared payment) and a chargeback is shared out by what each order charged.
 */
export const MAX_CART_ITEMS = 20;

export interface CartInput extends Omit<CreateOrderInput, 'offerId' | 'quantity' | 'checkoutId' | 'promoCode' | 'walletAddress'> {
  items: Array<{ offerId: string; quantity: number; characterName?: string } & Pick<CreateOrderInput, 'deliveryMethod' | 'deliveryInfo' | 'saveInfo'>>;
}

export async function checkoutByRef(q: Queryable, ref: string) {
  return maybeOne<any>(q, 'SELECT * FROM checkouts WHERE payment_ref = $1', [ref]);
}

/** Split `total` across `weights` in proportion, rounding so the parts add up exactly. */
export function splitProportional(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % parts.length, rest--) parts[i]! += 1;
  return parts;
}

export async function createCartCheckout(ctx: Ctx, input: CartInput) {
  if (input.rail !== 'fiat') throw badRequest('cart_card_only', 'A cart is paid by card; buy crypto-escrow listings one at a time');
  if (!input.items.length || input.items.length > MAX_CART_ITEMS) throw badRequest('invalid_cart', `A cart holds 1 to ${MAX_CART_ITEMS} listings`);
  if (new Set(input.items.map((i) => i.offerId)).size !== input.items.length) throw badRequest('invalid_cart', 'Each listing can appear once; change its quantity instead');
  const currency = (input.currency ?? ctx.cfg.SETTLEMENT_CURRENCY).toUpperCase();

  if (input.idempotencyKey) {
    const existing = await maybeOne<any>(ctx.db, 'SELECT * FROM checkouts WHERE buyer_id = $1 AND idempotency_key = $2', [input.buyer.id, input.idempotencyKey]);
    if (existing) return { ...(await cartView(ctx.db, existing.id)), checkoutUrl: null, replayed: true };
  }
  const checkout = await one<{ id: string }>(
    ctx.db,
    'INSERT INTO checkouts (buyer_id, idempotency_key) VALUES ($1, $2) RETURNING id',
    [input.buyer.id, input.idempotencyKey ?? null],
  );

  const created: Array<{ id: string; presentment_amount_cents: number }> = [];
  const fail = async (err: unknown) => {
    for (const o of created) await cancelOrder(ctx, o.id, null, 'cart_checkout_failed').catch(() => {});
    await ctx.db.query(`UPDATE checkouts SET status = 'cancelled' WHERE id = $1`, [checkout.id]);
    throw err;
  };
  try {
    for (const item of input.items) {
      const { order } = await createOrder(ctx, { ...input, idempotencyKey: undefined, currency, offerId: item.offerId, quantity: item.quantity, characterName: item.characterName, deliveryMethod: item.deliveryMethod, deliveryInfo: item.deliveryInfo, saveInfo: item.saveInfo, checkoutId: checkout.id });
      created.push(order as any);
    }
  } catch (err) {
    return fail(err);
  }

  const total = created.reduce((s, o) => s + Number(o.presentment_amount_cents), 0);
  if (total === 0) {
    // The buyer's balance covers everything: no payment to wait for.
    try {
      for (const o of created) await fundWithoutCard(ctx, o.id);
      await ctx.db.query(
        `UPDATE checkouts SET status = 'paid', paid_at = now(), payment_provider = 'none', payment_ref = $2, presentment_amount_cents = 0, presentment_currency = $3 WHERE id = $1`,
        [checkout.id, `nocard_${checkout.id}`, currency],
      );
      return { ...(await cartView(ctx.db, checkout.id)), checkoutUrl: null, replayed: false };
    } catch (err) {
      return fail(err);
    }
  }
  try {
    const session = await ctx.payments.createCheckout({
      orderId: checkout.id,
      amountCents: total,
      currency,
      description: `Bullizard order: ${created.length} item${created.length === 1 ? '' : 's'}`,
      buyerEmail: input.buyer.email,
      successUrl: `${ctx.cfg.PUBLIC_WEB_URL}/orders?checkout=success`,
      cancelUrl: `${ctx.cfg.PUBLIC_WEB_URL}/cart?checkout=cancelled`,
      expiresAt: new Date(Date.now() + ctx.cfg.ORDER_PAYMENT_TTL_MINUTES * 60_000),
    });
    await ctx.db.query(
      'UPDATE checkouts SET payment_provider = $2, payment_ref = $3, presentment_amount_cents = $4, presentment_currency = $5 WHERE id = $1',
      [checkout.id, session.provider, session.ref, total, currency],
    );
    await ctx.db.query('UPDATE orders SET payment_provider = $2, payment_ref = $3 WHERE checkout_id = $1', [checkout.id, session.provider, session.ref]);
    return { ...(await cartView(ctx.db, checkout.id)), checkoutUrl: session.redirectUrl, replayed: false };
  } catch (err) {
    return fail(err);
  }
}

export async function cartView(q: Queryable, checkoutId: string) {
  const checkout = await one<any>(q, 'SELECT id, buyer_id, status, presentment_amount_cents, presentment_currency, payment_ref, created_at, paid_at FROM checkouts WHERE id = $1', [checkoutId]);
  const orders = await many<any>(
    q,
    `SELECT o.id, o.status, o.seller_id, o.offer_id, o.quantity, o.amount_cents, o.credit_cents, o.charged_cents, o.currency, o.presentment_amount_cents, o.presentment_currency,
            o.unit_price_cents, o.character_name, o.delivery_method, o.delivery_info, o.ref, f.title AS offer_title, u.display_name AS seller_name
       FROM orders o JOIN offers f ON f.id = o.offer_id JOIN users u ON u.id = o.seller_id
      WHERE o.checkout_id = $1 ORDER BY o.created_at`,
    [checkoutId],
  );
  return { checkout, orders };
}

/**
 * Round 25b (H1): every order of a cart must carry the checkout's presentment currency, and their amounts must add up
 * to the checkout's, or a capture would be refused per order and the buyer's money left unapplied. Normally they do
 * (quotes and payments go through the checkout); if they don't (an order re-quoted alone before Round 25b), the orders
 * are re-synced to the checkout: its currency, its total split by what each order charges in USD. Logged.
 */
export async function alignCartOrders(q: Queryable, log: Ctx['log'], checkout: { id: string; presentment_currency: string; presentment_amount_cents: number | string }) {
  const orders = await many<{ id: string; presentment_amount_cents: number; presentment_currency: string; charged_cents: number }>(
    q, 'SELECT id, presentment_amount_cents, presentment_currency, charged_cents FROM orders WHERE checkout_id = $1 ORDER BY created_at', [checkout.id],
  );
  const total = Number(checkout.presentment_amount_cents);
  const sum = orders.reduce((s, o) => s + Number(o.presentment_amount_cents), 0);
  if (orders.every((o) => o.presentment_currency === checkout.presentment_currency) && sum === total) return orders;
  const parts = splitProportional(total, orders.map((o) => Number(o.charged_cents)));
  for (const [i, o] of orders.entries()) {
    await q.query('UPDATE orders SET presentment_currency = $2, presentment_amount_cents = $3 WHERE id = $1', [o.id, checkout.presentment_currency, parts[i]]);
    o.presentment_currency = checkout.presentment_currency;
    o.presentment_amount_cents = parts[i]!;
  }
  log.warn({ checkoutId: checkout.id, orders: orders.length }, 'cart orders re-synced to the checkout currency before capture');
  return orders;
}

/** A captured cart payment: verify the total, then capture each order with its share. */
export async function handleCheckoutCaptured(ctx: Ctx, ev: Extract<PaymentEvent, { type: 'payment.captured' }>) {
  const checkout = await checkoutByRef(ctx.db, ev.ref);
  if (!checkout) throw badRequest('payment_mismatch', 'Unknown checkout');
  if (Number(checkout.presentment_amount_cents) !== ev.amountCents || checkout.presentment_currency !== ev.currency) {
    throw badRequest('amount_mismatch', 'Captured amount does not match checkout');
  }
  const orders = await alignCartOrders(ctx.db, ctx.log, checkout);
  const weights = orders.map((o) => Number(o.presentment_amount_cents));
  const settled = ev.details.settledAmountCents != null ? splitProportional(ev.details.settledAmountCents, weights) : null;
  const fees = ev.details.feeCents != null ? splitProportional(ev.details.feeCents, weights) : null;
  const over = ev.details.overpaidCents ? splitProportional(ev.details.overpaidCents, weights) : null;
  const fxGap = ev.details.fxGapCents ? splitProportional(ev.details.fxGapCents, weights) : null;
  const pfee = ev.details.processingFeeCents ? splitProportional(ev.details.processingFeeCents, weights) : null;
  // Each order is captured in its own transaction and is idempotent, so a replayed webhook (or one
  // that failed halfway) completes the rest without double-capturing.
  for (const [i, o] of orders.entries()) {
    await handlePaymentCaptured(ctx, {
      ...ev,
      orderId: o.id,
      amountCents: Number(o.presentment_amount_cents),
      details: { ...ev.details, settledAmountCents: settled?.[i], feeCents: fees?.[i], overpaidCents: over?.[i], fxGapCents: fxGap?.[i], processingFeeCents: pfee?.[i] },
    });
  }
  await ctx.db.query(`UPDATE checkouts SET status = 'paid', paid_at = COALESCE(paid_at, now()) WHERE id = $1`, [checkout.id]);
  return cartView(ctx.db, checkout.id);
}

/** The same inside the caller's transaction (crypto IPN path, which holds the cart's order rows locked; Round 22). */
export async function handleCheckoutCapturedIn(ctx: Ctx, s: TxScope, ev: Extract<PaymentEvent, { type: 'payment.captured' }>) {
  const checkout = await checkoutByRef(s.tx, ev.ref);
  if (!checkout) throw badRequest('payment_mismatch', 'Unknown checkout');
  if (Number(checkout.presentment_amount_cents) !== ev.amountCents || checkout.presentment_currency !== ev.currency) {
    throw badRequest('amount_mismatch', 'Captured amount does not match checkout');
  }
  const orders = await alignCartOrders(s.tx, ctx.log, checkout);
  const weights = orders.map((o) => Number(o.presentment_amount_cents));
  const settled = ev.details.settledAmountCents != null ? splitProportional(ev.details.settledAmountCents, weights) : null;
  const fees = ev.details.feeCents != null ? splitProportional(ev.details.feeCents, weights) : null;
  const over = ev.details.overpaidCents ? splitProportional(ev.details.overpaidCents, weights) : null;
  const fxGap = ev.details.fxGapCents ? splitProportional(ev.details.fxGapCents, weights) : null;
  const pfee = ev.details.processingFeeCents ? splitProportional(ev.details.processingFeeCents, weights) : null;
  for (const [i, o] of orders.entries()) {
    await handlePaymentCapturedIn(ctx, s, {
      ...ev,
      orderId: o.id,
      amountCents: Number(o.presentment_amount_cents),
      details: { ...ev.details, settledAmountCents: settled?.[i], feeCents: fees?.[i], overpaidCents: over?.[i], fxGapCents: fxGap?.[i], processingFeeCents: pfee?.[i] },
    });
  }
  await s.tx.query(`UPDATE checkouts SET status = 'paid', paid_at = COALESCE(paid_at, now()) WHERE id = $1`, [checkout.id]);
  return cartView(s.tx, checkout.id);
}

/** A chargeback on a cart payment: shared out over its orders by what each charged to the card. */
export async function receiveCheckoutChargeback(
  ctx: Ctx,
  checkout: { id: string },
  input: { disputeRef: string; network: 'visa' | 'mastercard'; reasonCode: string; amountCents: number },
) {
  const orders = await many<{ id: string; charged_cents: number }>(ctx.db, 'SELECT id, charged_cents FROM orders WHERE checkout_id = $1 ORDER BY created_at', [checkout.id]);
  const parts = splitProportional(input.amountCents, orders.map((o) => Number(o.charged_cents)));
  const out = [];
  for (const [i, o] of orders.entries()) {
    if (!parts[i]) continue;
    out.push(await receiveChargeback(ctx, { orderId: o.id, disputeRef: `${input.disputeRef}:${o.id}`, network: input.network, reasonCode: input.reasonCode, amountCents: parts[i]! }));
  }
  return out;
}

/** Close every per-order part of a cart chargeback. Returns null when the dispute isn't a cart one. */
export async function closeCheckoutChargeback(ctx: Ctx, disputeRef: string, won: boolean) {
  const parts = await many<{ provider_ref: string }>(ctx.db, `SELECT provider_ref FROM chargebacks WHERE provider_ref LIKE $1`, [`${disputeRef.replace(/[\\%_]/g, '\\$&')}:%`]);
  if (!parts.length) return null;
  for (const p of parts) await closeChargeback(ctx, p.provider_ref, won);
  return parts.length;
}
