import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne } from '../db.js';
import { receiveChargeback } from '../domain/chargebacks.js';
import { withScope } from '../domain/events.js';
import { reviewOwnerProof } from '../domain/offers.js';
import { resolveDispute } from '../domain/orders.js';
import { notFound } from '../lib/errors.js';
import { requireRole } from '../server.js';

const Id = z.object({ id: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  // --- Arbitration -------------------------------------------------------------------
  app.get('/admin/disputes', async (req) => {
    requireRole(req, 'arbiter', 'admin');
    return many(
      ctx.db,
      `SELECT d.*, o.amount_cents, o.currency, o.buyer_id, o.seller_id, r.id AS room_id
         FROM disputes d JOIN orders o ON o.id = d.order_id JOIN chat_rooms r ON r.order_id = o.id
        WHERE d.status = 'open' ORDER BY d.created_at LIMIT 200`,
    );
  });

  app.post('/admin/disputes/:id/resolve', async (req) => {
    const arbiter = requireRole(req, 'arbiter', 'admin');
    const body = z.object({ outcome: z.enum(['buyer', 'seller']), note: z.string().min(3).max(2_000) }).parse(req.body);
    return resolveDispute(ctx, Id.parse(req.params).id, arbiter.id, body.outcome, body.note);
  });

  // --- Fraud review queue ---------------------------------------------------------------
  app.get('/admin/risk-flags', async (req) => {
    requireRole(req, 'admin');
    return many(
      ctx.db,
      `SELECT f.*, u.email, u.display_name, u.withdrawals_frozen FROM risk_flags f JOIN users u ON u.id = f.user_id
        WHERE f.status = 'open' ORDER BY f.score DESC, f.created_at LIMIT 200`,
    );
  });

  /** Clear (false positive: unfreeze) or confirm (fraud: suspend) a flagged user. */
  app.post('/admin/risk-flags/:id/review', async (req) => {
    const admin = requireRole(req, 'admin');
    const { decision } = z.object({ decision: z.enum(['clear', 'confirm']) }).parse(req.body);
    return withScope(ctx, async (s) => {
      const flag = await maybeOne(s.tx, 'SELECT * FROM risk_flags WHERE id = $1 FOR UPDATE', [Id.parse(req.params).id]);
      if (!flag) throw notFound('Risk flag');
      await s.tx.query(`UPDATE risk_flags SET status = $2, reviewed_by = $3 WHERE user_id = $1 AND status = 'open'`, [
        flag.user_id, decision === 'clear' ? 'cleared' : 'confirmed', admin.id,
      ]);
      if (decision === 'clear') {
        await s.tx.query('UPDATE users SET withdrawals_frozen = false WHERE id = $1', [flag.user_id]);
        // Unfreeze escrows that no longer have an open flag on either party.
        await s.tx.query(
          `UPDATE orders o SET escrow_frozen = false
            WHERE (o.seller_id = $1 OR o.buyer_id = $1) AND o.escrow_frozen AND o.status IN ('paid', 'delivered', 'disputed')
              AND NOT EXISTS (SELECT 1 FROM risk_flags f WHERE f.status IN ('open', 'confirmed') AND f.user_id IN (o.buyer_id, o.seller_id))`,
          [flag.user_id],
        );
      } else {
        await s.tx.query(`UPDATE users SET status = 'suspended', suspension_reason = 'fraud_confirmed', withdrawals_frozen = true WHERE id = $1`, [flag.user_id]);
      }
      return { userId: flag.user_id, decision };
    });
  });

  // --- Original Owner Proof review -------------------------------------------------------
  app.get('/admin/owner-proofs', async (req) => {
    requireRole(req, 'arbiter', 'admin');
    return many(
      ctx.db,
      `SELECT p.id, p.offer_id, p.seller_id, p.registration_email, p.registration_date, p.billing_name, p.status, p.created_at,
              u.legal_name AS seller_legal_name, f.title
         FROM owner_proofs p JOIN users u ON u.id = p.seller_id JOIN offers f ON f.id = p.offer_id
        WHERE p.status = 'pending' ORDER BY p.created_at`,
    );
  });

  app.post('/admin/owner-proofs/:id/review', async (req) => {
    const reviewer = requireRole(req, 'arbiter', 'admin');
    const body = z.object({ approve: z.boolean(), note: z.string().max(1_000).optional() }).parse(req.body);
    return reviewOwnerProof(ctx, Id.parse(req.params).id, reviewer.id, body.approve, body.note);
  });

  // --- Chargebacks -------------------------------------------------------------------------
  app.get('/admin/chargebacks', async (req) => {
    requireRole(req, 'admin');
    return many(
      ctx.db,
      `SELECT id, order_id, provider_ref, network, reason_code, category, amount_cents, received_at, respond_by, status, packet_sha256
         FROM chargebacks ORDER BY respond_by LIMIT 200`,
    );
  });

  /** Manual intake (e.g. a chargeback notified by email from an acquirer without webhooks). */
  app.post('/admin/chargebacks', async (req, reply) => {
    requireRole(req, 'admin');
    const body = z
      .object({
        orderId: z.string().uuid(),
        network: z.enum(['visa', 'mastercard']),
        reasonCode: z.string().max(10),
        amountCents: z.number().int().positive(),
        subtype: z.enum(['fraud', 'not_as_described', 'credit_not_processed']).optional(),
        disputeRef: z.string().max(100).optional(),
      })
      .parse(req.body);
    return reply.status(201).send(await receiveChargeback(ctx, body));
  });

  app.get('/admin/chargebacks/:id/packet.pdf', async (req, reply) => {
    requireRole(req, 'admin');
    const row = await maybeOne(ctx.db, 'SELECT packet_pdf FROM chargebacks WHERE id = $1', [Id.parse(req.params).id]);
    if (!row?.packet_pdf) throw notFound('Representment packet');
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'inline; filename="representment.pdf"');
    return reply.send(row.packet_pdf);
  });

  app.post('/admin/users/:id/suspend', async (req) => {
    requireRole(req, 'admin');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    await ctx.db.query(`UPDATE users SET status = 'suspended', suspension_reason = $2 WHERE id = $1`, [Id.parse(req.params).id, reason]);
    return { suspended: true };
  });

  app.get('/admin/ledger/summary', async (req) => {
    requireRole(req, 'admin');
    return many(
      ctx.db,
      `SELECT a.kind, a.currency, COALESCE(SUM(e.amount_cents), 0)::bigint AS balance_cents
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_id IS NULL GROUP BY a.kind, a.currency ORDER BY a.kind`,
    );
  });
}
