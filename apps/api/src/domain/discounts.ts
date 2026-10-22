import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/**
 * Seller-funded discounts: timed sales on a listing and discount codes for a seller's shop.
 * Both lower the order's own price, so the seller's commission is on what the buyer pays and
 * nothing is topped up from the platform (that's what platform promo codes do, see promos.ts).
 */
export const MAX_SALE_DAYS = 30;

export { effectivePrice, type SaleFields } from './priceTiers.js';

/** SQL for the same, on an offers row aliased `f`. */
export const EFFECTIVE_PRICE_SQL = `(CASE WHEN f.sale_price_cents IS NOT NULL AND f.sale_starts_at <= now() AND f.sale_ends_at > now() THEN f.sale_price_cents ELSE f.price_cents END)`;

export async function setSale(ctx: Ctx, sellerId: string, offerId: string, input: { salePriceCents: number; startsAt?: string; endsAt: string }) {
  const f = await maybeOne(ctx.db, 'SELECT seller_id, price_cents, reserved_for, status FROM offers WHERE id = $1', [offerId]);
  if (!f || f.seller_id !== sellerId || f.status === 'removed') throw notFound('Offer');
  if (f.reserved_for) throw conflict('reserved_offer', 'This listing was agreed with a buyer and its price can’t be changed');
  const starts = input.startsAt ? new Date(input.startsAt) : new Date();
  const ends = new Date(input.endsAt);
  if (input.salePriceCents >= f.price_cents) throw badRequest('invalid_sale', 'The sale price must be lower than the listing price');
  if (ends <= new Date() || ends <= starts) throw badRequest('invalid_sale', 'The sale must end in the future, after it starts');
  if (ends.getTime() - starts.getTime() > MAX_SALE_DAYS * 86_400_000) throw badRequest('invalid_sale', `A sale can run for up to ${MAX_SALE_DAYS} days`);
  await ctx.db.query(
    `UPDATE offers SET sale_price_cents = $2, sale_starts_at = $3, sale_ends_at = $4, sale_active = ($3 <= now() AND $4 > now()),
            version = version + 1, updated_at = now() WHERE id = $1`,
    [offerId, input.salePriceCents, starts, ends],
  );
}

export async function endSale(ctx: Ctx, sellerId: string, offerId: string) {
  const res = await ctx.db.query(
    `UPDATE offers SET sale_price_cents = NULL, sale_starts_at = NULL, sale_ends_at = NULL, sale_active = false, version = version + 1, updated_at = now()
      WHERE id = $1 AND seller_id = $2 RETURNING id`,
    [offerId, sellerId],
  );
  if (!res.rowCount) throw notFound('Offer');
}

/** Worker: flip sale_active as windows open and close (so search sorts by the current price), and clear finished sales. */
export async function syncSales(ctx: Ctx): Promise<number> {
  const res = await ctx.db.query(
    `UPDATE offers SET sale_active = (sale_starts_at <= now() AND sale_ends_at > now())
      WHERE sale_price_cents IS NOT NULL AND sale_active IS DISTINCT FROM (sale_starts_at <= now() AND sale_ends_at > now())`,
  );
  await ctx.db.query(
    `UPDATE offers SET sale_price_cents = NULL, sale_starts_at = NULL, sale_ends_at = NULL, sale_active = false
      WHERE sale_price_cents IS NOT NULL AND sale_ends_at < now() - interval '1 day'`,
  );
  return res.rowCount ?? 0;
}

// ---- Discount codes --------------------------------------------------------------------------
export interface SellerCodeInput {
  code: string;
  percentOff: number;
  minOrderCents?: number;
  maxUses?: number;
  perBuyerLimit?: number;
  startsAt?: string;
  endsAt?: string;
}

const CODE_COLS = `c.id, c.code, c.percent_off, c.min_order_cents, c.max_uses, c.per_buyer_limit, c.starts_at, c.ends_at, c.active, c.created_at,
  (SELECT count(*)::int FROM orders o WHERE o.seller_code_id = c.id AND o.status NOT IN ('cancelled', 'awaiting_payment')) AS uses,
  (SELECT COALESCE(sum(o.seller_discount_cents), 0)::bigint FROM orders o WHERE o.seller_code_id = c.id AND o.status NOT IN ('cancelled', 'awaiting_payment')) AS discount_cents`;

export async function createSellerCode(q: Queryable, sellerId: string, input: SellerCodeInput) {
  if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt ?? Date.now())) throw badRequest('invalid_code', 'The code must end after it starts');
  try {
    return await one(
      q,
      `INSERT INTO seller_codes (seller_id, code, percent_off, min_order_cents, max_uses, per_buyer_limit, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8) RETURNING id`,
      [sellerId, input.code.trim(), input.percentOff, input.minOrderCents ?? 0, input.maxUses ?? null, input.perBuyerLimit ?? 1, input.startsAt ?? null, input.endsAt ?? null],
    ).then((r) => getSellerCode(q, sellerId, r.id));
  } catch (err: any) {
    if (err.code === '23505') throw conflict('code_taken', 'You already have a code with that name');
    throw err;
  }
}

async function getSellerCode(q: Queryable, sellerId: string, id: string) {
  const c = await maybeOne(q, `SELECT ${CODE_COLS} FROM seller_codes c WHERE c.id = $1 AND c.seller_id = $2`, [id, sellerId]);
  if (!c) throw notFound('Code');
  return c;
}

export const listSellerCodes = (q: Queryable, sellerId: string) => many(q, `SELECT ${CODE_COLS} FROM seller_codes c WHERE c.seller_id = $1 ORDER BY c.created_at DESC`, [sellerId]);

export async function setSellerCodeActive(q: Queryable, sellerId: string, id: string, active: boolean) {
  const r = await q.query('UPDATE seller_codes SET active = $3 WHERE id = $1 AND seller_id = $2', [id, sellerId, active]);
  if (!r.rowCount) throw notFound('Code');
  return getSellerCode(q, sellerId, id);
}

/**
 * Check a buyer's code against the seller of the listing and return the discount on `amountCents`
 * (listing currency). Locks the code row so parallel checkouts can't pass a use limit.
 * Orders still awaiting payment count towards the limits (they hold the use until they lapse).
 */
export async function quoteSellerCode(tx: Tx, code: string, sellerId: string, buyerId: string, amountCents: number) {
  const c = await maybeOne(tx, 'SELECT * FROM seller_codes WHERE seller_id = $1 AND code = $2 FOR UPDATE', [sellerId, code.trim()]);
  const now = new Date();
  if (!c || !c.active) throw badRequest('code_invalid', 'That code isn’t valid for this seller');
  if (new Date(c.starts_at) > now || (c.ends_at && new Date(c.ends_at) <= now)) throw badRequest('code_expired', 'That code has expired');
  if (amountCents < Number(c.min_order_cents)) throw badRequest('code_min_order', `This code needs an order of at least ${(Number(c.min_order_cents) / 100).toFixed(2)}`);
  const used = await one<{ total: number; mine: number }>(
    tx,
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE buyer_id = $2)::int AS mine FROM orders WHERE seller_code_id = $1 AND status <> 'cancelled'`,
    [c.id, buyerId],
  );
  if (c.max_uses != null && used.total >= c.max_uses) throw badRequest('code_exhausted', 'This code has been fully used');
  if (used.mine >= c.per_buyer_limit) throw badRequest('code_used', 'You’ve already used this code');
  return { codeId: c.id as string, discountCents: Math.floor((amountCents * c.percent_off) / 100), percentOff: c.percent_off as number };
}
