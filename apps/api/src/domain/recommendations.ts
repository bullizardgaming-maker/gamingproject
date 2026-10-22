import type { Queryable } from '../db.js';
import { many } from '../db.js';
import { OFFER_LIST_SQL } from './offers.js';

/** A co-purchase only counts once this many different buyers made it, so no one buyer's history shows. */
export const MIN_CO_BUYERS = 2;

const LIVE = `f.status = 'active' AND f.reserved_for IS NULL AND f.available > 0 AND u.status = 'active' AND u.deleted_at IS NULL
  AND NOT (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now()))`;
const BOUGHT = `o.status IN ('paid', 'delivered', 'completed')`;

/**
 * "Buyers also bought": other live listings bought by buyers of this one, ranked by how many of
 * them did, only where at least MIN_CO_BUYERS did. The rest of the slots go to the best-selling
 * listings in the same game, so the strip is never empty on a new listing.
 */
export async function alsoBought(q: Queryable, offerId: string, limit = 6) {
  const co = await many<any>(
    q,
    `WITH buyers AS (SELECT DISTINCT o.buyer_id FROM orders o WHERE o.offer_id = $1 AND ${BOUGHT}),
          co AS (SELECT o.offer_id, count(DISTINCT o.buyer_id)::int AS buyers FROM orders o JOIN buyers b ON b.buyer_id = o.buyer_id
                  WHERE o.offer_id <> $1 AND ${BOUGHT} GROUP BY o.offer_id HAVING count(DISTINCT o.buyer_id) >= $3)
     SELECT * FROM (${OFFER_LIST_SQL.replace('SELECT f.id,', 'SELECT co.buyers, f.id,')} JOIN co ON co.offer_id = f.id WHERE ${LIVE}) x
      ORDER BY buyers DESC, seller_completed_orders DESC, id LIMIT $2`,
    [offerId, limit, MIN_CO_BUYERS],
  );
  const items = co.map(({ buyers: _b, ...r }) => ({ ...r, reason: 'also_bought' as const }));
  if (items.length < limit) {
    const more = await many<any>(
      q,
      `SELECT * FROM (${OFFER_LIST_SQL} WHERE ${LIVE} AND f.id <> $1 AND NOT (f.id = ANY($3::uuid[]))
          AND lower(f.game) = (SELECT lower(game) FROM offers WHERE id = $1)) x
        ORDER BY (category_slug = (SELECT category_slug FROM offers WHERE id = $1)) DESC, seller_completed_orders DESC, created_at DESC, id
        LIMIT $2`,
      [offerId, limit - items.length, items.map((i) => i.id)],
    );
    items.push(...more.map((r) => ({ ...r, reason: 'same_game' as const })));
  }
  return { items };
}
