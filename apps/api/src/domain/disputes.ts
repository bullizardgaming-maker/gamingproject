import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { appendMessage, listMessages, verifyChain } from './chat.js';
import { withScope } from './events.js';
import { notify } from './notifications.js';
import { trustMetrics } from './trust.js';

/**
 * Dispute evidence: statements from each side, and the case file an arbiter decides from:
 * one timeline of what happened (status changes, chat, deliveries, flags, statements), the
 * listing as it was bought, payment checks and both parties' track records.
 */
export const DISPUTE_CATEGORIES = ['not_delivered', 'not_as_described', 'not_working', 'account_recovered', 'other'] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];
export const MAX_STATEMENTS_PER_SIDE = 5;

export async function listStatements(q: Queryable, disputeId: string) {
  return many(
    q,
    `SELECT s.id, s.role, s.body, s.created_at, u.display_name AS author_name FROM dispute_statements s JOIN users u ON u.id = s.user_id
      WHERE s.dispute_id = $1 ORDER BY s.created_at`,
    [disputeId],
  );
}

export async function addStatement(ctx: Ctx, orderId: string, userId: string, body: string) {
  return withScope(ctx, async (s) => {
    const d = await maybeOne<any>(
      s.tx,
      `SELECT d.id, d.status, o.buyer_id, o.seller_id FROM disputes d JOIN orders o ON o.id = d.order_id WHERE d.order_id = $1 FOR UPDATE OF d`,
      [orderId],
    );
    if (!d) throw notFound('Dispute');
    if (userId !== d.buyer_id && userId !== d.seller_id) throw forbidden('not_participant', 'Not a participant of this order');
    if (d.status !== 'open') throw conflict('dispute_closed', 'This dispute has been decided');
    const role = userId === d.buyer_id ? 'buyer' : 'seller';
    const { n } = await one<{ n: number }>(s.tx, 'SELECT count(*)::int AS n FROM dispute_statements WHERE dispute_id = $1 AND user_id = $2', [d.id, userId]);
    if (n >= MAX_STATEMENTS_PER_SIDE) throw conflict('too_many_statements', `Each side can add up to ${MAX_STATEMENTS_PER_SIDE} statements; add anything else in the chat`);
    await s.tx.query('INSERT INTO dispute_statements (dispute_id, user_id, role, body) VALUES ($1, $2, $3, $4)', [d.id, userId, role, body]);
    const room = await one<{ id: string }>(s.tx, 'SELECT id FROM chat_rooms WHERE order_id = $1', [orderId]);
    await appendMessage(s, room.id, null, 'system', `The ${role} added a statement to the dispute. The arbiter reads both sides' statements with this chat.`);
    const other = role === 'buyer' ? d.seller_id : d.buyer_id;
    s.notifyUser(other, 'order.updated', { orderId });
    await notify(s.tx, other, 'dispute_statement', { order_id: orderId, role }, `dispute:${d.id}:statement:${n}:${role}`);
    return listStatements(s.tx, d.id);
  });
}

async function party(q: Queryable, userId: string) {
  return one<any>(
    q,
    `SELECT u.id, u.display_name, u.created_at, u.kyc_tier, u.trust_level, u.offplatform_strikes, u.status,
            (SELECT count(*)::int FROM orders o WHERE o.buyer_id = u.id AND o.status NOT IN ('awaiting_payment', 'cancelled')) AS orders_as_buyer,
            (SELECT count(*)::int FROM orders o WHERE o.seller_id = u.id AND o.status = 'completed') AS completed_sales,
            (SELECT count(*)::int FROM disputes d WHERE d.opened_by = u.id) AS disputes_opened,
            (SELECT count(*)::int FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.seller_id = u.id) AS disputes_against_as_seller,
            (SELECT count(*)::int FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.seller_id = u.id AND d.status = 'resolved_buyer') AS disputes_lost_as_seller,
            (SELECT count(*)::int FROM chargebacks c JOIN orders o ON o.id = c.order_id WHERE o.buyer_id = u.id) AS chargebacks_filed
       FROM users u WHERE u.id = $1`,
    [userId],
  );
}

export interface TimelineItem {
  at: string;
  type: 'status' | 'message' | 'delivery' | 'flag' | 'statement';
  who: 'buyer' | 'seller' | 'system' | 'staff';
  text: string;
  meta?: Record<string, unknown>;
}

/** Everything an arbiter needs for one dispute, on one page. Staff only (the route audits the read). */
export async function caseFile(ctx: Ctx, disputeId: string) {
  const d = await maybeOne<any>(ctx.db, 'SELECT * FROM disputes WHERE id = $1', [disputeId]);
  if (!d) throw notFound('Dispute');
  const order = await one<any>(
    ctx.db,
    `SELECT o.id, o.status, o.buyer_id, o.seller_id, o.offer_id, o.quantity, o.amount_cents, o.currency, o.charged_cents, o.protection, o.rail,
            o.created_at, o.paid_at, o.delivered_at, o.delivery_due_at, o.protection_ends_at, o.buyer_ip_country, f.title, f.description, f.game, f.category_slug
       FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.id = $1`,
    [d.order_id],
  );
  const role = (id: string | null): TimelineItem['who'] => (!id ? 'system' : id === order.buyer_id ? 'buyer' : id === order.seller_id ? 'seller' : 'staff');
  const room = await one<{ id: string }>(ctx.db, 'SELECT id FROM chat_rooms WHERE order_id = $1', [order.id]);

  const [events, messages, flags, statements, deliveries, snapshot, payment, risk, checklist, buyer, seller, sellerRates, chain] = await Promise.all([
    many<any>(ctx.db, 'SELECT from_status, to_status, actor_id, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY id', [order.id]),
    listMessages(ctx.keyring, ctx.db, room.id, 0, 500),
    many<any>(ctx.db, 'SELECT seq, user_id, reasons, status, created_at FROM chat_flags WHERE room_id = $1 ORDER BY created_at', [room.id]),
    listStatements(ctx.db, d.id),
    many<any>(ctx.db, `SELECT date_trunc('second', delivered_at) AS at, count(*)::int AS n FROM inventory_items WHERE order_id = $1 AND delivered_at IS NOT NULL GROUP BY 1 ORDER BY 1`, [order.id]),
    maybeOne<any>(ctx.db, 'SELECT snapshot, sha256, created_at FROM offer_snapshots WHERE order_id = $1', [order.id]),
    maybeOne<any>(ctx.db, 'SELECT avs_result, cvv_result, card_brand, card_last4, billing_country, ip_country FROM payment_details WHERE order_id = $1', [order.id]),
    many<any>(ctx.db, 'SELECT score, reasons, status, created_at FROM risk_flags WHERE order_id = $1 OR (user_id = ANY($2) AND status = $3) ORDER BY created_at', [order.id, [order.buyer_id, order.seller_id], 'confirmed']),
    maybeOne<any>(ctx.db, 'SELECT items, completed_at FROM security_checklists WHERE order_id = $1', [order.id]),
    party(ctx.db, order.buyer_id),
    party(ctx.db, order.seller_id),
    trustMetrics(ctx.db, order.seller_id),
    verifyChain(ctx.db, room.id, ctx.keyring),
  ]);

  const timeline: TimelineItem[] = [
    ...events.map((e) => ({ at: e.created_at, type: 'status' as const, who: role(e.actor_id), text: `${e.from_status ?? 'created'} → ${e.to_status}`, meta: { reason: e.reason } })),
    ...messages.map((m) => ({
      at: m.created_at,
      type: 'message' as const,
      who: m.kind === 'text' || m.kind === 'attachment' ? role(m.sender_id) : 'system',
      text: m.erased ? '(erased at the author’s request)' : m.body ?? '',
      meta: { seq: m.seq, kind: m.kind, flags: m.flags },
    })),
    ...deliveries.map((x) => ({ at: x.at, type: 'delivery' as const, who: 'system' as const, text: `${x.n} item${x.n === 1 ? '' : 's'} delivered`, meta: {} })),
    ...flags.map((f) => ({ at: f.created_at, type: 'flag' as const, who: role(f.user_id), text: `Off-platform check: ${f.reasons.join(', ')}`, meta: { seq: f.seq, status: f.status } })),
    ...statements.map((s: any) => ({ at: s.created_at, type: 'statement' as const, who: s.role, text: s.body, meta: {} })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Facts arbiters check first, worked out here so nobody has to read the whole chat for them.
  const lastSeller = messages.filter((m) => m.sender_id === order.seller_id).at(-1);
  const facts = {
    deliveredLate: !!(order.delivery_due_at && (!order.delivered_at || new Date(order.delivered_at) > new Date(order.delivery_due_at))),
    sellerLastMessageAt: lastSeller?.created_at ?? null,
    sellerRepliedAfterDispute: messages.some((m) => m.sender_id === order.seller_id && new Date(m.created_at) > new Date(d.created_at)),
    listingChangedSincePurchase: !!snapshot && (snapshot.snapshot.offer?.title !== order.title || snapshot.snapshot.offer?.description !== order.description),
    cardCountryMatchesIp: payment?.billing_country && payment?.ip_country ? payment.billing_country === payment.ip_country : null,
    chatChainIntact: chain.valid,
    checklistCompleted: checklist ? !!checklist.completed_at : null,
  };

  return {
    dispute: { id: d.id, status: d.status, category: d.category, reason: d.reason, opened_by: role(d.opened_by), created_at: d.created_at, resolution_note: d.resolution_note },
    order,
    snapshot: snapshot && { offer: snapshot.snapshot.offer, price: snapshot.snapshot.price, terms: snapshot.snapshot.terms, sha256: snapshot.sha256, captured_at: snapshot.created_at },
    payment,
    risk,
    checklist,
    buyer,
    seller: { ...seller, rates: sellerRates },
    statements,
    facts,
    chain,
    timeline,
  };
}
