import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notify } from './notifications.js';

/**
 * Support tickets from the help centre. A ticket can point at one of the customer's orders (as
 * buyer or seller); order and payment problems on an order still in escrow are raised to high
 * priority. Staff reply publicly or leave internal notes; a staff reply waits on the customer,
 * and a ticket left waiting a week resolves itself. Any reply reopens a resolved ticket.
 */
export const TICKET_CATEGORIES = ['order', 'payment', 'account', 'selling', 'report', 'appeal', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const MAX_OPEN_TICKETS = 5;
export const AUTO_RESOLVE_DAYS = 7;

const TICKET_COLS = `t.id, t.number, t.user_id, t.order_id, t.category, t.subject, t.status, t.priority, t.assigned_to,
  t.created_at, t.updated_at, t.first_response_at, t.resolved_at, t.dispute_id`;

async function orderSummary(q: Queryable, orderId: string | null) {
  if (!orderId) return null;
  return maybeOne(
    q,
    `SELECT o.id, o.status, o.amount_cents, o.currency, o.created_at, o.paid_at, o.buyer_id, o.seller_id, f.title AS offer_title, f.game,
            b.display_name AS buyer_name, s.display_name AS seller_name
       FROM orders o JOIN offers f ON f.id = o.offer_id JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id WHERE o.id = $1`,
    [orderId],
  );
}

export async function createTicket(ctx: Ctx, userId: string, input: { category: TicketCategory; subject: string; body: string; orderId?: string }) {
  return withTx(ctx.db, async (tx) => {
    // Serialise per user so the open-ticket cap holds under concurrent submits.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`support:${userId}`]);
    const { n } = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM support_tickets WHERE user_id = $1 AND status <> 'resolved'`, [userId]);
    if (n >= MAX_OPEN_TICKETS) throw badRequest('too_many_tickets', `You have ${n} open requests. Reply on one of those, or wait for an answer, before opening another.`);
    let priority = 'normal';
    if (input.orderId) {
      const o = await maybeOne(tx, 'SELECT buyer_id, seller_id, status FROM orders WHERE id = $1', [input.orderId]);
      if (!o || (o.buyer_id !== userId && o.seller_id !== userId)) throw notFound('Order');
      if (['order', 'payment'].includes(input.category) && ['paid', 'delivered', 'disputed'].includes(o.status)) priority = 'high';
    }
    const t = await one(
      tx,
      `INSERT INTO support_tickets (user_id, order_id, category, subject, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id, number`,
      [userId, input.orderId ?? null, input.category, input.subject, priority],
    );
    await tx.query(`INSERT INTO support_messages (ticket_id, author_id, staff, body) VALUES ($1, $2, false, $3)`, [t.id, userId, input.body]);
    await notify(tx, userId, 'support_received', { number: t.number, subject: input.subject, ticket_id: t.id }, `support:${t.id}:received`);
    return t.id as string;
  });
}

export async function listMyTickets(q: Queryable, userId: string) {
  return many(
    q,
    `SELECT ${TICKET_COLS},
            (SELECT m.staff FROM support_messages m WHERE m.ticket_id = t.id AND NOT m.internal ORDER BY m.created_at DESC LIMIT 1) AS last_from_staff
       FROM support_tickets t WHERE t.user_id = $1 ORDER BY t.updated_at DESC LIMIT 100`,
    [userId],
  );
}

/** One ticket with its thread. Customers never see internal notes or who on staff wrote a reply. */
export async function getTicket(q: Queryable, id: string, viewer: { id: string; staff: boolean }) {
  const t = await maybeOne<any>(
    q,
    `SELECT ${TICKET_COLS}, u.display_name AS user_name, u.email AS user_email, a.display_name AS assignee_name
       FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to WHERE t.id = $1`,
    [id],
  );
  if (!t || (!viewer.staff && t.user_id !== viewer.id)) throw notFound('Ticket');
  const messages = await many(
    q,
    `SELECT m.id, m.staff, m.internal, m.body, m.created_at, m.author_id, u.display_name AS author_name
       FROM support_messages m JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = $1 AND ($2 OR NOT m.internal) ORDER BY m.created_at`,
    [id, viewer.staff],
  );
  const order = await orderSummary(q, t.order_id);
  // Round 24: a dispute staff opened from this ticket.
  const dispute = t.dispute_id
    ? await maybeOne(q, 'SELECT id, order_id, status, category, reason, created_at, resolved_at FROM disputes WHERE id = $1', [t.dispute_id])
    : null;
  if (!viewer.staff) {
    delete t.user_email;
    delete t.assignee_name;
    delete t.assigned_to;
    for (const m of messages) {
      delete m.author_id;
      if (m.staff) m.author_name = 'Bullizard Support';
      delete m.internal;
    }
  }
  return { ...t, order, dispute, messages };
}

export async function customerReply(ctx: Ctx, userId: string, id: string, body: string) {
  return withTx(ctx.db, async (tx) => {
    const t = await maybeOne(tx, 'SELECT user_id FROM support_tickets WHERE id = $1 FOR UPDATE', [id]);
    if (!t || t.user_id !== userId) throw notFound('Ticket');
    await tx.query(`INSERT INTO support_messages (ticket_id, author_id, staff, body) VALUES ($1, $2, false, $3)`, [id, userId, body]);
    await tx.query(`UPDATE support_tickets SET status = 'open', resolved_at = NULL, updated_at = now() WHERE id = $1`, [id]);
  });
}

export async function customerResolve(ctx: Ctx, userId: string, id: string) {
  const res = await ctx.db.query(
    `UPDATE support_tickets SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND status <> 'resolved'`,
    [id, userId],
  );
  if (!res.rowCount && !(await maybeOne(ctx.db, 'SELECT 1 FROM support_tickets WHERE id = $1 AND user_id = $2', [id, userId]))) throw notFound('Ticket');
}

/** Staff reply or internal note. A public reply waits on the customer and notifies them. */
export async function staffReply(ctx: Ctx, q: Queryable, staffId: string, id: string, body: string, internal: boolean, resolve = false) {
  const t = await maybeOne(q, 'SELECT id, number, user_id, subject, assigned_to FROM support_tickets WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('Ticket');
  await q.query(`INSERT INTO support_messages (ticket_id, author_id, staff, internal, body) VALUES ($1, $2, true, $3, $4)`, [id, staffId, internal, body]);
  if (internal) {
    await q.query('UPDATE support_tickets SET updated_at = now() WHERE id = $1', [id]);
    return;
  }
  await q.query(
    `UPDATE support_tickets SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() END,
            first_response_at = COALESCE(first_response_at, now()), assigned_to = COALESCE(assigned_to, $3), updated_at = now()
      WHERE id = $1`,
    [id, resolve ? 'resolved' : 'pending', staffId],
  );
  const { n } = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM support_messages WHERE ticket_id = $1', [id]);
  await notify(q, t.user_id, 'support_reply', { number: t.number, subject: t.subject, ticket_id: id, resolved: resolve, preview: body.slice(0, 200) }, `support:${id}:reply:${n}`);
}

export async function updateTicket(q: Queryable, id: string, patch: { status?: 'open' | 'pending' | 'resolved'; priority?: 'normal' | 'high'; assignedTo?: string | null }) {
  if (patch.assignedTo) {
    const s = await maybeOne(q, `SELECT role, staff_roles FROM users WHERE id = $1`, [patch.assignedTo]);
    if (!s || (s.role === 'user' && !(s.staff_roles ?? []).length)) throw badRequest('not_staff', 'Tickets can only be assigned to staff');
  }
  const res = await q.query(
    `UPDATE support_tickets SET status = COALESCE($2, status), priority = COALESCE($3, priority),
            assigned_to = CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_to END,
            resolved_at = CASE WHEN COALESCE($2, status) = 'resolved' THEN COALESCE(resolved_at, now()) ELSE NULL END, updated_at = now()
      WHERE id = $1`,
    [id, patch.status ?? null, patch.priority ?? null, patch.assignedTo !== undefined, patch.assignedTo ?? null],
  );
  if (!res.rowCount) throw notFound('Ticket');
}

/** The staff queue: unresolved first, high priority and oldest waiting on top. */
export async function ticketQueue(q: Queryable, f: { status?: 'open' | 'pending' | 'resolved' | 'active'; assignedTo?: string; limit?: number }) {
  const status = f.status ?? 'active';
  return many(
    q,
    `SELECT ${TICKET_COLS}, u.display_name AS user_name, a.display_name AS assignee_name,
            (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id AND NOT m.internal) AS messages
       FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to
      WHERE ($1 = 'active' AND t.status <> 'resolved' OR t.status = $1) AND ($2::uuid IS NULL OR t.assigned_to = $2)
      ORDER BY (t.status = 'open') DESC, (t.priority = 'high') DESC, t.updated_at ASC LIMIT $3`,
    [status, f.assignedTo ?? null, Math.min(f.limit ?? 100, 200)],
  );
}

/** Resolve tickets that have waited on the customer for a week. */
export async function autoResolveTickets(ctx: Ctx) {
  const rows = await many<{ id: string; number: number; user_id: string; subject: string }>(
    ctx.db,
    `UPDATE support_tickets SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE status = 'pending' AND updated_at < now() - make_interval(days => $1) RETURNING id, number, user_id, subject`,
    [AUTO_RESOLVE_DAYS],
  );
  for (const t of rows) await notify(ctx.db, t.user_id, 'support_auto_resolved', { number: t.number, subject: t.subject, ticket_id: t.id, days: AUTO_RESOLVE_DAYS }, `support:${t.id}:auto:${Date.now()}`);
  return rows.length;
}
