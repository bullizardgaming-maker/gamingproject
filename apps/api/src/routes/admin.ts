import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne } from '../db.js';
import { receiveChargeback } from '../domain/chargebacks.js';
import { withScope } from '../domain/events.js';
import { reviewOwnerProof } from '../domain/offers.js';
import { resolveDispute } from '../domain/orders.js';
import { setReviewHidden } from '../domain/reviews.js';
import { runReconciliation } from '../domain/reconciliation.js';
import { notFound } from '../lib/errors.js';
import { requireRole } from '../server.js';
import { audit, listAudit } from '../domain/audit.js';
import { createPromo, listPromos, setPromoActive } from '../domain/promos.js';
import { withdrawable } from '../domain/payoutholds.js';
import { retentionPolicy, runRetention } from '../domain/retention.js';
import { keyStatus, rotateAll } from '../domain/keyrotation.js';
import { setRate, taxReport } from '../domain/tax.js';
import { fxPosition, recordConversion } from '../domain/sellerfx.js';
import { getInvoice, invoicePdf, issueMonthlyInvoices } from '../domain/invoices.js';
import { decideAdjustment, listAdjustments, requestAdjustment, userLedger } from '../domain/adjustments.js';
import { decideTreasuryWithdrawal, listTreasuryWithdrawals, requestTreasuryWithdrawal, treasuryBalance } from '../domain/treasury.js';

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
    const { id } = Id.parse(req.params);
    const res = await resolveDispute(ctx, id, arbiter.id, body.outcome, body.note);
    await audit(ctx.db, req, 'dispute.resolve', { type: 'dispute', id }, body);
    return res;
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
      await audit(s.tx, req, `risk_flag.${decision}`, { type: 'user', id: flag.user_id }, { flagId: flag.id, score: flag.score });
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
    const { id } = Id.parse(req.params);
    const res = await reviewOwnerProof(ctx, id, reviewer.id, body.approve, body.note);
    await audit(ctx.db, req, 'owner_proof.review', { type: 'owner_proof', id }, { ...body, result: res.status });
    return res;
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
    const cb = await receiveChargeback(ctx, body);
    await audit(ctx.db, req, 'chargeback.create', { type: 'order', id: body.orderId }, body);
    return reply.status(201).send(cb);
  });

  app.get('/admin/chargebacks/:id/packet.pdf', async (req, reply) => {
    requireRole(req, 'admin');
    const { id } = Id.parse(req.params);
    const row = await maybeOne(ctx.db, 'SELECT packet_pdf FROM chargebacks WHERE id = $1', [id]);
    if (!row?.packet_pdf) throw notFound('Representment packet');
    await audit(ctx.db, req, 'chargeback.packet_viewed', { type: 'chargeback', id });
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'inline; filename="representment.pdf"');
    return reply.send(row.packet_pdf);
  });

  app.post('/admin/reviews/:id/hide', async (req) => {
    requireRole(req, 'arbiter', 'admin');
    const body = z.object({ hidden: z.boolean().default(true), reason: z.string().min(3).max(200) }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await setReviewHidden(ctx, id, body.hidden, body.reason);
    await audit(ctx.db, req, body.hidden ? 'review.hide' : 'review.unhide', { type: 'review', id }, body);
    return res;
  });

  app.post('/admin/users/:id/suspend', async (req) => {
    requireRole(req, 'admin');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const { id } = Id.parse(req.params);
    await ctx.db.query(`UPDATE users SET status = 'suspended', suspension_reason = $2 WHERE id = $1`, [id, reason]);
    await audit(ctx.db, req, 'user.suspend', { type: 'user', id }, { reason });
    return { suspended: true };
  });

  app.get('/admin/reconciliation', async (req) => {
    requireRole(req, 'admin');
    return many(ctx.db, 'SELECT id, started_at, finished_at, status, report FROM reconciliation_runs ORDER BY started_at DESC LIMIT 30');
  });

  app.post('/admin/reconciliation/run', async (req) => {
    requireRole(req, 'admin');
    const run = await runReconciliation(ctx);
    await audit(ctx.db, req, 'reconciliation.run', { type: 'reconciliation_run', id: run.id }, { status: run.status });
    return run;
  });

  // --- Promo codes --------------------------------------------------------------------------
  app.get('/admin/promos', async (req) => {
    requireRole(req, 'admin');
    return listPromos(ctx);
  });
  app.post('/admin/promos', async (req, reply) => {
    const admin = requireRole(req, 'admin');
    const body = z
      .object({
        code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
        description: z.string().max(200).optional(),
        percentOff: z.number().int().min(1).max(100).optional(),
        amountOffCents: z.number().int().positive().optional(),
        maxDiscountCents: z.number().int().positive().optional(),
        minOrderCents: z.number().int().min(0).optional(),
        categories: z.array(z.string()).min(1).optional(),
        firstOrderOnly: z.boolean().optional(),
        maxRedemptions: z.number().int().positive().optional(),
        perUserLimit: z.number().int().positive().optional(),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
      })
      .parse(req.body);
    const promo = await createPromo(ctx, admin.id, body);
    await audit(ctx.db, req, 'promo.create', { type: 'promo_code', id: promo.id }, body);
    return reply.status(201).send(promo);
  });
  app.patch('/admin/promos/:id', async (req) => {
    requireRole(req, 'admin');
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await setPromoActive(ctx, id, active);
    await audit(ctx.db, req, active ? 'promo.activate' : 'promo.deactivate', { type: 'promo_code', id });
    return res;
  });

  // --- Platform earnings (four-eyes) ------------------------------------------------------
  app.get('/admin/treasury', async (req) => {
    requireRole(req, 'admin');
    return { balance: await treasuryBalance(ctx), withdrawals: await listTreasuryWithdrawals(ctx) };
  });
  app.post('/admin/treasury/withdrawals', async (req, reply) => {
    const admin = requireRole(req, 'admin');
    const body = z
      .object({ amountCents: z.number().int().positive(), note: z.string().trim().min(3).max(300), source: z.enum(['treasury', 'tax_payable']).default('treasury') })
      .parse(req.body);
    const w = await requestTreasuryWithdrawal(ctx, admin.id, body.amountCents, body.note, ctx.cfg.SETTLEMENT_CURRENCY, body.source);
    await audit(ctx.db, req, 'treasury.withdrawal_requested', { type: 'treasury_withdrawal', id: w.id }, body);
    return reply.status(201).send(w);
  });
  app.post('/admin/treasury/withdrawals/:id/decide', async (req) => {
    const admin = requireRole(req, 'admin');
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await decideTreasuryWithdrawal(ctx, id, admin.id, approve);
    await audit(ctx.db, req, approve ? 'treasury.withdrawal_approved' : 'treasury.withdrawal_rejected', { type: 'treasury_withdrawal', id });
    return res;
  });

  // --- Manual ledger corrections (four-eyes) -------------------------------------------
  const AdjustmentLine = z.object({
    kind: z.enum(['gateway_clearing', 'escrow', 'treasury', 'reserve', 'seller_available', 'payouts', 'platform_withdrawals', 'user_credit', 'fx_pnl', 'tax_payable', 'fx_position', 'fx_conversion']),
    ownerId: z.string().uuid().nullable().default(null),
    currency: z.string().length(3).toUpperCase().default(ctx.cfg.SETTLEMENT_CURRENCY),
    amountCents: z.number().int(),
  });
  app.get('/admin/ledger/adjustments', async (req) => {
    requireRole(req, 'admin');
    return listAdjustments(ctx);
  });
  app.post('/admin/ledger/adjustments', async (req, reply) => {
    const admin = requireRole(req, 'admin');
    const body = z.object({ reason: z.string().trim().min(10).max(1_000), orderId: z.string().uuid().optional(), lines: z.array(AdjustmentLine).min(2).max(10) }).parse(req.body);
    const a = await requestAdjustment(ctx, admin.id, body);
    await audit(ctx.db, req, 'ledger.adjustment_requested', { type: 'ledger_adjustment', id: a.id }, body);
    return reply.status(201).send(a);
  });
  app.post('/admin/ledger/adjustments/:id/decide', async (req) => {
    const admin = requireRole(req, 'admin');
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await decideAdjustment(ctx, id, admin.id, approve);
    await audit(ctx.db, req, approve ? 'ledger.adjustment_posted' : 'ledger.adjustment_rejected', { type: 'ledger_adjustment', id });
    return res;
  });
  app.get('/admin/users/:id/ledger', async (req) => {
    requireRole(req, 'admin');
    const { id } = Id.parse(req.params);
    await audit(ctx.db, req, 'ledger.user_viewed', { type: 'user', id });
    return userLedger(ctx, id);
  });

  app.put('/admin/users/:id/payout-hold', async (req) => {
    requireRole(req, 'admin');
    const { id } = Id.parse(req.params);
    const { days, reason } = z.object({ days: z.number().int().min(0).max(90).nullable(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    await ctx.db.query('UPDATE users SET payout_hold_days = $2 WHERE id = $1', [id, days]);
    await audit(ctx.db, req, 'user.payout_hold_set', { type: 'user', id }, { days, reason });
    return withdrawable(ctx, ctx.db, id);
  });

  // --- Encryption keys & escrow signer --------------------------------------------------
  app.get('/admin/keys', async (req) => {
    requireRole(req, 'admin');
    return {
      data: await keyStatus(ctx),
      escrowSigner: ctx.escrowSigner ? { kind: ctx.escrowSigner.kind, address: await ctx.escrowSigner.address() } : null,
    };
  });
  app.post('/admin/keys/rotate', async (req) => {
    requireRole(req, 'admin');
    const reencrypted = await rotateAll(ctx);
    await audit(ctx.db, req, 'keys.rotated', { type: 'keyring', id: null }, { current: ctx.keyring.currentVersion, reencrypted });
    return { reencrypted, status: await keyStatus(ctx) };
  });

  // --- Currency position (sellers paid in EUR/GBP) ---------------------------------------
  app.get('/admin/fx/position', async (req) => {
    requireRole(req, 'admin');
    return { positions: await fxPosition(ctx), conversions: await many(ctx.db, 'SELECT * FROM fx_conversions ORDER BY created_at DESC LIMIT 50') };
  });
  app.post('/admin/fx/conversions', async (req, reply) => {
    const admin = requireRole(req, 'admin');
    const body = z
      .object({ fromCurrency: z.string().length(3), fromCents: z.number().int().positive(), toCurrency: z.string().length(3), toCents: z.number().int().positive(), reference: z.string().trim().min(3).max(200) })
      .parse(req.body);
    const row = await recordConversion(ctx, admin.id, body);
    await audit(ctx.db, req, 'fx.conversion_recorded', { type: 'fx_conversion', id: row.id }, body);
    return reply.status(201).send(row);
  });

  // --- Tax ------------------------------------------------------------------------------
  app.get('/admin/tax/report', async (req, reply) => {
    requireRole(req, 'admin');
    const q = z.object({ from: z.string().date(), to: z.string().date(), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const rows = await taxReport(ctx, q.from, q.to);
    if (q.format === 'json') return rows;
    const cols = ['country', 'treatment', 'rate_bps', 'currency', 'orders', 'commission_gross_cents', 'tax_cents', 'commission_net_cents'];
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', `attachment; filename="tax-${q.from}-${q.to}.csv"`);
    return [cols.join(','), ...rows.map((r: any) => cols.map((c) => r[c] ?? '').join(','))].join('\n');
  });
  app.get('/admin/tax/rates', async (req) => {
    requireRole(req, 'admin');
    return many(ctx.db, 'SELECT * FROM tax_rates ORDER BY country, valid_from DESC');
  });
  app.put('/admin/tax/rates', async (req) => {
    requireRole(req, 'admin');
    const body = z
      .object({ country: z.string().length(2), rateBps: z.number().int().min(0).max(5000), name: z.string().trim().min(1).max(20).default('VAT'), validFrom: z.string().date() })
      .parse(req.body);
    const row = await setRate(ctx, body.country, body.rateBps, body.name, body.validFrom);
    await audit(ctx.db, req, 'tax.rate_set', { type: 'tax_rate', id: null }, body);
    return row;
  });
  app.post('/admin/invoices/issue', async (req) => {
    requireRole(req, 'admin');
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
    const res = await issueMonthlyInvoices(ctx, `${month}-01`);
    await audit(ctx.db, req, 'invoices.issued', { type: 'invoice_period', id: null }, { month, count: res.issued.length });
    return res;
  });
  app.get('/admin/invoices/:id/pdf', async (req, reply) => {
    requireRole(req, 'admin');
    const inv = await getInvoice(ctx, Id.parse(req.params).id, null);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    return reply.send(await invoicePdf(inv));
  });

  app.get('/admin/retention', async (req) => {
    requireRole(req, 'admin');
    return { policy: retentionPolicy(ctx), runs: await many(ctx.db, 'SELECT * FROM retention_runs ORDER BY started_at DESC LIMIT 30') };
  });
  app.post('/admin/retention/run', async (req) => {
    requireRole(req, 'admin');
    const res = await runRetention(ctx);
    await audit(ctx.db, req, 'retention.run', { type: 'retention_run', id: res.id }, res.counts);
    return res;
  });

  app.get('/admin/audit', async (req) => {
    requireRole(req, 'admin');
    const f = z
      .object({
        actor: z.string().uuid().optional(),
        targetType: z.string().max(40).optional(),
        targetId: z.string().max(100).optional(),
        action: z.string().max(60).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return listAudit(ctx, { ...f, actorId: f.actor });
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
