import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Platform-funded promo codes. The buyer pays less; the seller's payout and
 * commission are unchanged because the platform tops up escrow from treasury
 * when the payment is captured. Redemptions are reserved when the order is
 * created (so limits can't be oversubscribed by parallel checkouts), marked
 * redeemed on payment, and released if the order is cancelled or refunded.
 */
export interface PromoInput {
  code: string;
  description?: string;
  percentOff?: number;
  amountOffCents?: number;
  maxDiscountCents?: number;
  minOrderCents?: number;
  categories?: string[];
  firstOrderOnly?: boolean;
  maxRedemptions?: number;
  perUserLimit?: number;
  startsAt?: string;
  endsAt?: string;
}

export async function createPromo(ctx: Ctx, adminId: string, p: PromoInput) {
  if ((p.percentOff == null) === (p.amountOffCents == null)) throw badRequest('invalid_promo', 'Set exactly one of percentOff or amountOffCents');
  try {
    return await one(
      ctx.db,
      `INSERT INTO promo_codes (code, description, percent_off, amount_off_cents, max_discount_cents, min_order_cents, categories,
                                first_order_only, max_redemptions, per_user_limit, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()), $12, $13) RETURNING *`,
      [p.code.trim(), p.description ?? '', p.percentOff ?? null, p.amountOffCents ?? null, p.maxDiscountCents ?? null, p.minOrderCents ?? 0,
       p.categories ?? null, p.firstOrderOnly ?? false, p.maxRedemptions ?? null, p.perUserLimit ?? 1, p.startsAt ?? null, p.endsAt ?? null, adminId],
    );
  } catch (err: any) {
    if (err.code === '23505') throw badRequest('code_taken', 'That code already exists');
    throw err;
  }
}

export async function listPromos(ctx: Ctx) {
  return many(
    ctx.db,
    `SELECT p.*,
            count(r.id) FILTER (WHERE r.status = 'redeemed')::int AS redeemed,
            count(r.id) FILTER (WHERE r.status = 'reserved')::int AS reserved,
            COALESCE(SUM(r.discount_cents) FILTER (WHERE r.status = 'redeemed'), 0)::bigint AS total_discount_cents
       FROM promo_codes p LEFT JOIN promo_redemptions r ON r.promo_id = p.id
      GROUP BY p.id ORDER BY p.created_at DESC`,
  );
}

export async function setPromoActive(ctx: Ctx, id: string, active: boolean) {
  const r = await ctx.db.query('UPDATE promo_codes SET active = $2 WHERE id = $1 RETURNING id, code, active', [id, active]);
  if (!r.rowCount) throw notFound('Promo code');
  return r.rows[0];
}

/** Validates a code for this buyer/order and returns the discount. Locks the code row for the rest of the transaction. */
export async function quotePromo(tx: Tx, code: string, buyerId: string, amountCents: number, categorySlug: string) {
  const p = await maybeOne(tx, 'SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE', [code.trim()]);
  const now = new Date();
  if (!p || !p.active) throw badRequest('promo_invalid', 'That promo code isn’t valid');
  if (new Date(p.starts_at) > now || (p.ends_at && new Date(p.ends_at) <= now)) throw badRequest('promo_expired', 'That promo code has expired');
  if (amountCents < p.min_order_cents) throw badRequest('promo_min_order', `This code needs an order of at least ${(p.min_order_cents / 100).toFixed(2)}`);
  if (p.categories && !p.categories.includes(categorySlug)) throw badRequest('promo_category', 'This code doesn’t apply to this category');
  const counts = await one<{ total: number; mine: number }>(
    tx,
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE user_id = $2)::int AS mine
       FROM promo_redemptions WHERE promo_id = $1 AND status IN ('reserved', 'redeemed')`,
    [p.id, buyerId],
  );
  if (p.max_redemptions != null && counts.total >= p.max_redemptions) throw badRequest('promo_exhausted', 'This code has been fully used');
  if (counts.mine >= p.per_user_limit) throw badRequest('promo_used', 'You’ve already used this code');
  if (p.first_order_only) {
    const prior = await maybeOne(tx, `SELECT 1 FROM orders WHERE buyer_id = $1 AND status NOT IN ('awaiting_payment', 'cancelled') LIMIT 1`, [buyerId]);
    if (prior) throw badRequest('promo_first_order', 'This code is for your first order only');
  }
  let discount = p.percent_off != null ? Math.floor((amountCents * p.percent_off) / 100) : Number(p.amount_off_cents);
  if (p.max_discount_cents != null) discount = Math.min(discount, Number(p.max_discount_cents));
  return { promoId: p.id as string, discountCents: Math.min(discount, amountCents) };
}

export async function reserveRedemption(q: Queryable, promoId: string, orderId: string, userId: string, discountCents: number) {
  await q.query('INSERT INTO promo_redemptions (promo_id, order_id, user_id, discount_cents) VALUES ($1, $2, $3, $4)', [promoId, orderId, userId, discountCents]);
}

export async function setRedemptionStatus(q: Queryable, orderId: string, status: 'redeemed' | 'released') {
  await q.query(`UPDATE promo_redemptions SET status = $2 WHERE order_id = $1 AND status <> $2`, [orderId, status]);
}
