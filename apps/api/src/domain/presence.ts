import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one, withTx } from '../db.js';

/**
 * "Online now" and "usually replies within …". Presence is the last signed-in activity (API
 * request, merchant API call or socket frame), written at most once a minute per user. Response
 * time is the median wait between a buyer's message and the seller's next reply in chat over
 * 90 days, recomputed hourly for sellers with recent chats.
 */
export const ONLINE_MINUTES = 5;
export const RESPONSE_DAYS = 90;
/** Fewer answered questions than this and we don't show a figure. */
export const MIN_RESPONSE_SAMPLE = 3;
/** Questions left unanswered longer than this count as this long. */
export const RESPONSE_CAP_MINUTES = 24 * 60;

const lastWrite = new Map<string, number>();
export function touchPresence(ctx: Ctx, userId: string) {
  const now = Date.now();
  if (now - (lastWrite.get(userId) ?? 0) < 60_000) return;
  lastWrite.set(userId, now);
  if (lastWrite.size > 50_000) lastWrite.clear(); // bounded; a cleared entry only costs one extra write
  ctx.db
    .query(`UPDATE users SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`, [userId])
    .catch((err) => ctx.log.warn({ err: (err as Error).message }, 'presence update failed'));
}

/** SQL for "is this user online", for a users row aliased `u`. */
export const ONLINE_SQL = `(u.show_online AND u.last_seen_at > now() - interval '${ONLINE_MINUTES} minutes')`;

/** Median first-reply time for one seller. A wait starts with a buyer message that follows a seller message (or opens the chat). */
export async function computeResponseTime(q: Queryable, sellerId: string) {
  return one<{ minutes: number | null; sample: number }>(
    q,
    `WITH msgs AS (
       SELECT m.room_id, m.seq, m.created_at, (m.sender_id = r.seller_id) AS from_seller,
              lag(m.sender_id = r.seller_id) OVER (PARTITION BY m.room_id ORDER BY m.seq) AS prev_from_seller
         FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id
        WHERE r.seller_id = $1 AND m.kind = 'text' AND m.sender_id IN (r.buyer_id, r.seller_id)
          AND m.created_at > now() - make_interval(days => $2::int)
     ), waits AS (
       SELECT a.created_at AS asked_at,
              (SELECT min(b.created_at) FROM msgs b WHERE b.room_id = a.room_id AND b.seq > a.seq AND b.from_seller) AS answered_at
         FROM msgs a WHERE NOT a.from_seller AND (a.prev_from_seller IS NULL OR a.prev_from_seller)
     )
     SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY LEAST(extract(epoch FROM COALESCE(answered_at, now()) - asked_at) / 60, $3::int)))::int AS minutes,
            count(*)::int AS sample
       FROM waits WHERE answered_at IS NOT NULL OR asked_at < now() - make_interval(mins => $3::int)`,
    [sellerId, RESPONSE_DAYS, RESPONSE_CAP_MINUTES],
  );
}

export async function refreshResponseTimes(ctx: Ctx, limit = 500): Promise<number> {
  const sellers = await many<{ id: string }>(
    ctx.db,
    // Sellers with fresh chats, sellers never computed who have chats in the window (first run
    // backfills), and a daily refresh for everyone else with a figure so old chats age out.
    `SELECT DISTINCT r.seller_id AS id FROM chat_rooms r JOIN chat_messages m ON m.room_id = r.id
      WHERE m.created_at > now() - interval '2 hours'
     UNION
     SELECT DISTINCT r.seller_id FROM chat_rooms r JOIN users u ON u.id = r.seller_id
      WHERE u.response_computed_at IS NULL AND r.created_at > now() - make_interval(days => $2::int)
     UNION
     SELECT id FROM users WHERE response_computed_at < now() - interval '1 day' AND response_sample > 0
     LIMIT $1`,
    [limit, RESPONSE_DAYS],
  );
  for (const s of sellers) {
    const r = await computeResponseTime(ctx.db, s.id);
    await ctx.db.query(`UPDATE users SET response_minutes = $2, response_sample = $3, response_computed_at = now() WHERE id = $1`, [
      s.id, r.sample >= MIN_RESPONSE_SAMPLE ? r.minutes : null, r.sample,
    ]);
  }
  return sellers.length;
}

let lastRun = 0;
export async function maybeRefreshResponseTimes(ctx: Ctx) {
  if (Date.now() - lastRun < 60 * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727294) AS l')).l);
  if (!locked) return null;
  return refreshResponseTimes(ctx);
}
