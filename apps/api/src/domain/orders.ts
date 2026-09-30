import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, forbidden, notFound, AppError } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { appendMessage, createOrderRoom } from './chat.js';
import { commissionBps, sellerTier, splitAmount } from './commission.js';
import type { TxScope } from './events.js';
import { withScope } from './events.js';
import { applyRiskActions, assessOrder, recordSignals, subnetOf } from './fraud.js';
import { availableCount, markDelivered, releaseReservation, reserveInventory, reserveManualStock, storeManualDelivery } from './inventory.js';
import { accountId, orderEscrowBalance, post } from './ledger.js';
import { centsToTokenUnits, orderIdToBytes32 } from './web3.js';
import { enqueueWebhook } from './webhooks.js';
import { enqueueEmail } from './notifications.js';

export type OrderStatus = 'awaiting_payment' | 'paid' | 'delivered' | 'completed' | 'disputed' | 'refunded' | 'cancelled' | 'charged_back';

export interface Order {
  id: string;
  buyer_id: string;
  seller_id: string;
  offer_id: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  currency: string;
  commission_bps: number;
  commission_cents: number;
  seller_net_cents: number;
  seller_tier: string;
  rail: 'fiat' | 'crypto';
  status: OrderStatus;
  protection: 'inspection_72h' | 'insurance_14d';
  protection_ends_at: string | null;
  escrow_frozen: boolean;
  seller_protected: boolean;
  payment_provider: string | null;
  payment_ref: string | null;
  payment_expires_at: string | null;
  risk_score: number | null;
  version: number;
  paid_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export const PROTECTION_WINDOWS = {
  inspection_72h: 72 * 3600 * 1000,
  insurance_14d: 14 * 24 * 3600 * 1000,
} as const;

/** Share of each commission retained in the chargeback reserve that backs the Chargeback Shield. */
export const RESERVE_SHARE_BPS = 1_000; // 10% of commission

export const SECURITY_CHECKLIST = [
  { key: 'password_changed', label: 'Change the account password' },
  { key: 'recovery_email_changed', label: 'Replace the recovery email with an address only you control' },
  { key: 'recovery_phone_changed', label: 'Replace or remove the recovery phone number' },
  { key: 'twofa_regenerated', label: 'Enable 2FA and regenerate backup codes' },
  { key: 'sessions_revoked', label: 'Sign out of all other sessions and devices' },
  { key: 'third_party_unlinked', label: 'Unlink social logins and third-party apps' },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function lockOrder(tx: Tx, orderId: string): Promise<Order & { delivery_mode: string; category_kind: string; title: string }> {
  const order = await maybeOne(
    tx,
    `SELECT o.*, f.delivery_mode, f.title, c.kind AS category_kind
       FROM orders o JOIN offers f ON f.id = o.offer_id JOIN categories c ON c.slug = f.category_slug
      WHERE o.id = $1 FOR UPDATE OF o`,
    [orderId],
  );
  if (!order) throw notFound('Order');
  return order;
}

async function transition(
  tx: Tx,
  order: Pick<Order, 'id' | 'status'>,
  to: OrderStatus,
  actorId: string | null,
  reason: string,
  extraSql = '',
  extraParams: unknown[] = [],
  meta: Record<string, unknown> = {},
) {
  const res = await tx.query(
    `UPDATE orders SET status = $3, version = version + 1, updated_at = now() ${extraSql}
      WHERE id = $1 AND status = $2`,
    [order.id, order.status, to, ...extraParams],
  );
  if (res.rowCount !== 1) throw conflict('invalid_state', `Order is no longer ${order.status}`);
  await tx.query(
    'INSERT INTO order_events (order_id, from_status, to_status, actor_id, reason, meta) VALUES ($1, $2, $3, $4, $5, $6)',
    [order.id, order.status, to, actorId, reason, meta],
  );
  order.status = to;
}

function roomOf(tx: Queryable, orderId: string) {
  return one<{ id: string }>(tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [orderId]);
}

function emailData(o: Order & { title: string }, extra: Record<string, unknown> = {}) {
  return {
    order_id: o.id, title: o.title, quantity: o.quantity, amount_cents: o.amount_cents, currency: o.currency,
    seller_net_cents: o.seller_net_cents, protection: o.protection, ...extra,
  };
}

function orderSummary(o: Order) {
  return {
    id: o.id,
    offer_id: o.offer_id,
    buyer_id: o.buyer_id,
    quantity: o.quantity,
    amount_cents: o.amount_cents,
    currency: o.currency,
    seller_net_cents: o.seller_net_cents,
    commission_cents: o.commission_cents,
    status: o.status,
    rail: o.rail,
    protection: o.protection,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export interface CreateOrderInput {
  buyer: { id: string; email: string; kyc_tier: number; status: string };
  offerId: string;
  quantity: number;
  rail: 'fiat' | 'crypto';
  idempotencyKey?: string;
  acceptTos: boolean;
  ip?: string;
  ipCountry?: string;
  device?: string;
  walletAddress?: string;
}

export async function createOrder(ctx: Ctx, input: CreateOrderInput) {
  const { buyer } = input;
  if (buyer.status !== 'active') throw forbidden('suspended', 'Account suspended');
  if (buyer.kyc_tier < 1) throw forbidden('kyc_required', 'Verify your email and phone (Tier 1) before purchasing');
  if (!input.acceptTos) throw badRequest('tos_required', 'You must accept the Terms of Service');
  if (input.rail === 'crypto' && !input.walletAddress) throw badRequest('wallet_required', 'walletAddress is required for crypto escrow');

  if (input.idempotencyKey) {
    const existing = await maybeOne<Order>(ctx.db, 'SELECT * FROM orders WHERE buyer_id = $1 AND idempotency_key = $2', [buyer.id, input.idempotencyKey]);
    if (existing) return { order: existing, checkoutUrl: null, replayed: true };
  }

  const order = await withScope(ctx, async (s) => {
    const offer = await maybeOne(
      s.tx,
      `SELECT f.*, c.kind AS category_kind, c.risk_class, c.promo_rate_bps, c.name AS category_name, u.status AS seller_status,
              (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now())) AS shop_paused, u.shop_pause_message
         FROM offers f JOIN categories c ON c.slug = f.category_slug JOIN users u ON u.id = f.seller_id
        WHERE f.id = $1`,
      [input.offerId],
    );
    if (!offer || offer.status !== 'active' || offer.seller_status !== 'active') throw notFound('Offer');
    if (offer.shop_paused) throw conflict('shop_paused', offer.shop_pause_message || 'This seller is away and not taking orders right now');
    if (offer.seller_id === buyer.id) throw forbidden('own_offer', 'You cannot buy your own offer');
    if (offer.category_kind === 'account' && input.quantity !== 1) throw badRequest('invalid_quantity', 'Accounts are sold one at a time');

    const { tier } = await sellerTier(s.tx, offer.seller_id);
    const rate = commissionBps(tier, { kind: offer.category_kind, promo_rate_bps: offer.promo_rate_bps });
    const amount = offer.price_cents * input.quantity;
    const split = splitAmount(amount, rate);
    const protection = offer.risk_class === 'high' ? 'insurance_14d' : 'inspection_72h';
    // "High Risk - Secondary Market": account listings without verified Original Owner Proof.
    const sellerProtected = offer.category_kind !== 'account' || offer.owner_proof_status === 'verified';

    const order = await one<Order>(
      s.tx,
      `INSERT INTO orders (buyer_id, seller_id, offer_id, quantity, unit_price_cents, amount_cents, currency,
                           commission_bps, commission_cents, seller_net_cents, seller_tier, rail, status, protection,
                           seller_protected, payment_expires_at, tos_version, tos_accepted_at, buyer_ip, buyer_ip_country,
                           buyer_device, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'awaiting_payment', $13, $14,
               now() + make_interval(mins => $15), $16, now(), $17, $18, $19, $20)
       RETURNING *`,
      [
        buyer.id, offer.seller_id, offer.id, input.quantity, offer.price_cents, amount, offer.currency,
        rate, split.commissionCents, split.sellerNetCents, tier.name, input.rail, protection, sellerProtected,
        ctx.cfg.ORDER_PAYMENT_TTL_MINUTES, ctx.cfg.TOS_VERSION, input.ip ?? null, input.ipCountry ?? null,
        input.device ?? null, input.idempotencyKey ?? null,
      ],
    );

    if (offer.delivery_mode === 'auto') await reserveInventory(s.tx, offer.id, order.id, input.quantity);
    else await reserveManualStock(s.tx, offer.id, input.quantity);

    const snapshot = {
      offer: {
        id: offer.id, title: offer.title, description: offer.description, game: offer.game, category: offer.category_name,
        price_cents: offer.price_cents, currency: offer.currency, delivery_mode: offer.delivery_mode,
        owner_proof_status: offer.owner_proof_status, version: offer.version,
      },
      terms: { protection, tos_version: ctx.cfg.TOS_VERSION, commission_bps: rate },
      captured_at: new Date().toISOString(),
    };
    const snapshotJson = JSON.stringify(snapshot);
    await s.tx.query('INSERT INTO offer_snapshots (order_id, snapshot, sha256) VALUES ($1, $2, $3)', [
      order.id, snapshotJson, createHash('sha256').update(snapshotJson).digest('hex'),
    ]);
    await s.tx.query('INSERT INTO order_events (order_id, from_status, to_status, actor_id, reason) VALUES ($1, NULL, $2, $3, $4)', [
      order.id, 'awaiting_payment', buyer.id, 'order_created',
    ]);

    const room = await createOrderRoom(s.tx, order.id, offer.id, buyer.id, offer.seller_id);
    await appendMessage(
      s, room.id, null, 'system',
      `Order created for "${offer.title}" x${input.quantity}. All communication for this order must stay in this chat — ` +
        `it is the evidence used for arbitration. Funds are held in escrow under the ` +
        (protection === 'insurance_14d' ? '14-Day Asset Insurance.' : '72-Hour Inspection Window.') +
        (sellerProtected ? '' : ' Notice: this listing is HIGH RISK - SECONDARY MARKET (no verified Original Owner Proof).'),
    );

    await recordSignals(s.tx, buyer.id, { device: input.device, ip_subnet: subnetOf(input.ip), wallet: input.walletAddress?.toLowerCase() });
    return order;
  });

  if (input.rail === 'crypto') {
    // payment_ref holds the bytes32 order id used on-chain, so the indexer can map events back.
    const chainRef = orderIdToBytes32(order.id);
    await ctx.db.query(`UPDATE orders SET payment_provider = 'escrow_contract', payment_ref = $2 WHERE id = $1`, [order.id, chainRef]);
    return { order: { ...order, payment_provider: 'escrow_contract', payment_ref: chainRef }, checkoutUrl: null, replayed: false };
  }

  try {
    const offerTitle = (await one<{ title: string }>(ctx.db, 'SELECT title FROM offers WHERE id = $1', [order.offer_id])).title;
    const session = await ctx.payments.createCheckout({
      orderId: order.id,
      amountCents: order.amount_cents,
      currency: order.currency,
      description: `${offerTitle} x${order.quantity}`,
      buyerEmail: buyer.email,
      successUrl: `${ctx.cfg.PUBLIC_WEB_URL}/orders/${order.id}?checkout=success`,
      cancelUrl: `${ctx.cfg.PUBLIC_WEB_URL}/orders/${order.id}?checkout=cancelled`,
      expiresAt: new Date(new Date(order.payment_expires_at!).getTime()),
    });
    await ctx.db.query('UPDATE orders SET payment_provider = $2, payment_ref = $3 WHERE id = $1', [order.id, session.provider, session.ref]);
    return { order: { ...order, payment_provider: session.provider, payment_ref: session.ref }, checkoutUrl: session.redirectUrl, replayed: false };
  } catch (err) {
    await cancelOrder(ctx, order.id, null, 'checkout_creation_failed');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Payment captured -> escrow funded -> (auto) delivery
// ---------------------------------------------------------------------------
export async function handlePaymentCaptured(ctx: Ctx, ev: Extract<PaymentEvent, { type: 'payment.captured' }>) {
  let refundNeeded: Order | null = null;
  const result = await withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, ev.orderId);
    if (order.payment_ref !== ev.ref) throw badRequest('payment_mismatch', 'Payment reference does not match order');
    if (order.amount_cents !== ev.amountCents || order.currency !== ev.currency) {
      throw badRequest('amount_mismatch', 'Captured amount does not match order');
    }
    if (order.status !== 'awaiting_payment') {
      if (order.status === 'cancelled' && !(await hasLedgerTxn(s.tx, order.id, 'payment_captured'))) {
        // Paid after the reservation expired: record the money and refund it.
        await postCapture(s.tx, order);
        refundNeeded = order;
      }
      return order; // idempotent replay
    }

    await postCapture(s.tx, order, ev.details.feeCents);
    await s.tx.query(
      `INSERT INTO payment_details (order_id, provider, avs_result, cvv_result, card_brand, card_last4, card_fingerprint, billing_country, ip_country, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [order.id, order.payment_provider, ev.details.avsResult, ev.details.cvvResult, ev.details.cardBrand, ev.details.cardLast4,
       ev.details.cardFingerprint, ev.details.billingCountry, (await ipCountryOf(s.tx, order.id)), JSON.stringify(ev.details.raw ?? {})],
    );
    await recordSignals(s.tx, order.buyer_id, { card: ev.details.cardFingerprint });
    await onFunded(ctx, s, order);
    return order;
  });

  if (refundNeeded) {
    const o = refundNeeded as Order;
    await ctx.payments.refund(o.payment_ref!, o.amount_cents);
    await withScope(ctx, async (s) => {
      const cur = await lockOrder(s.tx, o.id);
      await postRefund(s.tx, cur);
      await s.tx.query('INSERT INTO order_events (order_id, from_status, to_status, reason) VALUES ($1, $2, $2, $3)', [o.id, 'cancelled', 'late_payment_refunded']);
    });
  }
  return result;
}

async function ipCountryOf(q: Queryable, orderId: string) {
  return (await one<{ buyer_ip_country: string | null }>(q, 'SELECT buyer_ip_country FROM orders WHERE id = $1', [orderId])).buyer_ip_country;
}

async function hasLedgerTxn(q: Queryable, orderId: string, memo: string) {
  return !!(await maybeOne(q, 'SELECT 1 FROM ledger_entries WHERE order_id = $1 AND memo = $2 LIMIT 1', [orderId, memo]));
}

async function postCapture(tx: Tx, order: Order, feeCents = 0) {
  await post(
    tx,
    [
      { account: await accountId(tx, 'gateway_clearing', order.currency), amountCents: -order.amount_cents },
      { account: await accountId(tx, 'escrow', order.currency), amountCents: order.amount_cents },
    ],
    'payment_captured',
    order.id,
  );
  // The PSP keeps its processing fee; the platform pays it out of revenue, never out of escrow.
  if (feeCents > 0) {
    await post(
      tx,
      [
        { account: await accountId(tx, 'gateway_clearing', order.currency), amountCents: feeCents },
        { account: await accountId(tx, 'treasury', order.currency), amountCents: -feeCents },
      ],
      'psp_fee',
      order.id,
    );
  }
}

async function postRefund(tx: Tx, order: Order) {
  const held = await orderEscrowBalance(tx, order.id, order.currency);
  if (held <= 0) return;
  await post(
    tx,
    [
      { account: await accountId(tx, 'escrow', order.currency), amountCents: -held },
      { account: await accountId(tx, 'gateway_clearing', order.currency), amountCents: held },
    ],
    'refund',
    order.id,
  );
}

/** Shared by fiat capture and on-chain EscrowCreated. */
async function onFunded(ctx: Ctx, s: TxScope, order: Order & { delivery_mode: string; category_kind: string; title: string }) {
  // Manual orders get a delivery deadline from the listing's promised delivery time.
  await transition(
    s.tx, order, 'paid', null, 'payment_captured',
    `, paid_at = now(), delivery_due_at = CASE WHEN $4 = 'manual'
         THEN now() + make_interval(hours => (SELECT delivery_hours FROM offers WHERE id = orders.offer_id)) END`,
    [order.delivery_mode],
  );
  const room = await roomOf(s.tx, order.id);
  await appendMessage(s, room.id, null, 'system', `Payment received: ${(order.amount_cents / 100).toFixed(2)} ${order.currency} is locked in escrow.`);

  const risk = await assessOrder(ctx, s.tx, order.id);
  const { action } = await applyRiskActions(ctx, s, order, risk);

  await enqueueWebhook(s.tx, order.seller_id, 'order.created', orderSummary(order));
  await enqueueEmail(s.tx, order.buyer_id, 'order_paid', emailData(order));
  await enqueueEmail(s.tx, order.seller_id, 'seller_new_order', emailData(order, { delivery_mode: order.delivery_mode }));
  s.notifyUser(order.seller_id, 'order.created', { orderId: order.id });
  s.notifyUser(order.buyer_id, 'order.paid', { orderId: order.id });

  if (order.delivery_mode === 'auto') {
    if (action !== 'none') {
      await appendMessage(s, room.id, null, 'system', 'This order is under a routine security review. Delivery will proceed once the review completes.');
    } else {
      await deliver(ctx, s, order, null, 'auto_delivery');
    }
    const remaining = await availableCount(s.tx, order.offer_id);
    const { low_stock_threshold } = await one<{ low_stock_threshold: number }>(s.tx, 'SELECT low_stock_threshold FROM offers WHERE id = $1', [order.offer_id]);
    if (remaining <= low_stock_threshold) {
      await enqueueWebhook(s.tx, order.seller_id, 'offer.low_stock', { offer_id: order.offer_id, available: remaining, threshold: low_stock_threshold });
    }
  }
}

async function deliver(ctx: Ctx, s: TxScope, order: Order & { category_kind: string; title: string }, actorId: string | null, reason: string) {
  const count = await markDelivered(s.tx, order.id);
  const window = PROTECTION_WINDOWS[order.protection];
  await transition(
    s.tx, order, 'delivered', actorId, reason,
    ', delivered_at = now(), protection_ends_at = now() + make_interval(secs => $4)', [window / 1000],
  );
  const room = await roomOf(s.tx, order.id);
  await appendMessage(
    s, room.id, null, 'delivery',
    `Delivered${count ? ` (${count} item${count === 1 ? '' : 's'})` : ''}. The buyer can view the goods in the order dashboard. ` +
      (order.protection === 'insurance_14d'
        ? 'The 14-Day Asset Insurance period has started: complete the Security Changeover checklist now.'
        : 'The 72-Hour Inspection Window has started. Confirm receipt or open a dispute if anything is wrong.'),
  );
  if (order.category_kind === 'account') {
    await s.tx.query('INSERT INTO security_checklists (order_id, items) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      order.id, JSON.stringify(SECURITY_CHECKLIST.map((i) => ({ ...i, done: false, done_at: null }))),
    ]);
  }
  await enqueueWebhook(s.tx, order.seller_id, 'order.delivered', orderSummary(order));
  const { protection_ends_at } = await one<{ protection_ends_at: string }>(s.tx, 'SELECT protection_ends_at FROM orders WHERE id = $1', [order.id]);
  await enqueueEmail(s.tx, order.buyer_id, 'order_delivered', emailData(order, { protection_ends_at }));
  s.notifyUser(order.buyer_id, 'order.delivered', { orderId: order.id });
  s.notifyUser(order.seller_id, 'order.delivered', { orderId: order.id });
}

/** Seller-side manual delivery (accounts, boosting, anything not auto-delivered). */
export async function deliverManually(ctx: Ctx, orderId: string, sellerId: string, payload?: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.seller_id !== sellerId) throw forbidden('not_seller', 'Only the seller can deliver this order');
    if (order.status !== 'paid') throw conflict('invalid_state', `Cannot deliver an order that is ${order.status}`);
    if (order.escrow_frozen) throw new AppError(423, 'under_review', 'Order is under security review');
    if (payload) await storeManualDelivery(ctx, s.tx, order, payload);
    await deliver(ctx, s, order, sellerId, 'manual_delivery');
    return order;
  });
}

// ---------------------------------------------------------------------------
// Completion / release
// ---------------------------------------------------------------------------
async function releaseEscrow(ctx: Ctx, s: TxScope, order: Order & { title: string }, actorId: string | null, reason: string) {
  if (order.rail === 'fiat') {
    const held = await orderEscrowBalance(s.tx, order.id, order.currency);
    if (held !== order.amount_cents) throw new Error(`escrow imbalance for order ${order.id}: ${held}`);
    const reserveCut = Math.floor((order.commission_cents * RESERVE_SHARE_BPS) / 10_000);
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'escrow', order.currency), amountCents: -order.amount_cents },
        { account: await accountId(s.tx, 'treasury', order.currency), amountCents: order.commission_cents - reserveCut },
        { account: await accountId(s.tx, 'reserve', order.currency), amountCents: reserveCut },
        { account: await accountId(s.tx, 'seller_available', order.currency, order.seller_id), amountCents: order.seller_net_cents },
      ],
      'escrow_release',
      order.id,
    );
  }
  await transition(s.tx, order, 'completed', actorId, reason, ', completed_at = now()');
  const room = await roomOf(s.tx, order.id);
  await appendMessage(s, room.id, null, 'system', `Order completed. ${(order.seller_net_cents / 100).toFixed(2)} ${order.currency} released to the seller (commission ${(order.commission_bps / 100).toFixed(2)}%).`);
  await enqueueWebhook(s.tx, order.seller_id, 'order.completed', orderSummary(order));
  if (order.rail === 'fiat') await enqueueEmail(s.tx, order.seller_id, 'seller_paid', emailData(order));
  s.notifyUser(order.seller_id, 'order.completed', { orderId: order.id });
  s.notifyUser(order.buyer_id, 'order.completed', { orderId: order.id });
}

export async function confirmOrder(ctx: Ctx, orderId: string, buyerId: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId) throw forbidden('not_buyer', 'Only the buyer can confirm this order');
    if (order.rail === 'crypto') throw conflict('onchain', 'Crypto escrow is released on-chain from your wallet');
    if (order.status !== 'delivered') throw conflict('invalid_state', `Cannot confirm an order that is ${order.status}`);
    if (order.escrow_frozen) throw new AppError(423, 'under_review', 'Order is under security review');
    if (order.category_kind === 'account') {
      const cl = await maybeOne<{ completed_at: string | null }>(s.tx, 'SELECT completed_at FROM security_checklists WHERE order_id = $1', [orderId]);
      if (cl && !cl.completed_at) throw conflict('checklist_incomplete', 'Complete the Security Changeover checklist before confirming');
    }
    await releaseEscrow(ctx, s, order, buyerId, 'buyer_confirmed');
    return order;
  });
}

export async function updateChecklist(ctx: Ctx, orderId: string, buyerId: string, key: string, done: boolean) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId) throw forbidden('not_buyer', 'Only the buyer can update the checklist');
    const cl = await maybeOne<{ items: Array<{ key: string; label: string; done: boolean; done_at: string | null }> }>(
      s.tx, 'SELECT items FROM security_checklists WHERE order_id = $1 FOR UPDATE', [orderId],
    );
    if (!cl) throw notFound('Checklist');
    const item = cl.items.find((i) => i.key === key);
    if (!item) throw badRequest('unknown_item', 'Unknown checklist item');
    item.done = done;
    item.done_at = done ? new Date().toISOString() : null;
    const complete = cl.items.every((i) => i.done);
    const row = await one(
      s.tx,
      `UPDATE security_checklists SET items = $2, completed_at = CASE WHEN $3 THEN COALESCE(completed_at, now()) ELSE NULL END
        WHERE order_id = $1 RETURNING *`,
      [orderId, JSON.stringify(cl.items), complete],
    );
    if (complete) {
      const room = await roomOf(s.tx, orderId);
      await appendMessage(s, room.id, null, 'system', 'Buyer completed the Security Changeover checklist.');
    }
    return row;
  });
}

/** Worker: release escrow for orders whose inspection/insurance window lapsed without a dispute. */
export async function autoCompleteExpired(ctx: Ctx, limit = 100): Promise<number> {
  const due = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM orders WHERE status = 'delivered' AND rail = 'fiat' AND NOT escrow_frozen AND protection_ends_at <= now()
      ORDER BY protection_ends_at LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const { id } of due) {
    try {
      await withScope(ctx, async (s) => {
        const order = await lockOrder(s.tx, id);
        if (order.status !== 'delivered' || order.escrow_frozen || new Date(order.protection_ends_at!) > new Date()) return;
        await releaseEscrow(ctx, s, order, null, 'protection_window_elapsed');
        done++;
      });
    } catch (err) {
      ctx.log.error({ err, orderId: id }, 'auto-complete failed');
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Cancellation / disputes / refunds
// ---------------------------------------------------------------------------
export async function cancelOrder(ctx: Ctx, orderId: string, actorId: string | null, reason: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (actorId && order.buyer_id !== actorId) throw forbidden('not_buyer', 'Only the buyer can cancel');
    if (order.status !== 'awaiting_payment') throw conflict('invalid_state', 'Only unpaid orders can be cancelled');
    await releaseReservation(s.tx, order);
    await transition(s.tx, order, 'cancelled', actorId, reason);
    await enqueueWebhook(s.tx, order.seller_id, 'order.cancelled', orderSummary(order));
    return order;
  });
}

export async function cancelUnpaidExpired(ctx: Ctx, limit = 200): Promise<number> {
  const due = await many<{ id: string }>(
    ctx.db,
    // Crypto orders get an extra hour so a deposit mined right at expiry is still indexed before we give up.
    `SELECT id FROM orders WHERE status = 'awaiting_payment'
        AND payment_expires_at <= now() - CASE rail WHEN 'crypto' THEN interval '1 hour' ELSE interval '0' END
      LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const { id } of due) {
    try {
      await cancelOrder(ctx, id, null, 'payment_window_expired');
      n++;
    } catch (err) {
      if (!(err instanceof AppError)) ctx.log.error({ err, orderId: id }, 'expire failed');
    }
  }
  return n;
}

export async function openDispute(ctx: Ctx, orderId: string, userId: string, reason: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== userId && order.seller_id !== userId) throw forbidden('not_participant', 'Not a participant of this order');
    if (order.rail === 'crypto') throw conflict('onchain', 'Crypto escrow disputes are opened on-chain and decided by the validator panel');
    if (!['paid', 'delivered'].includes(order.status)) throw conflict('invalid_state', `Cannot dispute an order that is ${order.status}`);
    if (order.status === 'delivered' && new Date(order.protection_ends_at!) <= new Date()) {
      throw conflict('window_closed', 'The protection window for this order has ended');
    }
    await transition(s.tx, order, 'disputed', userId, 'dispute_opened', '', [], { reason });
    const dispute = await one(s.tx, 'INSERT INTO disputes (order_id, opened_by, reason) VALUES ($1, $2, $3) RETURNING *', [orderId, userId, reason]);
    const room = await roomOf(s.tx, orderId);
    await appendMessage(s, room.id, null, 'system', `Dispute opened: "${reason}". Escrow is frozen. An arbitration specialist will review this chat log — keep all evidence here.`);
    await enqueueWebhook(s.tx, order.seller_id, 'order.disputed', { ...orderSummary(order), reason });
    for (const uid of [order.buyer_id, order.seller_id]) await enqueueEmail(s.tx, uid, 'dispute_opened', emailData(order, { reason }));
    s.notifyUser(order.buyer_id, 'order.disputed', { orderId });
    s.notifyUser(order.seller_id, 'order.disputed', { orderId });
    return dispute;
  });
}

export async function resolveDispute(ctx: Ctx, disputeId: string, arbiterId: string, outcome: 'buyer' | 'seller', note: string) {
  return withScope(ctx, async (s) => {
    const dispute = await maybeOne(s.tx, 'SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
    if (!dispute) throw notFound('Dispute');
    if (dispute.status !== 'open') throw conflict('already_resolved', 'Dispute already resolved');
    const order = await lockOrder(s.tx, dispute.order_id);
    await s.tx.query(
      'UPDATE disputes SET status = $2, resolution_note = $3, resolved_by = $4, resolved_at = now() WHERE id = $1',
      [disputeId, outcome === 'buyer' ? 'resolved_buyer' : 'resolved_seller', note, arbiterId],
    );
    for (const uid of [order.buyer_id, order.seller_id]) {
      await enqueueEmail(s.tx, uid, 'dispute_resolved', emailData(order, { outcome, note }));
    }
    if (outcome === 'seller') {
      await releaseEscrow(ctx, s, order, arbiterId, 'dispute_resolved_seller');
    } else {
      await refundOrder(ctx, s, order, arbiterId, 'dispute_resolved_buyer');
    }
    return { disputeId, outcome };
  });
}

async function refundOrder(ctx: Ctx, s: TxScope, order: Order & { delivery_mode: string; title: string }, actorId: string | null, reason: string) {
  // The PSP refund is idempotent (keyed on the payment ref), so calling it inside the
  // transaction is safe: on rollback a retry re-uses the same refund.
  if (order.rail === 'fiat' && order.payment_ref) await ctx.payments.refund(order.payment_ref, order.amount_cents);
  await postRefund(s.tx, order);
  // Undelivered auto-delivery stock goes back on sale; delivered goods are burned.
  if (order.delivery_mode === 'auto') {
    await s.tx.query(
      `UPDATE inventory_items SET status = 'available', order_id = NULL, version = version + 1 WHERE order_id = $1 AND status = 'reserved'`,
      [order.id],
    );
    await s.tx.query(`UPDATE inventory_items SET status = 'revoked', version = version + 1 WHERE order_id = $1 AND status = 'delivered'`, [order.id]);
  }
  await transition(s.tx, order, 'refunded', actorId, reason);
  const room = await roomOf(s.tx, order.id);
  await appendMessage(s, room.id, null, 'system', `Order refunded to the buyer (${(order.amount_cents / 100).toFixed(2)} ${order.currency}).`);
  await enqueueWebhook(s.tx, order.seller_id, 'order.refunded', orderSummary(order));
  if (order.rail === 'fiat') await enqueueEmail(s.tx, order.buyer_id, 'order_refunded', emailData(order));
  s.notifyUser(order.buyer_id, 'order.refunded', { orderId: order.id });
  s.notifyUser(order.seller_id, 'order.refunded', { orderId: order.id });
}

// ---------------------------------------------------------------------------
// Crypto rail: state mirrors the on-chain escrow contract (driven by the indexer).
// ---------------------------------------------------------------------------
export type ChainEvent =
  | { type: 'EscrowCreated'; orderId: string; txHash: string; amount: string }
  | { type: 'DisputeOpened'; orderId: string; txHash: string }
  | { type: 'EscrowSettled'; orderId: string; txHash: string; outcome: 'released' | 'refunded' | 'split' };

export async function handleChainEvent(ctx: Ctx, ev: ChainEvent) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, ev.orderId);
    if (order.rail !== 'crypto') throw badRequest('not_crypto', 'Order is not a crypto escrow order');
    await s.tx.query('INSERT INTO order_events (order_id, from_status, to_status, reason, meta) VALUES ($1, $2, $2, $3, $4)', [
      order.id, order.status, `chain:${ev.type}`, ev,
    ]);
    switch (ev.type) {
      case 'EscrowCreated':
        if (order.status !== 'awaiting_payment') return order;
        if (BigInt(ev.amount) !== centsToTokenUnits(order.amount_cents)) throw badRequest('amount_mismatch', 'On-chain deposit does not match order amount');
        await onFunded(ctx, s, order);
        break;
      case 'DisputeOpened':
        if (['paid', 'delivered'].includes(order.status)) await transition(s.tx, order, 'disputed', null, 'onchain_dispute');
        break;
      case 'EscrowSettled':
        if (ev.outcome === 'refunded') {
          if (order.status !== 'refunded') await transition(s.tx, order, 'refunded', null, 'onchain_refund');
        } else if (order.status !== 'completed') {
          await transition(s.tx, order, 'completed', null, `onchain_${ev.outcome}`, ', completed_at = now()');
          await enqueueWebhook(s.tx, order.seller_id, 'order.completed', orderSummary(order));
        }
        break;
    }
    return order;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getOrderFor(q: Queryable, orderId: string, user: { id: string; role: string }) {
  const order = await maybeOne(
    q,
    `SELECT o.*, f.title AS offer_title, f.game, f.delivery_mode, c.kind AS category_kind,
            r.id AS room_id, b.display_name AS buyer_name, sl.display_name AS seller_name
       FROM orders o JOIN offers f ON f.id = o.offer_id JOIN categories c ON c.slug = f.category_slug
       JOIN chat_rooms r ON r.order_id = o.id JOIN users b ON b.id = o.buyer_id JOIN users sl ON sl.id = o.seller_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!order) throw notFound('Order');
  const staff = user.role === 'admin' || user.role === 'arbiter';
  if (!staff && order.buyer_id !== user.id && order.seller_id !== user.id) throw notFound('Order');
  const [checklist, dispute, events, review] = await Promise.all([
    maybeOne(q, 'SELECT items, completed_at FROM security_checklists WHERE order_id = $1', [orderId]),
    maybeOne(q, 'SELECT * FROM disputes WHERE order_id = $1', [orderId]),
    many(q, 'SELECT from_status, to_status, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY id', [orderId]),
    maybeOne(q, 'SELECT id, rating, comment, seller_reply, created_at FROM reviews WHERE order_id = $1', [orderId]),
  ]);
  return { ...order, checklist, dispute, events, review };
}

export async function listOrders(q: Queryable, userId: string, role: 'buyer' | 'seller', status?: string, limit = 50) {
  const col = role === 'buyer' ? 'buyer_id' : 'seller_id';
  return many(
    q,
    `SELECT o.*, f.title AS offer_title, f.game FROM orders o JOIN offers f ON f.id = o.offer_id
      WHERE o.${col} = $1 AND ($2::text IS NULL OR o.status = $2) ORDER BY o.created_at DESC LIMIT $3`,
    [userId, status ?? null, Math.min(limit, 200)],
  );
}

// ---------------------------------------------------------------------------
// Late manual deliveries
// ---------------------------------------------------------------------------
/** Buyer may cancel for a full refund once the promised delivery time has passed. */
export async function cancelLateOrder(ctx: Ctx, orderId: string, buyerId: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId) throw forbidden('not_buyer', 'Only the buyer can cancel');
    if (order.rail !== 'fiat') throw conflict('onchain', 'Crypto escrow is reclaimed on-chain after the delivery deadline');
    if (order.status !== 'paid') throw conflict('invalid_state', 'Only paid orders that were not delivered can be cancelled');
    const due = (order as any).delivery_due_at as string | null;
    if (!due || new Date(due) > new Date()) throw conflict('not_late', 'The seller still has time to deliver this order');
    await refundOrder(ctx, s, order, buyerId, 'buyer_cancelled_late_delivery');
    return { refunded: true };
  });
}

/**
 * Worker: when a manual order passes its promised delivery time, tell the buyer
 * they can cancel for a full refund and nudge the seller. If it's still
 * undelivered LATE_AUTO_REFUND_HOURS later, refund it automatically.
 */
export async function handleLateDeliveries(ctx: Ctx) {
  const late = await many<{ id: string; buyer_id: string; seller_id: string; title: string; delivery_due_at: string }>(
    ctx.db,
    `SELECT o.id, o.buyer_id, o.seller_id, f.title, o.delivery_due_at FROM orders o JOIN offers f ON f.id = o.offer_id
      WHERE o.status = 'paid' AND o.delivery_due_at < now() AND o.late_notified_at IS NULL LIMIT 200`,
  );
  for (const o of late) {
    await withScope(ctx, async (s) => {
      const res = await s.tx.query('UPDATE orders SET late_notified_at = now() WHERE id = $1 AND late_notified_at IS NULL', [o.id]);
      if (!res.rowCount) return;
      const data = { order_id: o.id, title: o.title, delivery_due_at: o.delivery_due_at, auto_refund_hours: ctx.cfg.LATE_AUTO_REFUND_HOURS };
      await enqueueEmail(s.tx, o.buyer_id, 'delivery_late', data);
      await enqueueEmail(s.tx, o.seller_id, 'delivery_overdue', data);
      const room = await roomOf(s.tx, o.id);
      await appendMessage(
        s, room.id, null, 'warning',
        `The promised delivery time has passed. The buyer can now cancel for a full refund; the order is refunded automatically if it isn't delivered within ${ctx.cfg.LATE_AUTO_REFUND_HOURS} hours.`,
      );
    });
  }

  const overdue = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM orders WHERE status = 'paid' AND rail = 'fiat' AND NOT escrow_frozen
        AND delivery_due_at < now() - make_interval(hours => $1) LIMIT 100`,
    [ctx.cfg.LATE_AUTO_REFUND_HOURS],
  );
  let refunded = 0;
  for (const { id } of overdue) {
    try {
      await withScope(ctx, async (s) => {
        const order = await lockOrder(s.tx, id);
        if (order.status !== 'paid') return;
        await refundOrder(ctx, s, order, null, 'late_delivery_auto_refund');
        refunded++;
      });
    } catch (err) {
      ctx.log.error({ err, orderId: id }, 'late auto-refund failed');
    }
  }
  return { notified: late.length, refunded };
}
