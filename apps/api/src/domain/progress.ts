import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { appendMessage } from './chat.js';
import { withScope } from './events.js';
import { notify } from './notifications.js';
import { lockOrder, roomOf } from './orders.js';

/**
 * Boosting progress (migration 049). While a boosting order is paid and not yet delivered, the
 * seller posts milestones: a percentage, a short note and optionally a screenshot from the order
 * chat. The buyer sees a progress bar and timeline, gets a notification, and each update is a
 * system message in the chat, so it counts as evidence if a dispute follows.
 */
export const MAX_UPDATES = 50;

export async function progressFor(q: Queryable, orderId: string) {
  return many(
    q,
    `SELECT p.id, p.percent, p.note, p.created_at, a.id AS attachment_id, a.width, a.height, a.sha256
       FROM order_progress p LEFT JOIN chat_attachments a ON a.id = p.attachment_id
      WHERE p.order_id = $1 ORDER BY p.created_at, p.id`,
    [orderId],
  );
}

export async function postProgress(ctx: Ctx, sellerId: string, orderId: string, input: { percent: number; note: string; attachmentId?: string }) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.seller_id !== sellerId) throw forbidden('not_seller', 'Only the seller posts progress');
    if (order.category_kind !== 'boosting') throw badRequest('not_boosting', 'Progress updates are for boosting orders');
    if (order.status !== 'paid') throw conflict('invalid_state', 'Progress can be posted while the order is in progress');
    const last = await maybeOne<{ percent: number; n: number }>(
      s.tx,
      `SELECT (SELECT percent FROM order_progress WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1) AS percent,
              (SELECT count(*)::int FROM order_progress WHERE order_id = $1) AS n`,
      [orderId],
    );
    if ((last?.n ?? 0) >= MAX_UPDATES) throw conflict('too_many_updates', `Up to ${MAX_UPDATES} updates per order`);
    if (last?.percent != null && input.percent < last.percent) throw badRequest('progress_backwards', `Progress can’t go below the last update (${last.percent}%)`);
    const room = await roomOf(s.tx, orderId);
    if (input.attachmentId) {
      const att = await maybeOne(s.tx, `SELECT 1 FROM chat_attachments WHERE id = $1 AND room_id = $2 AND uploader_id = $3 AND status = 'clean'`, [input.attachmentId, room.id, sellerId]);
      if (!att) throw badRequest('invalid_attachment', 'Attach a screenshot you uploaded to this order’s chat');
    }
    const row = await one(
      s.tx,
      `INSERT INTO order_progress (order_id, author_id, percent, note, attachment_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, percent, note, attachment_id, created_at`,
      [orderId, sellerId, input.percent, input.note, input.attachmentId ?? null],
    );
    await appendMessage(s, room.id, null, 'system', `Progress: ${input.percent}%${input.note ? ` · ${input.note}` : ''}${input.attachmentId ? ' (screenshot attached)' : ''}`);
    s.notifyUser(order.buyer_id, 'order.updated', { orderId });
    await notify(s.tx, order.buyer_id, 'order_progress', { order_id: orderId, title: order.title, percent: input.percent, note: input.note }, `progress:${row.id}`);
    return row;
  });
}
