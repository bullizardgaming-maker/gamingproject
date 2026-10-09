import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { maybeOne, one, withTx } from '../db.js';
import { conflict, forbidden } from '../lib/errors.js';
import { lockOrder } from './orders.js';

/**
 * Buyer reputation (migration 050). Sellers rate the buyer once per completed order, within
 * RATE_WITHIN_DAYS. The summary mixes those ratings with facts from the order records (completed
 * purchases, disputes the buyer opened and lost, chargebacks), so a seller can't rate away a
 * dispute the buyer won and a buyer can't hide a chargeback.
 */
export const BUYER_TAGS = ['clear_communication', 'quick_confirmation', 'patient', 'unresponsive', 'rude', 'changed_requirements', 'asked_off_platform'] as const;
export type BuyerTag = (typeof BUYER_TAGS)[number];
const POSITIVE_TAGS: BuyerTag[] = ['clear_communication', 'quick_confirmation', 'patient'];
export const RATE_WITHIN_DAYS = 30;

export interface BuyerReputation {
  level: 'new' | 'good' | 'caution';
  memberSince: string;
  completedOrders: number;
  positive: number;
  negative: number;
  disputesOpened: number;
  disputesLost: number;
  chargebacks: number;
  topTags: Array<{ tag: BuyerTag; count: number }>;
}

export async function buyerReputation(q: Queryable, buyerId: string): Promise<BuyerReputation> {
  const r = await one<any>(
    q,
    `SELECT u.created_at AS member_since,
            (SELECT count(*)::int FROM orders WHERE buyer_id = u.id AND status = 'completed') AS completed,
            (SELECT count(*)::int FROM orders WHERE buyer_id = u.id AND status = 'charged_back') AS chargebacks,
            (SELECT count(*)::int FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.buyer_id = u.id AND d.opened_by = u.id) AS disputes_opened,
            (SELECT count(*)::int FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.buyer_id = u.id AND d.opened_by = u.id AND d.status = 'resolved_seller') AS disputes_lost,
            (SELECT count(*) FILTER (WHERE positive)::int FROM buyer_ratings WHERE buyer_id = u.id) AS positive,
            (SELECT count(*) FILTER (WHERE NOT positive)::int FROM buyer_ratings WHERE buyer_id = u.id) AS negative,
            (SELECT coalesce(json_agg(t ORDER BY t.count DESC, t.tag), '[]') FROM (
               SELECT tag, count(*)::int AS count FROM buyer_ratings, unnest(tags) AS tag WHERE buyer_id = u.id GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 3
             ) t) AS top_tags
       FROM users u WHERE u.id = $1`,
    [buyerId],
  );
  const rated = r.positive + r.negative;
  const caution = r.chargebacks > 0 || r.disputes_lost >= 2 || (rated >= 3 && r.negative / rated > 0.25);
  return {
    level: caution ? 'caution' : r.completed < 3 ? 'new' : 'good',
    memberSince: new Date(r.member_since).toISOString(),
    completedOrders: r.completed,
    positive: r.positive,
    negative: r.negative,
    disputesOpened: r.disputes_opened,
    disputesLost: r.disputes_lost,
    chargebacks: r.chargebacks,
    topTags: r.top_tags,
  };
}

export async function ratingForOrder(q: Queryable, orderId: string) {
  return maybeOne(q, 'SELECT positive, tags, created_at FROM buyer_ratings WHERE order_id = $1', [orderId]);
}

export async function rateBuyer(ctx: Ctx, sellerId: string, orderId: string, input: { positive: boolean; tags: BuyerTag[] }) {
  const tags = [...new Set(input.tags)];
  // Praise tags on a negative rating (or complaints on a positive one) would be contradictory.
  const fits = tags.every((t) => POSITIVE_TAGS.includes(t) === input.positive);
  if (!fits) throw conflict('tags_mismatch', input.positive ? 'Pick tags that describe a good buyer' : 'Pick tags that describe what went wrong');
  return withTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.seller_id !== sellerId) throw forbidden('not_seller', 'Only the seller rates the buyer');
    if (order.status !== 'completed') throw conflict('not_rateable', 'Rate the buyer once the order is complete');
    const completedAt = (order as any).completed_at as Date | null;
    if (completedAt && Date.now() - new Date(completedAt).getTime() > RATE_WITHIN_DAYS * 86_400_000) throw conflict('rating_closed', `Ratings close ${RATE_WITHIN_DAYS} days after an order completes`);
    const row = await maybeOne(
      tx,
      `INSERT INTO buyer_ratings (order_id, seller_id, buyer_id, positive, tags) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id) DO NOTHING RETURNING positive, tags, created_at`,
      [orderId, sellerId, order.buyer_id, input.positive, tags],
    );
    if (!row) throw conflict('already_rated', 'You already rated this buyer for this order');
    return row;
  });
}
