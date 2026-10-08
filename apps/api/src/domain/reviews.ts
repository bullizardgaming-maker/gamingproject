import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { detectOffPlatform } from './chat.js';
import { withScope } from './events.js';
import { enqueueEmail } from './notifications.js';

export const REVIEW_WINDOW_DAYS = 30;

/**
 * Buyers review completed orders only (one review per order), so every rating
 * is backed by a real, paid, delivered trade. Reviews where buyer and seller
 * share a device, card or wallet are stored but hidden from ratings: that's the
 * pattern of sellers reviewing themselves from sock-puppet accounts.
 */
export async function createReview(ctx: Ctx, orderId: string, buyerId: string, rating: number, comment: string) {
  const text = comment.trim();
  if (detectOffPlatform(text).length) throw badRequest('offplatform_contact', 'Reviews can’t contain contact details or external payment methods');
  return withScope(ctx, async (s) => {
    const order = await maybeOne(
      s.tx,
      `SELECT o.id, o.buyer_id, o.seller_id, o.status, o.completed_at, f.title FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.id = $1`,
      [orderId],
    );
    if (!order || order.buyer_id !== buyerId) throw notFound('Order');
    if (order.status !== 'completed') throw conflict('not_completed', 'You can review an order once it is completed');
    if (Date.now() - new Date(order.completed_at).getTime() > REVIEW_WINDOW_DAYS * 86_400_000) {
      throw conflict('review_window_closed', `Reviews can be left within ${REVIEW_WINDOW_DAYS} days of completion`);
    }
    const linked = await maybeOne(
      s.tx,
      `SELECT 1 FROM risk_signals a JOIN risk_signals b ON a.kind = b.kind AND a.value = b.value
        WHERE a.user_id = $1 AND b.user_id = $2 AND a.kind IN ('device', 'card', 'wallet') LIMIT 1`,
      [buyerId, order.seller_id],
    );
    try {
      await s.tx.query('SAVEPOINT review');
      const review = await one(
        s.tx,
        `INSERT INTO reviews (order_id, buyer_id, seller_id, rating, comment, hidden, hidden_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [orderId, buyerId, order.seller_id, rating, text, !!linked, linked ? 'linked_accounts' : null],
      );
      if (!linked) await enqueueEmail(s.tx, order.seller_id, 'new_review', { rating, comment: text.slice(0, 300), title: order.title });
      s.notifyUser(order.seller_id, 'review.created', { orderId, rating });
      return review;
    } catch (err: any) {
      if (err.code !== '23505') throw err;
      await s.tx.query('ROLLBACK TO SAVEPOINT review');
      throw conflict('already_reviewed', 'You already reviewed this order');
    }
  });
}

export async function replyToReview(ctx: Ctx, reviewId: string, sellerId: string, reply: string) {
  const text = reply.trim();
  if (detectOffPlatform(text).length) throw badRequest('offplatform_contact', 'Replies can’t contain contact details or external payment methods');
  const res = await ctx.db.query(
    `UPDATE reviews SET seller_reply = $3, replied_at = now() WHERE id = $1 AND seller_id = $2 AND seller_reply IS NULL RETURNING *`,
    [reviewId, sellerId, text],
  );
  if (res.rowCount) return res.rows[0];
  const r = await maybeOne(ctx.db, 'SELECT seller_id FROM reviews WHERE id = $1', [reviewId]);
  if (!r) throw notFound('Review');
  if (r.seller_id !== sellerId) throw forbidden('not_seller', 'Only the seller can reply');
  throw conflict('already_replied', 'You already replied to this review');
}

export async function setReviewHidden(ctx: Ctx, reviewId: string, hidden: boolean, reason: string) {
  const res = await ctx.db.query('UPDATE reviews SET hidden = $2, hidden_reason = $3 WHERE id = $1 RETURNING id, hidden', [reviewId, hidden, hidden ? reason : null]);
  if (!res.rowCount) throw notFound('Review');
  return res.rows[0];
}

/** Rating summary used on listings and seller profiles. Only visible reviews count. */
export async function sellerRating(q: Queryable, sellerId: string) {
  return one<{ count: number; average: number | null; positive_pct: number | null }>(
    q,
    `SELECT count(*)::int AS count,
            round(avg(rating)::numeric, 2) AS average,
            round(100.0 * count(*) FILTER (WHERE rating >= 4) / NULLIF(count(*), 0), 0) AS positive_pct
       FROM reviews WHERE seller_id = $1 AND NOT hidden`,
    [sellerId],
  );
}

export async function sellerProfile(q: Queryable, sellerId: string, limit = 20, offset = 0) {
  const seller = await maybeOne(
    q,
    `SELECT u.id, u.display_name, u.created_at AS member_since, u.kyc_tier >= 2 AS identity_verified,
            (SELECT count(*)::int FROM orders o WHERE o.seller_id = u.id AND o.status = 'completed') AS completed_orders,
            (SELECT count(*)::int FROM offers f WHERE f.seller_id = u.id AND f.status = 'active') AS active_listings,
            (SELECT round(100.0 * count(*) FILTER (WHERE o.delivered_at <= o.delivery_due_at) / NULLIF(count(*), 0), 0)
               FROM orders o WHERE o.seller_id = u.id AND o.delivery_due_at IS NOT NULL AND o.delivery_due_at < now()
                AND o.created_at > now() - interval '90 days' AND o.status NOT IN ('cancelled', 'awaiting_payment')) AS on_time_delivery_pct,
            (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now())) AS shop_paused, u.shop_paused_until, u.shop_pause_message
       FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status = 'active'`,
    [sellerId],
  );
  if (!seller) throw notFound('Seller');
  const [rating, reviews] = await Promise.all([
    sellerRating(q, sellerId),
    many(
      q,
      `SELECT r.id, r.rating, r.comment, r.seller_reply, r.replied_at, r.created_at, b.display_name AS buyer_name, f.title AS offer_title
         FROM reviews r JOIN users b ON b.id = r.buyer_id JOIN orders o ON o.id = r.order_id JOIN offers f ON f.id = o.offer_id
        WHERE r.seller_id = $1 AND NOT r.hidden ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [sellerId, Math.min(limit, 50), offset],
    ),
  ]);
  return { ...seller, rating, reviews };
}
