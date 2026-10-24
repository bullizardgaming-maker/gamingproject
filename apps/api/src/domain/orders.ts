import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, AppError } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { appendMessage, createOrderRoom } from './chat.js';
import { grossUp, refreshSellerRate, sellerTier, splitGross } from './commission.js';
import type { TxScope } from './events.js';
import { withScope } from './events.js';
import { applyRiskActions, assessOrder, recordSignals, subnetOf } from './fraud.js';
import { randomBytes } from 'node:crypto';
import { handoverFieldFor, handoverKey } from './attributeSets.js';
import { maybePayAffiliate } from './affiliates.js';
import { availableCount, markDelivered, releaseReservation, reserveInventory, reserveManualStock, storeManualDelivery } from './inventory.js';
import { accountId, orderEscrowBalance, post } from './ledger.js';
import { centsToTokenUnits, orderIdToBytes32 } from './web3.js';
import { taxForCommission } from './tax.js';
import { assertNotPaused, assertOrderWithinLimits } from './controls.js';
import { hasPermission } from './permissions.js';
import { assertWalletClear } from './aml.js';
import { sellerLeg, sellerRateFor } from './sellerfx.js';
import { enqueueWebhook } from './webhooks.js';
import { enqueueEmail } from './notifications.js';
import { assertSupported, getRate } from './fx.js';
import { quotePromo, reserveRedemption, setRedemptionStatus } from './promos.js';
import { availableCredit, maybeGrantReferral } from './referrals.js';
import { tosVersion } from './legal.js';
import { unitPriceFor, type PriceTier } from './offers.js';
import { effectivePrice, quoteSellerCode, type SaleFields } from './discounts.js';
import { listStatements, type DisputeCategory } from './disputes.js';
import { claimsForOrder } from './warranty.js';
import { progressFor } from './progress.js';
import { buyerReputation, ratingForOrder } from './buyerReputation.js';
import { creditPartialPayments, paymentsForOrder, refundForOrder } from './cryptoPayments.js';

export type OrderStatus = 'awaiting_payment' | 'paid' | 'delivered' | 'completed' | 'disputed' | 'refunded' | 'cancelled' | 'charged_back';

export interface Order {
  id: string;
  /** Human order ID, e.g. order#7F3AK2Q. */
  ref: string;
  /** The character/UID the buyer confirmed at checkout (games that use one). */
  character_name?: string | null;
  tos_version?: string;
  buyer_id: string;
  seller_id: string;
  offer_id: string;
  quantity: number;
  checkout_id?: string | null;
  unit_price_cents: number;
  amount_cents: number;
  currency: string;
  commission_bps: number;
  commission_cents: number;
  seller_net_cents: number;
  seller_tier: string;
  discount_cents: number;
  credit_cents: number;
  charged_cents: number;
  presentment_currency: string;
  presentment_amount_cents: number;
  fx_rate: number;
  seller_currency: string | null;
  commission_tax_cents: number | null;
  tax_country: string | null;
  tax_rate_bps: number | null;
  tax_treatment: string | null;
  seller_fx_rate: number | null;
  listing_currency: string | null;
  promo_code_id: string | null;
  rail: 'fiat' | 'crypto';
  status: OrderStatus;
  protection: 'inspection_72h' | 'insurance_14d' | 'until_confirmed';
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

/** Auto-release windows in ms; null = held until the buyer confirms or staff release (no deadline). */
export const PROTECTION_WINDOWS = {
  inspection_72h: 72 * 3600 * 1000,
  insurance_14d: 14 * 24 * 3600 * 1000,
  until_confirmed: null,
} as const;
/** Staff may release an unconfirmed order only this long after delivery. */
export const STAFF_RELEASE_AFTER_HOURS = 24;

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
/** Added when the listing showed a linked Steam/Riot account: ticked by the handover check, never by hand. */
export const HANDOVER_ITEM = { key: 'account_linked', label: 'Sign in to the account from Bullizard to confirm it is yours now', auto: true } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export async function lockOrder(tx: Tx, orderId: string): Promise<Order & { delivery_mode: string; category_kind: string; title: string }> {
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

export async function transition(
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

/** Human order ID: order# plus 7 unambiguous upper-case letters/digits (no 0/O, 1/I/L). */
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newOrderRef() {
  const bytes = randomBytes(7);
  let out = 'order#';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return out;
}

/**
 * The official order message (kind `system_order`): a server-only card the chat renders in a frame
 * users cannot imitate, posted when the order is created and on each status change. The body is
 * JSON: the order ref (linked), item, character and a status chip; never a money amount.
 */
export async function postOrderCard(s: TxScope, order: Pick<Order, 'id' | 'status' | 'quantity'> & { ref?: string | null; title?: string; character_name?: string | null }, status?: string) {
  const row = await one<{ ref: string; title: string; character_name: string | null; quantity: number; status: string }>(
    s.tx,
    'SELECT o.ref, f.title, o.character_name, o.quantity, o.status FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.id = $1',
    [order.id],
  );
  const room = await roomOf(s.tx, order.id);
  const chip = status ?? row.status;
  return appendMessage(s, room.id, null, 'system_order', JSON.stringify({ order_id: order.id, ref: row.ref, title: row.title, quantity: row.quantity, character_name: row.character_name, status: chip }));
}

export function roomOf(tx: Queryable, orderId: string) {
  return one<{ id: string }>(tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [orderId]);
}

export function emailData(o: Order & { title: string }, extra: Record<string, unknown> = {}) {
  return {
    order_id: o.id, order_ref: o.ref ?? null, title: o.title, quantity: o.quantity, amount_cents: o.amount_cents, currency: o.currency,
    seller_net_cents: o.seller_net_cents, protection: o.protection, character: o.character_name ?? null, tos_version: o.tos_version ?? null, ...extra,
  };
}

export function orderSummary(o: Order) {
  return {
    id: o.id,
    ref: o.ref,
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
  buyer: { id: string; email: string; kyc_tier: number; status: string; created_at?: string };
  offerId: string;
  quantity: number;
  rail: 'fiat' | 'crypto';
  idempotencyKey?: string;
  acceptTos: boolean;
  ip?: string;
  ipCountry?: string;
  device?: string;
  walletAddress?: string;
  promoCode?: string;
  useCredit?: boolean;
  /** Currency the buyer pays in. Defaults to the listing's currency. */
  currency?: string;
  /** A seller's discount code (seller-funded: lowers the order price itself). */
  sellerCode?: string;
  /** The in-game character name / UID the seller delivers to (games that deliver in-game). */
  characterName?: string;
  /** Part of a cart checkout (domain/cart.ts): the cart creates one payment for all its orders. */
  checkoutId?: string;
}

/** Smallest card charge the PSP accepts, in settlement minor units. Orders fully covered by credit/promo skip the card. */
export const MIN_CARD_CHARGE_CENTS = 50;

export interface PriceBreakdown {
  listingCurrency: string;
  listingTotalCents: number;
  /** Unit price in the listing currency after any sale and quantity tier. */
  listingUnitPriceCents: number;
  /** Seller-code discount in the listing currency, already taken off listingTotalCents. */
  sellerDiscountCents: number;
  sellerCodeId: string | null;
  /** What the buyer pays before promo/credit: the seller's price plus commission. */
  amountCents: number;
  /** The seller's price in the settlement currency: what they receive on release. */
  sellerAmountCents: number;
  commissionBps: number;
  unitPriceCents: number;
  discountCents: number;
  creditCents: number;
  chargedCents: number;
  promoId: string | null;
  presentmentCurrency: string;
  presentmentAmountCents: number;
  fxRate: number;
  settlementCurrency: string;
}

/**
 * Work out what an order costs and who funds which part. Runs inside the order
 * transaction (promo code row locked, buyer row locked when credit is used).
 */
export async function priceOrder(
  ctx: Ctx,
  tx: Tx,
  offer: { price_cents: number; currency: string; category_slug: string; seller_id: string; price_tiers?: PriceTier[] | null } & SaleFields,
  buyerId: string,
  input: Pick<CreateOrderInput, 'quantity' | 'rail' | 'promoCode' | 'useCredit' | 'currency' | 'sellerCode'>,
): Promise<PriceBreakdown> {
  const settlement = ctx.cfg.SETTLEMENT_CURRENCY;
  const listingRate = await getRate(ctx, tx, offer.currency);
  // Sale price (if one is running), then quantity tiers, then the seller's code: all seller-funded.
  const listingUnit = unitPriceFor({ price_cents: effectivePrice(offer), price_tiers: offer.price_tiers }, input.quantity);
  let listingTotal = listingUnit * input.quantity;
  let sellerDiscount = 0;
  let sellerCodeId: string | null = null;
  if (input.sellerCode) {
    const c = await quoteSellerCode(tx, input.sellerCode, offer.seller_id, buyerId, listingTotal);
    sellerDiscount = c.discountCents;
    sellerCodeId = c.codeId;
    listingTotal -= sellerDiscount;
  }
  // The seller's price in the settlement currency, then the commission grossed up on top of it.
  const sellerAmount = Math.round(listingTotal / listingRate);
  const rateBps = (await refreshSellerRate(tx, offer.seller_id)).rateBps;
  const amount = grossUp(sellerAmount, rateBps);
  if (amount < 1) throw badRequest('amount_too_small', 'Order total is below the minimum');

  if (input.rail === 'crypto' && (input.promoCode || input.useCredit)) {
    throw badRequest('not_for_crypto', 'Promo codes and credit apply to card payments only');
  }
  let discount = 0;
  let promoId: string | null = null;
  if (input.promoCode) {
    const q = await quotePromo(tx, input.promoCode, buyerId, amount, offer.category_slug);
    discount = q.discountCents;
    promoId = q.promoId;
  }
  let credit = 0;
  if (input.useCredit) {
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [buyerId]); // serialize credit spending
    credit = Math.min(await availableCredit(tx, buyerId, settlement), amount - discount);
  }
  let charged = amount - discount - credit;
  // A card charge below the PSP minimum isn't possible: use less credit (then less discount) instead. Crypto has no
  // such minimum, so a balance-funded order spends the balance to the last cent (CFO B10).
  if (ctx.cfg.CARD_PAYMENTS_ENABLED && charged > 0 && charged < MIN_CARD_CHARGE_CENTS) {
    const fromCredit = Math.min(credit, MIN_CARD_CHARGE_CENTS - charged);
    credit -= fromCredit;
    charged += fromCredit;
    if (charged < MIN_CARD_CHARGE_CENTS) {
      discount -= MIN_CARD_CHARGE_CENTS - charged;
      charged = MIN_CARD_CHARGE_CENTS;
    }
  }

  const presentment = (input.currency ?? offer.currency).toUpperCase();
  assertSupported(ctx, presentment);
  if (input.rail === 'crypto' && presentment !== settlement) throw badRequest('crypto_currency', `Crypto escrow is priced in ${settlement}`);
  const fxRate = presentment === settlement ? 1 : (await getRate(ctx, tx, presentment)) * (1 + ctx.cfg.FX_SPREAD_BPS / 10_000);
  return {
    listingCurrency: offer.currency,
    listingTotalCents: listingTotal,
    listingUnitPriceCents: listingUnit,
    sellerDiscountCents: sellerDiscount,
    sellerCodeId,
    amountCents: amount,
    sellerAmountCents: sellerAmount,
    commissionBps: rateBps,
    unitPriceCents: Math.round(amount / input.quantity),
    discountCents: discount,
    creditCents: credit,
    chargedCents: charged,
    promoId,
    presentmentCurrency: presentment,
    presentmentAmountCents: Math.round(charged * fxRate),
    fxRate: Math.round(fxRate * 1e8) / 1e8,
    settlementCurrency: settlement,
  };
}

export async function quoteOrder(ctx: Ctx, buyerId: string, input: Pick<CreateOrderInput, 'offerId' | 'quantity' | 'rail' | 'promoCode' | 'useCredit' | 'currency' | 'sellerCode'>) {
  return withTx(ctx.db, async (tx) => {
    const offer = await maybeOne(tx, `SELECT price_cents, currency, category_slug, seller_id, price_tiers, reserved_for, sale_price_cents, sale_starts_at, sale_ends_at FROM offers WHERE id = $1 AND status = 'active'`, [input.offerId]);
    if (!offer || (offer.reserved_for && offer.reserved_for !== buyerId)) throw notFound('Offer');
    return priceOrder(ctx, tx, offer, buyerId, input);
  });
}

export async function createOrder(ctx: Ctx, input: CreateOrderInput) {
  const { buyer } = input;
  if (buyer.status !== 'active') throw forbidden('suspended', 'Account suspended');
  if (buyer.kyc_tier < 1) throw forbidden('kyc_required', 'Verify your email and phone (Tier 1) before purchasing');
  if (!input.acceptTos) throw badRequest('tos_required', 'You must accept the Terms of Service');
  await assertNotPaused(ctx.db, 'orders'); // kill switch (Ops → Controls)
  if (input.rail === 'crypto' && !ctx.cfg.ONCHAIN_ESCROW_ENABLED) throw badRequest('rail_unavailable', 'On-chain escrow is not available; pay with crypto at checkout instead');
  if (input.rail === 'crypto' && !input.walletAddress) throw badRequest('wallet_required', 'walletAddress is required for crypto escrow');
  if (input.walletAddress) await assertWalletClear(ctx, buyer.id, input.walletAddress);

  if (input.idempotencyKey) {
    const existing = await maybeOne<Order>(ctx.db, 'SELECT * FROM orders WHERE buyer_id = $1 AND idempotency_key = $2', [buyer.id, input.idempotencyKey]);
    if (existing) return { order: existing, checkoutUrl: null, replayed: true };
  }

  // Cheap sold-out check before any locking or writes: during a flash sale most attempts
  // fail here instead of doing the full order transaction just to roll it back.
  // (Not a guarantee — reservation below is still the source of truth.)
  const hasStock = await maybeOne(
    ctx.db,
    `SELECT offer_available(f.id) >= $2 AS ok FROM offers f WHERE f.id = $1`,
    [input.offerId, input.quantity],
  );
  if (hasStock && !hasStock.ok) throw conflict('out_of_stock', 'Not enough stock for this order');

  const order = await withScope(ctx, async (s) => {
    const offer = await maybeOne(
      s.tx,
      `SELECT f.*, c.kind AS category_kind, c.risk_class, c.promo_rate_bps, c.name AS category_name, category_open(c.slug) AS category_open, u.status AS seller_status,
              (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now())) AS shop_paused, u.shop_pause_message
         FROM offers f JOIN categories c ON c.slug = f.category_slug JOIN users u ON u.id = f.seller_id
        WHERE f.id = $1`,
      [input.offerId],
    );
    if (!offer || offer.status !== 'active' || offer.seller_status !== 'active') throw notFound('Offer');
    // A category closed by the launch phase can't be bought from, even through a direct link to an older listing.
    if (offer.category_open === false) throw conflict('category_not_open', `${offer.category_name} opens in a later launch phase`);
    // Listings made from an accepted buyer request can only be bought by that buyer.
    if (offer.reserved_for && offer.reserved_for !== buyer.id) throw notFound('Offer');
    if (offer.shop_paused) throw conflict('shop_paused', offer.shop_pause_message || 'This seller is away and not taking orders right now');
    if (offer.seller_id === buyer.id) throw forbidden('own_offer', 'You cannot buy your own offer');
    if (offer.category_kind === 'account' && input.quantity !== 1) throw badRequest('invalid_quantity', 'Accounts are sold one at a time');
    if (input.quantity < Number(offer.min_qty ?? 1)) throw badRequest('below_minimum', `This listing sells at least ${offer.min_qty}${offer.unit_label ? ` ${offer.unit_label}` : ''} per order`);
    if (offer.min_buyer_reputation) {
      // The seller asked for an established buyer on this high-value listing.
      const rep = await buyerReputation(s.tx, buyer.id);
      if (rep.level !== 'good') {
        throw forbidden('buyer_reputation_required', rep.level === 'new'
          ? 'This seller only sells this listing to established buyers: complete three orders first'
          : 'This seller only sells this listing to buyers in good standing');
      }
    }

    const price = await priceOrder(ctx, s.tx, offer, buyer.id, input);
    const amount = price.amountCents;
    const rate = price.commissionBps;
    const split = splitGross(amount, price.sellerAmountCents);
    // Beta limits: order size for everyone, tighter for accounts in their first days (Ops → Controls).
    const created = buyer.created_at ?? (await one<{ created_at: string }>(s.tx, 'SELECT created_at FROM users WHERE id = $1', [buyer.id])).created_at;
    await assertOrderWithinLimits(s.tx, { id: buyer.id, created_at: created }, amount);
    const { rank } = await sellerTier(s.tx, offer.seller_id);
    const protection = offer.risk_class === 'high' ? 'insurance_14d' : 'until_confirmed';
    const termsVersion = await tosVersion(s.tx);
    // "High Risk - Secondary Market": account listings without verified Original Owner Proof.
    const sellerProtected = offer.category_kind !== 'account' || offer.owner_proof_status === 'verified';

    // Games that deliver in-game need the buyer's character name (or UID), confirmed at checkout.
    const handover = handoverFieldFor(offer.game, offer.category_slug);
    const characterName = input.characterName?.trim().slice(0, 60) || null;
    if (handover && !characterName) throw badRequest('character_name_required', `${handover.label} is required for ${offer.game}`);
    const sellerFx = await sellerRateFor(ctx, s.tx, offer.seller_id, input.rail);
    const order = await one<Order>(
      s.tx,
      `INSERT INTO orders (buyer_id, seller_id, offer_id, quantity, unit_price_cents, amount_cents, currency,
                           commission_bps, commission_cents, seller_net_cents, seller_tier, rail, status, protection,
                           seller_protected, payment_expires_at, tos_version, tos_accepted_at, buyer_ip, buyer_ip_country,
                           buyer_device, idempotency_key, discount_cents, credit_cents, charged_cents, presentment_currency,
                           presentment_amount_cents, fx_rate, fx_locked_at, listing_currency, listing_unit_price_cents, promo_code_id,
                           seller_currency, seller_fx_rate, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'awaiting_payment', $13, $14,
               now() + make_interval(mins => $15), $16, now(), $17, $18, $19, $20,
               $21, $22, $23, $24, $25, $26, now(), $27, $28, $29, $30, $31, $32)
       RETURNING *`,
      [
        buyer.id, offer.seller_id, offer.id, input.quantity, price.unitPriceCents, amount, price.settlementCurrency,
        rate, split.commissionCents, split.sellerNetCents, rank.name, input.rail, protection, sellerProtected,
        ctx.cfg.ORDER_PAYMENT_TTL_MINUTES, termsVersion, input.ip ?? null, input.ipCountry ?? null,
        input.device ?? null, input.idempotencyKey ?? null,
        price.discountCents, price.creditCents, price.chargedCents, price.presentmentCurrency,
        price.presentmentAmountCents, price.fxRate, price.listingCurrency, price.listingUnitPriceCents, price.promoId,
        sellerFx.currency, sellerFx.rate, newOrderRef(),
      ],
    );
    if (price.promoId) await reserveRedemption(s.tx, price.promoId, order.id, buyer.id, price.discountCents);
    if (handover && characterName) {
      await s.tx.query('UPDATE orders SET character_name = $2 WHERE id = $1', [order.id, characterName]);
      Object.assign(order, { character_name: characterName });
      // Remembered for next time: one tap to confirm instead of typing it again.
      await s.tx.query(`UPDATE users SET handover_names = handover_names || jsonb_build_object($2::text, $3::text) WHERE id = $1`, [buyer.id, handoverKey(offer.game), characterName]);
    }
    if (input.checkoutId) {
      await s.tx.query('UPDATE orders SET checkout_id = $2 WHERE id = $1', [order.id, input.checkoutId]);
      order.checkout_id = input.checkoutId;
    }
    if (price.sellerCodeId) {
      await s.tx.query('UPDATE orders SET seller_code_id = $2, seller_discount_cents = $3 WHERE id = $1', [order.id, price.sellerCodeId, price.sellerDiscountCents]);
      Object.assign(order, { seller_code_id: price.sellerCodeId, seller_discount_cents: price.sellerDiscountCents });
    }

    if (offer.is_bundle) {
      // A bundle reserves its parts' items against this order; delivery and release work by order.
      const parts = await many<{ component_offer_id: string; quantity: number }>(s.tx, 'SELECT component_offer_id, quantity FROM bundle_items WHERE bundle_offer_id = $1', [offer.id]);
      for (const p of parts) await reserveInventory(s.tx, p.component_offer_id, order.id, input.quantity * p.quantity);
    } else if (offer.delivery_mode === 'auto') await reserveInventory(s.tx, offer.id, order.id, input.quantity);
    else await reserveManualStock(s.tx, offer.id, input.quantity);

    const snapshot = {
      offer: {
        id: offer.id, title: offer.title, description: offer.description, game: offer.game, category: offer.category_name,
        price_cents: offer.price_cents, price_tiers: offer.price_tiers, currency: offer.currency, delivery_mode: offer.delivery_mode,
        owner_proof_status: offer.owner_proof_status, version: offer.version,
      },
      terms: { protection, tos_version: termsVersion, commission_bps: rate },
      price: { ...price, promoId: undefined },
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
    await postOrderCard(s, order, 'awaiting_payment');
    await appendMessage(
      s, room.id, null, 'system',
      `Order created for "${offer.title}" x${input.quantity}. All communication for this order must stay in this chat — ` +
        `it is the evidence used for arbitration. ` +
        (protection === 'insurance_14d' ? 'Funds are held in escrow under the 14-Day Asset Insurance.' : protection === 'until_confirmed' ? 'Funds are held in escrow until the buyer confirms delivery.' : 'Funds are held in escrow under the 72-Hour Inspection Window.') +
        (sellerProtected ? '' : ' Notice: this listing is HIGH RISK - SECONDARY MARKET (no verified Original Owner Proof).'),
      [],
      undefined,
      { code: 'order_created', params: { title: offer.title, quantity: input.quantity, protection, seller_protected: sellerProtected } },
    );

    await recordSignals(s.tx, buyer.id, { device: input.device, ip_subnet: subnetOf(input.ip), wallet: input.walletAddress?.toLowerCase() });
    return order;
  });

  if (input.checkoutId) return { order, checkoutUrl: null, replayed: false }; // the cart creates the payment

  if (input.rail === 'crypto') {
    // payment_ref holds the bytes32 order id used on-chain, so the indexer can map events back.
    const chainRef = orderIdToBytes32(order.id);
    await ctx.db.query(`UPDATE orders SET payment_provider = 'escrow_contract', payment_ref = $2 WHERE id = $1`, [order.id, chainRef]);
    return { order: { ...order, payment_provider: 'escrow_contract', payment_ref: chainRef }, checkoutUrl: null, replayed: false };
  }

  if (order.charged_cents === 0) {
    // Fully covered by promo and/or store credit: no card payment needed.
    await fundWithoutCard(ctx, order.id);
    return { order: await one<Order>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [order.id]), checkoutUrl: null, replayed: false };
  }

  try {
    const offerTitle = (await one<{ title: string }>(ctx.db, 'SELECT title FROM offers WHERE id = $1', [order.offer_id])).title;
    const session = await ctx.payments.createCheckout({
      orderId: order.id,
      amountCents: order.presentment_amount_cents,
      currency: order.presentment_currency,
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
    if (Number(order.presentment_amount_cents) !== ev.amountCents || order.presentment_currency !== ev.currency) {
      throw badRequest('amount_mismatch', 'Captured amount does not match order');
    }
    // What the PSP credited in the settlement currency (differs from charged_cents only by FX conversion).
    const settled = ev.details.settledAmountCents ?? order.charged_cents;
    if (order.status !== 'awaiting_payment') {
      if (order.status === 'cancelled' && !(await hasLedgerTxn(s.tx, order.id, 'payment_captured'))) {
        // Paid after the reservation expired: record the money and refund it.
        await postCapture(s.tx, order, 0, settled);
        refundNeeded = order;
      }
      return order; // idempotent replay
    }

    await postCapture(s.tx, order, ev.details.feeCents, settled, ev.details.overpaidCents ?? 0);
    if (ev.details.overpaidCents) {
      const room = await roomOf(s.tx, order.id);
      await appendMessage(s, room.id, null, 'system', `The payment arrived ${(ev.details.overpaidCents / 100).toFixed(2)} ${order.currency} above the order total. The extra is in the buyer's balance.`, [], undefined, { code: 'overpaid', params: { amount_cents: ev.details.overpaidCents, currency: order.currency } });
    }
    await postFunding(s.tx, order);
    await setRedemptionStatus(s.tx, order.id, 'redeemed');
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
    // Keyed by order: orders in one cart checkout share the payment reference.
    const r = o.payment_provider === 'nowpayments' || !ctx.cfg.CARD_REFUNDS_ENABLED ? { settledAmountCents: undefined } : await ctx.payments.refund(o.payment_ref!, o.presentment_amount_cents, o.presentment_currency, `refund_order_${o.id}`);
    await withScope(ctx, async (s) => {
      const cur = await lockOrder(s.tx, o.id);
      await postRefund(s.tx, cur, r.settledAmountCents, 'late_payment');
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

async function postCapture(tx: Tx, order: Order, feeCents = 0, settledCents = order.charged_cents, overpaidCents = 0) {
  const cur = order.currency;
  if (order.charged_cents > 0) {
    // settledCents is gross (before the PSP fee). An overpayment beyond the tolerance is the buyer's credit (CFO B6);
    // what is left (conversion differences, underpayment within the tolerance) is FX gain/loss.
    const fx = settledCents - order.charged_cents - overpaidCents;
    await post(
      tx,
      [
        { account: await accountId(tx, 'gateway_clearing', cur), amountCents: -settledCents },
        { account: await accountId(tx, 'escrow', cur), amountCents: order.charged_cents },
        ...(overpaidCents > 0 ? [{ account: await accountId(tx, 'user_credit', cur, order.buyer_id), amountCents: overpaidCents }] : []),
        ...(fx !== 0 ? [{ account: await accountId(tx, 'fx_pnl', cur), amountCents: fx }] : []),
      ],
      'payment_captured',
      order.id,
    );
    if (overpaidCents > 0) {
      await tx.query(`INSERT INTO order_events (order_id, from_status, to_status, reason) VALUES ($1, 'awaiting_payment', 'awaiting_payment', 'overpayment_credited')`, [order.id]);
    }
  }
  // The PSP keeps its processing fee; the platform pays it out of revenue, never out of escrow.
  if (feeCents > 0) {
    await post(
      tx,
      [
        { account: await accountId(tx, 'gateway_clearing', cur), amountCents: feeCents },
        { account: await accountId(tx, 'treasury', cur), amountCents: -feeCents },
      ],
      'psp_fee',
      order.id,
    );
  }
}

/** Top escrow up to the full order value from the promo budget (treasury) and the buyer's store credit. */
async function postFunding(tx: Tx, order: Order) {
  const cur = order.currency;
  if (order.discount_cents > 0) {
    await post(
      tx,
      [
        { account: await accountId(tx, 'treasury', cur), amountCents: -order.discount_cents },
        { account: await accountId(tx, 'escrow', cur), amountCents: order.discount_cents },
      ],
      'promo_funding',
      order.id,
    );
  }
  if (order.credit_cents > 0) {
    await post(
      tx,
      [
        { account: await accountId(tx, 'user_credit', cur, order.buyer_id), amountCents: -order.credit_cents },
        { account: await accountId(tx, 'escrow', cur), amountCents: order.credit_cents },
      ],
      'credit_applied',
      order.id,
    );
  }
}

/**
 * Return everything held in escrow to where it came from: the card part to the
 * PSP (at what the PSP actually debits us, the rest is FX gain/loss), the promo
 * part to treasury, the credit part back to the buyer's credit.
 */
/**
 * Books a refund of what escrow holds. Card money goes back out through the gateway; a crypto
 * refund is sent by hand later, so until then the amount sits in `refunds_payable` and a queue
 * item asks the buyer for an address (cryptoPayments.ts).
 */
async function postRefund(tx: Tx, order: Order, refundSettledCents?: number, reason = 'refund') {
  const cur = order.currency;
  const held = await orderEscrowBalance(tx, order.id, cur);
  if (held <= 0) return;
  const card = Math.min(held, order.charged_cents);
  const promo = Math.min(held - card, order.discount_cents);
  const credit = held - card - promo;
  // Crypto (NOWPayments) and balance-funded orders are refunded to the buyer's Bullizard balance
  // (CEO, Oct 24: refunds go to balance; withdrawing them costs the normal fee). Only a card
  // gateway refund goes back out through the PSP.
  const toBalance = refundSettledCents == null; // no gateway refund was made: the money is balance (crypto, credit, or cards off)
  const settledBack = toBalance ? card : refundSettledCents;
  await post(
    tx,
    [
      { account: await accountId(tx, 'escrow', cur), amountCents: -held },
      { account: await accountId(tx, toBalance ? 'user_credit' : 'gateway_clearing', cur, toBalance ? order.buyer_id : null), amountCents: settledBack },
      { account: await accountId(tx, 'fx_pnl', cur), amountCents: card - settledBack },
      { account: await accountId(tx, 'treasury', cur), amountCents: promo },
      { account: await accountId(tx, 'user_credit', cur, order.buyer_id), amountCents: credit },
    ],
    'refund',
    order.id,
  );
  void reason;
}

/** Orders fully covered by promo/credit are funded straight from those sources. */
export async function fundWithoutCard(ctx: Ctx, orderId: string) {
  await withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.status !== 'awaiting_payment') return;
    await s.tx.query(`UPDATE orders SET payment_provider = 'none', payment_ref = $2 WHERE id = $1`, [orderId, `nocard_${orderId}`]);
    await postFunding(s.tx, order);
    await setRedemptionStatus(s.tx, order.id, 'redeemed');
    await onFunded(ctx, s, order);
  });
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
  await appendMessage(s, room.id, null, 'system', 'Payment received. It stays in escrow until the buyer confirms delivery.', [], undefined, { code: 'paid', params: { character: order.character_name ?? null } });
  await postOrderCard(s, order, 'paid');

  const risk = await assessOrder(ctx, s.tx, order.id);
  const { action } = await applyRiskActions(ctx, s, order, risk);

  await enqueueWebhook(s.tx, order.seller_id, 'order.created', orderSummary(order));
  await enqueueEmail(s.tx, order.buyer_id, 'order_paid', emailData(order));
  await enqueueEmail(s.tx, order.seller_id, 'seller_new_order', emailData(order, { delivery_mode: order.delivery_mode }));
  s.notifyUser(order.seller_id, 'order.created', { orderId: order.id });
  s.notifyUser(order.buyer_id, 'order.paid', { orderId: order.id });

  if (order.delivery_mode === 'auto') {
    if (action !== 'none') {
      await appendMessage(s, room.id, null, 'system', 'This order is under a routine security review. Delivery will proceed once the review completes.', [], undefined, { code: 'security_review' });
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
    ', delivered_at = now(), protection_ends_at = CASE WHEN $4::float IS NULL THEN NULL ELSE now() + make_interval(secs => $4) END', [window === null ? null : window / 1000],
  );
  const room = await roomOf(s.tx, order.id);
  await appendMessage(
    s, room.id, null, 'delivery',
    `Delivered${count ? ` (${count} item${count === 1 ? '' : 's'})` : ''}. The buyer can view the goods in the order dashboard. ` +
      (order.protection === 'insurance_14d'
        ? 'The 14-Day Asset Insurance period has started: complete the Security Changeover checklist now.'
        : order.protection === 'until_confirmed'
          ? 'The payment stays in escrow until the buyer confirms. Buyer: check your order and confirm, or open a dispute if anything is wrong.'
          : 'The 72-Hour Inspection Window has started. Confirm receipt or open a dispute if anything is wrong.'),
    [],
    undefined,
    { code: 'delivered', params: { count: count ?? null, protection: order.protection } },
  );
  await postOrderCard(s, order, 'delivered');
  if (order.category_kind === 'account') {
    const linked = await maybeOne<{ provider: string }>(
      s.tx, 'SELECT la.provider FROM offers f JOIN linked_accounts la ON la.id = f.linked_account_id AND la.unlinked_at IS NULL WHERE f.id = $1', [order.offer_id],
    );
    const items = [...SECURITY_CHECKLIST, ...(linked ? [HANDOVER_ITEM] : [])].map((i) => ({ ...i, done: false, done_at: null }));
    await s.tx.query('INSERT INTO security_checklists (order_id, items, handover_platform) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      order.id, JSON.stringify(items), linked?.provider ?? null,
    ]);
  }
  await enqueueWebhook(s.tx, order.seller_id, 'order.delivered', orderSummary(order));
  const { protection_ends_at } = await one<{ protection_ends_at: string }>(s.tx, 'SELECT protection_ends_at FROM orders WHERE id = $1', [order.id]);
  await enqueueEmail(s.tx, order.buyer_id, 'order_delivered', emailData(order, { protection_ends_at }));
  s.notifyUser(order.buyer_id, 'order.delivered', { orderId: order.id });
  s.notifyUser(order.seller_id, 'order.delivered', { orderId: order.id });
}

/** Seller-side manual delivery (accounts, boosting, anything not auto-delivered). */
/** Proof of delivery is required for goods handed over in-game (currency, items, top-ups, boosting). */
export const PROOF_REQUIRED_KINDS = new Set(['currency', 'item', 'topup', 'boosting']);

export async function deliverManually(ctx: Ctx, orderId: string, sellerId: string, payload?: string, proofAttachmentId?: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.seller_id !== sellerId) throw forbidden('not_seller', 'Only the seller can deliver this order');
    if (order.status !== 'paid') throw conflict('invalid_state', `Cannot deliver an order that is ${order.status}`);
    if (order.escrow_frozen) throw new AppError(423, 'under_review', 'Order is under security review');
    if (ctx.cfg.DELIVERY_PROOF_REQUIRED && PROOF_REQUIRED_KINDS.has(order.category_kind) && !proofAttachmentId) {
      throw badRequest('proof_required', 'Attach a photo or video of the delivery (trade window, mail or confirmation) before marking it delivered');
    }
    if (proofAttachmentId) {
      // The proof is a chat attachment on this order's room, uploaded by the seller and scanned clean.
      const room = await roomOf(s.tx, order.id);
      const att = await maybeOne(s.tx, `SELECT id FROM chat_attachments WHERE id = $1 AND room_id = $2 AND uploader_id = $3 AND status = 'clean'`, [proofAttachmentId, room.id, sellerId]);
      if (!att) throw badRequest('invalid_proof', 'Upload the proof to this order’s chat first, then mark it delivered');
      await s.tx.query('UPDATE orders SET delivery_proof_id = $2 WHERE id = $1', [order.id, proofAttachmentId]);
      Object.assign(order, { delivery_proof_id: proofAttachmentId });
    }
    if (payload) await storeManualDelivery(ctx, s.tx, order, payload);
    await deliver(ctx, s, order, sellerId, 'manual_delivery');
    return order;
  });
}

// ---------------------------------------------------------------------------
// Completion / release
// ---------------------------------------------------------------------------
/** The commission is earned now, so its VAT/GST is fixed now and recorded on the order (for invoices and returns). */
async function lockCommissionTax(ctx: Ctx, tx: Tx, order: Order) {
  const t = await taxForCommission(ctx, tx, order.seller_id, order.commission_cents);
  await tx.query(
    'UPDATE orders SET tax_country = $2, tax_rate_bps = $3, tax_treatment = $4, commission_tax_cents = $5 WHERE id = $1',
    [order.id, t.country, t.rateBps, t.treatment, t.taxCents],
  );
  return t.taxCents;
}

async function releaseEscrow(ctx: Ctx, s: TxScope, order: Order & { title: string }, actorId: string | null, reason: string) {
  // One release per buyer at a time (lock taken before any ledger row): the referral "first order" rule and the
  // seller/ledger locks that follow always come in the same order, so two orders completing together can't deadlock.
  await s.tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [order.buyer_id]);
  // Crypto orders pay the commission on-chain; its tax is recorded the same way for invoices and returns.
  if (order.rail !== 'fiat') await lockCommissionTax(ctx, s.tx, order);
  if (order.rail === 'fiat') {
    const held = await orderEscrowBalance(s.tx, order.id, order.currency);
    if (held !== order.amount_cents) throw new Error(`escrow imbalance for order ${order.id}: ${held}`);
    const reserveCut = Math.floor((order.commission_cents * RESERVE_SHARE_BPS) / 10_000);
    const tax = await lockCommissionTax(ctx, s.tx, order);
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'escrow', order.currency), amountCents: -order.amount_cents },
        { account: await accountId(s.tx, 'treasury', order.currency), amountCents: order.commission_cents - reserveCut - tax },
        { account: await accountId(s.tx, 'reserve', order.currency), amountCents: reserveCut },
        { account: await accountId(s.tx, 'tax_payable', order.currency), amountCents: tax },
        await sellerLeg(s.tx, order, order.seller_net_cents, 'escrow_release'),
      ],
      'escrow_release',
      order.id,
    );
  }
  await transition(s.tx, order, 'completed', actorId, reason, ', completed_at = now()');
  const room = await roomOf(s.tx, order.id);
  await appendMessage(s, room.id, null, 'system', 'Order completed. Funds released to the seller.', [], undefined, { code: reason === 'buyer_confirmed_early' ? 'confirmed_early' : reason === 'dispute_resolved_seller' ? 'dispute_seller' : 'completed', params: { reason } });
  await postOrderCard(s, order, 'completed');
  await enqueueWebhook(s.tx, order.seller_id, 'order.completed', orderSummary(order));
  if (order.rail === 'fiat') {
    await enqueueEmail(s.tx, order.seller_id, 'seller_paid', emailData(order));
    await enqueueEmail(s.tx, order.buyer_id, 'order_completed', emailData(order));
    await maybeGrantReferral(ctx, s, order);
    await maybePayAffiliate(ctx, s, order);
  }
  s.notifyUser(order.seller_id, 'order.completed', { orderId: order.id });
  s.notifyUser(order.buyer_id, 'order.completed', { orderId: order.id });
}

/**
 * Buyer confirmation. Account orders need the full Security Changeover checklist, except when the
 * handover check has passed (the buyer signed in to the account from Bullizard): then the buyer may
 * release early by sending `handoverConsent: true`, which ends the 14-day insurance now.
 */
export async function confirmOrder(ctx: Ctx, orderId: string, buyerId: string, opts: { handoverConsent?: boolean } = {}) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId) throw forbidden('not_buyer', 'Only the buyer can confirm this order');
    if (order.rail === 'crypto') throw conflict('onchain', 'Crypto escrow is released on-chain from your wallet');
    // The buyer can also confirm before the seller marks the order delivered (they already have the goods).
    if (order.status !== 'delivered' && order.status !== 'paid') throw conflict('invalid_state', `Cannot confirm an order that is ${order.status}`);
    if (order.escrow_frozen) throw new AppError(423, 'under_review', 'Order is under security review');
    let reason = order.status === 'paid' ? 'buyer_confirmed_early' : 'buyer_confirmed';
    if (order.status === 'paid') await s.tx.query('UPDATE orders SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL', [orderId]);
    if (order.category_kind === 'account') {
      const cl = await maybeOne<{ completed_at: string | null; handover_at: string | null }>(s.tx, 'SELECT completed_at, handover_at FROM security_checklists WHERE order_id = $1', [orderId]);
      if (cl && !cl.completed_at) {
        if (!cl.handover_at) throw conflict('checklist_incomplete', 'Complete the Security Changeover checklist before confirming');
        if (!opts.handoverConsent) throw conflict('handover_consent_required', 'The checklist is not finished. Confirm that you want to release the payment now and end the insurance period early');
        reason = 'buyer_confirmed_after_handover';
      }
    }
    await releaseEscrow(ctx, s, order, buyerId, reason);
    return order;
  });
}

/**
 * Handover check: the buyer of a delivered account order signed in to the platform account the
 * listing showed. Called from the sign-in callback, which has already verified the account.
 * Ticks the `account_linked` step, records the time and tells both sides in the order chat.
 */
export async function recordHandover(ctx: Ctx, orderId: string, buyerId: string, provider: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId || order.status !== 'delivered') return null;
    const cl = await maybeOne<{ items: Array<{ key: string; done: boolean; done_at: string | null }>; handover_at: string | null }>(
      s.tx, 'SELECT items, handover_at FROM security_checklists WHERE order_id = $1 FOR UPDATE', [orderId],
    );
    if (!cl || cl.handover_at) return cl;
    const item = cl.items.find((i) => i.key === HANDOVER_ITEM.key);
    if (item) {
      item.done = true;
      item.done_at = new Date().toISOString();
    }
    const complete = cl.items.every((i) => i.done);
    const row = await one(
      s.tx,
      `UPDATE security_checklists SET items = $2, handover_at = now(), handover_platform = $3,
          completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) ELSE completed_at END
        WHERE order_id = $1 RETURNING *`,
      [orderId, JSON.stringify(cl.items), provider, complete],
    );
    const room = await roomOf(s.tx, orderId);
    await appendMessage(s, room.id, null, 'system', `Handover confirmed: the buyer signed in to the ${provider === 'steam' ? 'Steam' : 'Riot'} account from Bullizard.${complete ? ' The Security Changeover checklist is complete.' : ''}`, [], undefined, { code: 'handover_confirmed', params: { provider, complete } });
    s.notifyUser(order.seller_id, 'order.handover', { orderId });
    s.notifyUser(order.buyer_id, 'order.handover', { orderId });
    return row;
  });
}

/**
 * Staff release of an order the buyer never confirmed: allowed from STAFF_RELEASE_AFTER_HOURS after
 * delivery, never while a dispute is open or the escrow is frozen. There is no deadline on the
 * buyer's side; this is how an abandoned order eventually pays the seller.
 */
export async function releaseByStaff(ctx: Ctx, orderId: string, staffId: string, note: string) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.status !== 'delivered') throw conflict('invalid_state', `Cannot release an order that is ${order.status}`);
    if (order.rail === 'crypto') throw conflict('onchain', 'On-chain escrow is released from the buyer’s wallet');
    if (order.escrow_frozen) throw new AppError(423, 'under_review', 'Order is under security review');
    const deliveredAt = new Date(order.delivered_at!).getTime();
    const earliest = deliveredAt + STAFF_RELEASE_AFTER_HOURS * 3_600_000;
    if (Date.now() < earliest) {
      throw conflict('too_early', `Staff can release this order from ${new Date(earliest).toISOString()}, ${STAFF_RELEASE_AFTER_HOURS} hours after delivery`);
    }
    if (order.category_kind === 'account') {
      // Accounts: staff release only once the 14-day window has ended (no auto-release), or when the buyer finished the changeover.
      const cl = await maybeOne<{ completed_at: string | null }>(s.tx, 'SELECT completed_at FROM security_checklists WHERE order_id = $1', [orderId]);
      const windowOver = !!order.protection_ends_at && new Date(order.protection_ends_at) <= new Date();
      if (cl && !cl.completed_at && !windowOver) throw conflict('checklist_incomplete', `The buyer has not finished the Security Changeover checklist; staff can release from ${order.protection_ends_at}`);
    }
    await s.tx.query('UPDATE orders SET released_by = $2, release_note = $3 WHERE id = $1', [orderId, staffId, note]);
    await releaseEscrow(ctx, s, order, staffId, 'staff_released');
    const room = await roomOf(s.tx, orderId);
    await appendMessage(s, room.id, null, 'system', `Support released the payment to the seller after reviewing the delivery: ${note}`, [], undefined, { code: 'staff_released', params: { note } });
    return order;
  });
}

/** Orders delivered long enough ago for staff to release, oldest first (the support queue). */
/** Orders above this amount are flagged for the Support Lead in every staff list (playbook: $200). */
export const LEAD_REVIEW_ABOVE_CENTS = 200_00;

export async function unconfirmedDeliveries(q: Queryable, limit = 100) {
  return many(
    q,
    `SELECT o.id, o.buyer_id, o.seller_id, o.amount_cents, o.currency, o.delivered_at, o.protection, o.protection_ends_at, f.title, f.game,
            (o.amount_cents > $3) AS lead_review, b.display_name AS buyer_name, sl.display_name AS seller_name,
            (SELECT count(*)::int FROM support_tickets t WHERE t.order_id = o.id AND t.status <> 'resolved') AS open_tickets,
            (SELECT max(m.created_at) FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id WHERE r.order_id = o.id AND m.sender_id = o.buyer_id) AS buyer_last_message_at
       FROM orders o JOIN offers f ON f.id = o.offer_id JOIN users b ON b.id = o.buyer_id JOIN users sl ON sl.id = o.seller_id
      WHERE o.status = 'delivered' AND o.rail = 'fiat' AND NOT o.escrow_frozen AND o.delivered_at <= now() - make_interval(hours => $1)
      ORDER BY o.delivered_at LIMIT $2`,
    [STAFF_RELEASE_AFTER_HOURS, limit, LEAD_REVIEW_ABOVE_CENTS],
  );
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
    if ((item as any).auto) throw badRequest('auto_item', 'This step is ticked by signing in to the account from Bullizard');
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
      await appendMessage(s, room.id, null, 'system', 'Buyer completed the Security Changeover checklist.', [], undefined, { code: 'checklist_completed' });
    }
    return row;
  });
}

/** Worker: release escrow for orders whose inspection/insurance window lapsed without a dispute. */
/**
 * No order is ever released without a person (Round 20). When an account order's 14-day window ends, it
 * becomes eligible for staff release (Ops → Releases) and both sides are told once; nothing moves by itself.
 */
export async function autoCompleteExpired(ctx: Ctx, limit = 100): Promise<number> {
  const due = await many<{ id: string }>(
    ctx.db,
    `SELECT o.id FROM orders o WHERE o.status = 'delivered' AND o.rail = 'fiat' AND o.protection_ends_at IS NOT NULL AND o.protection_ends_at <= now()
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.reason = 'protection_window_elapsed')
      ORDER BY o.protection_ends_at LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const { id } of due) {
    try {
      await withScope(ctx, async (s) => {
        const order = await lockOrder(s.tx, id);
        if (order.status !== 'delivered' || !order.protection_ends_at || new Date(order.protection_ends_at) > new Date()) return;
        await s.tx.query(`INSERT INTO order_events (order_id, from_status, to_status, reason) VALUES ($1, 'delivered', 'delivered', 'protection_window_elapsed')`, [id]);
        const room = await roomOf(s.tx, id);
        await appendMessage(s, room.id, null, 'system', 'The protection window has ended. Staff can now review the delivery and release the payment; the buyer can still confirm or open a dispute.', [], undefined, { code: 'protection_ended' });
        done++;
      });
    } catch (err) {
      ctx.log.error({ err, orderId: id }, 'protection-window check failed');
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
    await setRedemptionStatus(s.tx, order.id, 'released');
    await transition(s.tx, order, 'cancelled', actorId, reason);
    // A crypto underpayment that never got its top-up stays with the buyer as credit (never refunded).
    await creditPartialPayments(ctx, s, order);
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

export async function openDispute(ctx: Ctx, orderId: string, userId: string, reason: string, category: DisputeCategory = 'other') {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== userId && order.seller_id !== userId) throw forbidden('not_participant', 'Not a participant of this order');
    if (order.rail === 'crypto') throw conflict('onchain', 'Crypto escrow disputes are opened on-chain and decided by the validator panel');
    if (!['paid', 'delivered'].includes(order.status)) throw conflict('invalid_state', `Cannot dispute an order that is ${order.status}`);
    // Standard orders have no deadline: disputable until release. Account windows close on time.
    if (order.status === 'delivered' && order.protection_ends_at && new Date(order.protection_ends_at) <= new Date()) {
      throw conflict('window_closed', 'The protection window for this order has ended');
    }
    await transition(s.tx, order, 'disputed', userId, 'dispute_opened', '', [], { reason });
    await postOrderCard(s, order, 'disputed');
    const dispute = await one(s.tx, 'INSERT INTO disputes (order_id, opened_by, reason, category) VALUES ($1, $2, $3, $4) RETURNING *', [orderId, userId, reason, category]);
    // The opening reason is also the opener's first statement.
    await s.tx.query('INSERT INTO dispute_statements (dispute_id, user_id, role, body) VALUES ($1, $2, $3, $4)', [dispute.id, userId, userId === order.buyer_id ? 'buyer' : 'seller', reason]);
    const room = await roomOf(s.tx, orderId);
    await appendMessage(s, room.id, null, 'system', `Dispute opened: "${reason}". Escrow is frozen. An arbitration specialist will review this chat log — keep all evidence here.`, [], undefined, { code: 'dispute_opened', params: { reason } });
    await enqueueWebhook(s.tx, order.seller_id, 'order.disputed', { ...orderSummary(order), reason });
    for (const uid of [order.buyer_id, order.seller_id]) await enqueueEmail(s.tx, uid, 'dispute_opened', emailData(order, { reason }));
    s.notifyUser(order.buyer_id, 'order.disputed', { orderId });
    s.notifyUser(order.seller_id, 'order.disputed', { orderId });
    return dispute;
  });
}

/**
 * Arbiter decision: for the buyer (full refund to their balance), for the seller (release), or a
 * split (`refundCents` back to the buyer's balance, the rest released to the seller, commission
 * taken on the released part only).
 */
export async function resolveDispute(ctx: Ctx, disputeId: string, arbiterId: string, outcome: 'buyer' | 'seller' | 'split', note: string, refundCents?: number) {
  return withScope(ctx, async (s) => {
    const dispute = await maybeOne(s.tx, 'SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
    if (!dispute) throw notFound('Dispute');
    if (dispute.status !== 'open') throw conflict('already_resolved', 'Dispute already resolved');
    const order = await lockOrder(s.tx, dispute.order_id);
    let refund = outcome === 'buyer' ? order.amount_cents : outcome === 'seller' ? 0 : Math.round(refundCents ?? -1);
    if (outcome === 'split' && !(refund > 0 && refund < order.amount_cents)) throw badRequest('invalid_split', 'A split refunds part of the order: more than 0 and less than the full amount');
    if (outcome === 'split' && refund === order.amount_cents) refund = order.amount_cents;
    await s.tx.query(
      'UPDATE disputes SET status = $2, resolution_note = $3, resolved_by = $4, resolved_at = now(), refund_cents = $5 WHERE id = $1',
      [disputeId, outcome === 'buyer' ? 'resolved_buyer' : outcome === 'seller' ? 'resolved_seller' : 'resolved_split', note, arbiterId, refund],
    );
    const refundText = (mine: boolean) => (mine ? `${(refund / 100).toFixed(2)} ${order.currency} is back in your balance.` : 'The money went back to the buyer.');
    const releaseText = (mine: boolean) => (mine ? 'The payment was released to you.' : 'The payment was released to the seller.');
    const resultFor = (uid: string) => {
      const isBuyer = uid === order.buyer_id;
      if (outcome === 'buyer') return refundText(isBuyer);
      if (outcome === 'seller') return releaseText(!isBuyer);
      return `${refundText(isBuyer)} ${releaseText(!isBuyer)}`;
    };
    for (const uid of [order.buyer_id, order.seller_id]) {
      const forYou = outcome === 'split' ? true : outcome === 'buyer' ? uid === order.buyer_id : uid === order.seller_id;
      await enqueueEmail(s.tx, uid, 'dispute_resolved', emailData(order, { outcome, note, for_you: forYou, result: resultFor(uid) }));
    }
    if (outcome === 'seller') {
      await releaseEscrow(ctx, s, order, arbiterId, 'dispute_resolved_seller');
    } else if (outcome === 'buyer') {
      await refundOrder(ctx, s, order, arbiterId, 'dispute_resolved_buyer');
    } else {
      await splitEscrow(ctx, s, order, arbiterId, refund);
    }
    return { disputeId, outcome, refundCents: refund };
  });
}

/** Split decision: part of the escrow to the buyer's balance, the rest to the seller (commission pro rata on the released part). */
async function splitEscrow(ctx: Ctx, s: TxScope, order: Order & { delivery_mode: string; title: string }, arbiterId: string, refundCents: number) {
  if (order.rail !== 'fiat') throw conflict('onchain', 'On-chain escrow can only be split from the contract');
  const cur = order.currency;
  const held = await orderEscrowBalance(s.tx, order.id, cur);
  if (held !== order.amount_cents) throw new Error(`escrow imbalance for order ${order.id}: ${held}`);
  const released = order.amount_cents - refundCents;
  // The seller's part carries its share of the commission, with the reserve cut and the commission tax
  // recorded exactly as a full release does (Round 20).
  const commission = Math.round((order.commission_cents * released) / order.amount_cents);
  const reserveCut = Math.floor((commission * RESERVE_SHARE_BPS) / 10_000);
  const taxInfo = await taxForCommission(ctx, s.tx, order.seller_id, commission);
  await s.tx.query('UPDATE orders SET tax_country = $2, tax_rate_bps = $3, tax_treatment = $4, commission_tax_cents = $5, seller_received_cents = $6 WHERE id = $1', [
    order.id, taxInfo.country, taxInfo.rateBps, taxInfo.treatment, taxInfo.taxCents, released - commission,
  ]);
  const sellerPart = released - commission;
  // The buyer's refund: the promo-funded share goes back to the treasury, never into withdrawable credit.
  const promoShare = Math.min(refundCents, Math.round((order.discount_cents * refundCents) / order.amount_cents));
  await post(
    s.tx,
    [
      { account: await accountId(s.tx, 'escrow', cur), amountCents: -order.amount_cents },
      { account: await accountId(s.tx, 'user_credit', cur, order.buyer_id), amountCents: refundCents - promoShare },
      { account: await accountId(s.tx, 'treasury', cur), amountCents: commission - reserveCut - taxInfo.taxCents + promoShare },
      { account: await accountId(s.tx, 'reserve', cur), amountCents: reserveCut },
      { account: await accountId(s.tx, 'tax_payable', cur), amountCents: taxInfo.taxCents },
      await sellerLeg(s.tx, order, sellerPart, 'escrow_release'),
    ],
    'dispute_split',
    order.id,
  );
  await setRedemptionStatus(s.tx, order.id, 'released');
  await transition(s.tx, order, 'completed', arbiterId, 'dispute_resolved_split', ', completed_at = now()');
  const room = await roomOf(s.tx, order.id);
  await appendMessage(s, room.id, null, 'system', 'Dispute closed: part refunded to the buyer, the rest released to the seller.', [], undefined, { code: 'dispute_buyer', params: { split: true, refund_cents: refundCents } });
  await postOrderCard(s, order, 'completed');
  await enqueueWebhook(s.tx, order.seller_id, 'order.completed', orderSummary(order));
  s.notifyUser(order.seller_id, 'order.completed', { orderId: order.id });
  s.notifyUser(order.buyer_id, 'order.refunded', { orderId: order.id });
}

async function refundOrder(ctx: Ctx, s: TxScope, order: Order & { delivery_mode: string; title: string }, actorId: string | null, reason: string) {
  // The PSP refund is idempotent (keyed on the payment ref), so calling it inside the
  // transaction is safe: on rollback a retry re-uses the same refund.
  let settledBack: number | undefined;
  // Card payments are off at launch (crypto only): every refund lands in the buyer's balance. A gateway refund is
  // only attempted when card payments are switched on (CARD_REFUNDS_ENABLED) and the order was paid by card.
  const cardPaid = order.rail === 'fiat' && !!order.payment_ref && order.charged_cents > 0 && order.payment_provider !== 'none' && order.payment_provider !== 'nowpayments';
  if (cardPaid && ctx.cfg.CARD_REFUNDS_ENABLED) {
    settledBack = (await ctx.payments.refund(order.payment_ref!, order.presentment_amount_cents, order.presentment_currency, `refund_order_${order.id}`)).settledAmountCents;
  }
  await postRefund(s.tx, order, settledBack, reason);
  await setRedemptionStatus(s.tx, order.id, 'released');
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
  await appendMessage(s, room.id, null, 'system', `Order refunded to the buyer (${(order.amount_cents / 100).toFixed(2)} ${order.currency}).`, [], undefined, { code: reason === 'dispute_resolved_buyer' ? 'dispute_buyer' : 'refunded', params: { reason } });
  await postOrderCard(s, order, 'refunded');
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
export async function getOrderFor(ctx: Ctx, orderId: string, user: { id: string; role: string }) {
  const q = ctx.db;
  const order = await maybeOne(
    q,
    `SELECT o.*, f.title AS offer_title, f.game, f.category_slug, f.delivery_mode, c.kind AS category_kind,
            r.id AS room_id, b.display_name AS buyer_name, sl.display_name AS seller_name
       FROM orders o JOIN offers f ON f.id = o.offer_id JOIN categories c ON c.slug = f.category_slug
       JOIN chat_rooms r ON r.order_id = o.id JOIN users b ON b.id = o.buyer_id JOIN users sl ON sl.id = o.seller_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!order) throw notFound('Order');
  const staff = hasPermission(user, 'orders.view_any');
  if (!staff && order.buyer_id !== user.id && order.seller_id !== user.id) throw notFound('Order');
  // Sellers (and staff) see the buyer's reputation and their own rating of this order.
  const sellerView = staff || order.seller_id === user.id;
  const crypto = order.payment_provider === 'nowpayments';
  const [checklist, dispute, events, review, warrantyClaims, progress, buyerRep, buyerRating, cryptoPayments, cryptoRefund] = await Promise.all([
    maybeOne(q, 'SELECT items, completed_at, handover_platform, handover_at FROM security_checklists WHERE order_id = $1', [orderId]),
    maybeOne<any>(q, 'SELECT * FROM disputes WHERE order_id = $1', [orderId]).then(async (d) => d && { ...d, statements: await listStatements(q, d.id) }),
    many(q, 'SELECT from_status, to_status, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY id', [orderId]),
    maybeOne(q, 'SELECT id, rating, comment, seller_reply, created_at FROM reviews WHERE order_id = $1', [orderId]),
    claimsForOrder(q, orderId),
    order.category_kind === 'boosting' ? progressFor(q, orderId) : Promise.resolve([]),
    sellerView ? buyerReputation(q, order.buyer_id) : Promise.resolve(null),
    sellerView ? ratingForOrder(q, orderId) : Promise.resolve(null),
    crypto && order.buyer_id === user.id ? paymentsForOrder(q, orderId) : Promise.resolve([]),
    crypto ? refundForOrder(q, orderId) : Promise.resolve(null),
  ]);
  const deliveryProof = order.delivery_proof_id
    ? await maybeOne(q, 'SELECT id, mime, original_name, bytes, width, height, created_at FROM chat_attachments WHERE id = $1', [order.delivery_proof_id])
    : null;
  return {
    ...order, checklist, dispute, events, review, warranty_claims: warrantyClaims, progress, buyer_reputation: buyerRep, buyer_rating: buyerRating,
    lead_review: staff ? Number(order.amount_cents) > LEAD_REVIEW_ABOVE_CENTS : undefined,
    crypto_payments: cryptoPayments, crypto_refund: cryptoRefund, delivery_proof: deliveryProof,
    handover_field: handoverFieldFor(order.game, order.category_slug ?? ''),
    proof_required: ctx.cfg.DELIVERY_PROOF_REQUIRED && PROOF_REQUIRED_KINDS.has(order.category_kind) && order.delivery_mode === 'manual',
  };
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
  if (!ctx.cfg.AUTO_REFUND_LATE_ORDERS) throw conflict('disputes_only', 'Late orders are not cancelled; open a dispute and staff will decide');
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
        'Delivery time has passed. Seller: deliver now. Buyer: you can open a dispute.',
        [], undefined, { code: 'delivery_late' },
      );
    });
  }

  // CEO (Oct 24): no order is ever refunded automatically; refunds come only from a staff-decided dispute.
  if (!ctx.cfg.AUTO_REFUND_LATE_ORDERS) return { notified: late.length, refunded: 0 };
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
