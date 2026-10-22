import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { appendMessage } from './chat.js';
import { refundAfterRelease, type RefundPayer } from './clawback.js';
import { withScope, type TxScope } from './events.js';
import { notify } from './notifications.js';
import { lockOrder, roomOf } from './orders.js';

/**
 * Account warranty claims (migration 046). A seller may give an account listing a warranty that
 * runs on after escrow releases. Within it the buyer can claim the account was pulled back,
 * banned or locked. The seller has 48 hours to fix it (the buyer then confirms), refund, or
 * contest; silence or a contested claim goes to an arbiter, who refunds from the seller's held
 * payout or rejects. Every step is a system message in the order chat.
 */
export const WARRANTY_DAYS = [0, 7, 14, 30, 60, 90] as const;
export const CLAIM_REASONS = ['recovered', 'banned', 'locked', 'other'] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];
export const SELLER_RESPONSE_HOURS = 48;
export const BUYER_CONFIRM_HOURS = 72;

const REASON_TEXT: Record<ClaimReason, string> = {
  recovered: 'the account was taken back by its original owner',
  banned: 'the account was banned',
  locked: 'the account is locked',
  other: 'the account stopped working',
};

const OPEN = ['open', 'seller_fixed', 'escalated'];

async function system(s: TxScope, orderId: string, text: string) {
  const room = await roomOf(s.tx, orderId);
  await appendMessage(s, room.id, null, 'system', text);
}

async function update(s: TxScope, claim: any, status: string, title: string, extra: Record<string, unknown> = {}) {
  const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 3}`);
  await s.tx.query(`UPDATE warranty_claims SET status = $2, updated_at = now()${sets.map((x) => `, ${x}`).join('')} WHERE id = $1`, [claim.id, status, ...Object.values(extra)]);
  for (const uid of [claim.buyer_id, claim.seller_id]) {
    s.notifyUser(uid, 'order.updated', { orderId: claim.order_id });
    await notify(s.tx, uid, 'warranty_update', { order_id: claim.order_id, title, status, role: uid === claim.buyer_id ? 'buyer' : 'seller' }, `warranty:${claim.id}:${status}:${uid}`);
  }
}

async function lockClaim(s: TxScope, claimId: string) {
  const c = await maybeOne<any>(
    s.tx,
    `SELECT c.*, f.title FROM warranty_claims c JOIN orders o ON o.id = c.order_id JOIN offers f ON f.id = o.offer_id WHERE c.id = $1 FOR UPDATE OF c`,
    [claimId],
  );
  if (!c) throw notFound('Warranty claim');
  return c;
}

export async function claimsForOrder(q: Queryable, orderId: string) {
  return many(q, 'SELECT id, reason, details, status, seller_message, respond_by, confirm_by, decision_note, created_at, updated_at FROM warranty_claims WHERE order_id = $1 ORDER BY created_at DESC', [orderId]);
}

export async function openClaim(ctx: Ctx, buyerId: string, orderId: string, input: { reason: ClaimReason; details: string }) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.buyer_id !== buyerId) throw forbidden('not_buyer', 'Only the buyer can claim on the warranty');
    const o = order as any;
    if (order.status !== 'completed' || !o.warranty_ends_at) throw conflict('no_warranty', 'This order has no warranty');
    if (new Date(o.warranty_ends_at) <= new Date()) throw conflict('warranty_expired', 'The warranty on this order has ended');
    if (await maybeOne(s.tx, `SELECT 1 FROM warranty_claims WHERE order_id = $1 AND status = ANY($2)`, [orderId, OPEN])) {
      throw conflict('claim_open', 'There is already an open claim on this order');
    }
    const claim = await one(
      s.tx,
      `INSERT INTO warranty_claims (order_id, buyer_id, seller_id, reason, details, respond_by)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING *`,
      [orderId, buyerId, order.seller_id, input.reason, input.details, SELLER_RESPONSE_HOURS],
    );
    await system(s, orderId, `Warranty claim: the buyer says ${REASON_TEXT[input.reason]}. The seller has ${SELLER_RESPONSE_HOURS} hours to fix it, refund, or contest it.`);
    s.notifyUser(order.seller_id, 'order.updated', { orderId });
    const { title } = await one<{ title: string }>(s.tx, 'SELECT title FROM offers WHERE id = $1', [order.offer_id]);
    await notify(s.tx, order.seller_id, 'warranty_claim', { order_id: orderId, title, reason: input.reason, hours: SELLER_RESPONSE_HOURS }, `warranty:${claim.id}:opened`);
    return claim;
  });
}

/** Seller's answer: it's fixed (buyer confirms), refund the buyer, or contest (an arbiter decides). */
export async function sellerRespond(ctx: Ctx, sellerId: string, claimId: string, input: { action: 'fixed' | 'refund' | 'contest'; message?: string }) {
  const claim = await withScope(ctx, async (s) => {
    const c = await lockClaim(s, claimId);
    if (c.seller_id !== sellerId) throw forbidden('not_seller', 'Only the seller can answer this claim');
    if (c.status !== 'open') throw conflict('claim_not_open', 'This claim is no longer waiting for the seller');
    if (input.action === 'fixed') {
      await update(s, c, 'seller_fixed', c.title, { seller_message: input.message ?? null, confirm_by: new Date(Date.now() + BUYER_CONFIRM_HOURS * 3_600_000) });
      await system(s, c.order_id, `The seller says the account is working again${input.message ? `: "${input.message}"` : ''}. The buyer has ${BUYER_CONFIRM_HOURS} hours to confirm or send it to an arbiter.`);
    } else if (input.action === 'contest') {
      await update(s, c, 'escalated', c.title, { seller_message: input.message ?? null });
      await system(s, c.order_id, `The seller contests the warranty claim${input.message ? `: "${input.message}"` : ''}. An arbiter will decide.`);
    }
    return c;
  });
  if (input.action === 'refund') {
    // The seller pays: clawed back from their balance (the warranty kept this order's payout on hold).
    const refund = await refundAfterRelease(ctx, claim.order_id, sellerId, { paidBy: 'seller', reason: 'warranty claim accepted by the seller' });
    await withScope(ctx, async (s) => {
      const c = await lockClaim(s, claimId);
      await update(s, c, 'refunded', c.title, { refund_id: refund.refund.id, seller_message: input.message ?? null });
    });
  }
  return maybeOne(ctx.db, 'SELECT * FROM warranty_claims WHERE id = $1', [claimId]);
}

/** Buyer: confirm the seller's fix, send it to an arbiter instead, or withdraw the claim. */
export async function buyerRespond(ctx: Ctx, buyerId: string, claimId: string, action: 'confirm' | 'escalate' | 'withdraw') {
  return withScope(ctx, async (s) => {
    const c = await lockClaim(s, claimId);
    if (c.buyer_id !== buyerId) throw forbidden('not_buyer', 'Only the buyer can do this');
    if (action === 'withdraw') {
      if (!OPEN.includes(c.status)) throw conflict('claim_closed', 'This claim is already closed');
      await update(s, c, 'withdrawn', c.title);
      await system(s, c.order_id, 'The buyer withdrew the warranty claim.');
    } else {
      if (c.status !== 'seller_fixed') throw conflict('nothing_to_confirm', 'The seller hasn’t reported a fix yet');
      if (action === 'confirm') {
        await update(s, c, 'resolved', c.title);
        await system(s, c.order_id, 'The buyer confirmed the account works again. Warranty claim resolved.');
      } else {
        await update(s, c, 'escalated', c.title);
        await system(s, c.order_id, 'The buyer says the account still doesn’t work. An arbiter will decide.');
      }
    }
    return maybeOne(s.tx, 'SELECT * FROM warranty_claims WHERE id = $1', [claimId]);
  });
}

/** Arbiter's decision on an escalated claim: refund (all or part; who pays) or reject. */
export async function decideClaim(
  ctx: Ctx,
  staffId: string,
  claimId: string,
  input: { outcome: 'refund' | 'reject'; note: string; amountCents?: number; paidBy?: RefundPayer },
) {
  const c = await withScope(ctx, async (s) => {
    const c = await lockClaim(s, claimId);
    if (c.status !== 'escalated') throw conflict('not_escalated', 'Only claims sent to an arbiter can be decided here');
    if (input.outcome === 'reject') {
      await update(s, c, 'rejected', c.title, { decided_by: staffId, decision_note: input.note });
      await system(s, c.order_id, `An arbiter rejected the warranty claim: "${input.note}"`);
    }
    return c;
  });
  if (input.outcome === 'refund') {
    if (input.amountCents != null && input.amountCents <= 0) throw badRequest('invalid_amount', 'Refund amount must be positive');
    const refund = await refundAfterRelease(ctx, c.order_id, staffId, { amountCents: input.amountCents, paidBy: input.paidBy ?? 'seller', reason: `warranty claim: ${input.note}` });
    await withScope(ctx, async (s) => {
      const cur = await lockClaim(s, claimId);
      await update(s, cur, 'refunded', cur.title, { decided_by: staffId, decision_note: input.note, refund_id: refund.refund.id });
    });
  }
  return maybeOne(ctx.db, 'SELECT * FROM warranty_claims WHERE id = $1', [claimId]);
}

/** Staff queue: claims waiting for an arbiter, oldest first. */
export async function escalatedClaims(q: Queryable) {
  return many(
    q,
    `SELECT c.*, f.title, o.amount_cents, o.currency, o.warranty_ends_at, b.display_name AS buyer_name, sl.display_name AS seller_name
       FROM warranty_claims c JOIN orders o ON o.id = c.order_id JOIN offers f ON f.id = o.offer_id
       JOIN users b ON b.id = c.buyer_id JOIN users sl ON sl.id = c.seller_id
      WHERE c.status = 'escalated' ORDER BY c.updated_at LIMIT 200`,
  );
}

/** Worker: a seller who doesn't answer in time sends the claim to an arbiter; an unconfirmed fix stands. */
export async function expireClaims(ctx: Ctx) {
  const due = await many<{ id: string; status: string }>(
    ctx.db,
    `SELECT id, status FROM warranty_claims WHERE (status = 'open' AND respond_by < now()) OR (status = 'seller_fixed' AND confirm_by < now()) LIMIT 200`,
  );
  for (const d of due) {
    await withScope(ctx, async (s) => {
      const c = await lockClaim(s, d.id);
      if (c.status === 'open' && new Date(c.respond_by) < new Date()) {
        await update(s, c, 'escalated', c.title);
        await system(s, c.order_id, `The seller didn’t answer the warranty claim within ${SELLER_RESPONSE_HOURS} hours. An arbiter will decide.`);
      } else if (c.status === 'seller_fixed' && c.confirm_by && new Date(c.confirm_by) < new Date()) {
        await update(s, c, 'resolved', c.title);
        await system(s, c.order_id, `The buyer didn’t reply within ${BUYER_CONFIRM_HOURS} hours, so the seller’s fix stands. Warranty claim resolved.`);
      }
    });
  }
  return due.length;
}
