import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { receiveChargeback } from '../domain/chargebacks.js';
import { withScope } from '../domain/events.js';
import { reviewOwnerProof } from '../domain/offers.js';
import { resolveDispute } from '../domain/orders.js';
import { setReviewHidden } from '../domain/reviews.js';
import { runReconciliation } from '../domain/reconciliation.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ROLE_PERMISSIONS, STAFF_ROLES, permissionsOf, rolesOf } from '../domain/permissions.js';
import { notify } from '../domain/notifications.js';
import { refundAfterRelease } from '../domain/clawback.js';
import { addNote, decideCase, getCase, listCases, openCase, refreshLists, rescreenSellers, runMonitoring, screenUser } from '../domain/aml.js';
import { collectDebts, listDebts } from '../domain/debts.js';
import { fraudModelReport } from '../domain/fraud.js';
import { COMPONENTS, COMPONENT_IDS, createIncident, listIncidents, updateIncident } from '../domain/status.js';
import { decideTopUp, listTopUps, planTopUps } from '../domain/fxtopups.js';
import { chatLegalHold, shredUserChatKey } from '../domain/chatkeys.js';
import { businessMetrics } from '../domain/analytics.js';
import { getTicket, staffReply, ticketQueue, updateTicket } from '../domain/support.js';
import { requirePermission } from '../server.js';
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
    requirePermission(req, 'disputes.manage');
    return many(
      ctx.db,
      `SELECT d.*, o.amount_cents, o.currency, o.buyer_id, o.seller_id, r.id AS room_id
         FROM disputes d JOIN orders o ON o.id = d.order_id JOIN chat_rooms r ON r.order_id = o.id
        WHERE d.status = 'open' ORDER BY d.created_at LIMIT 200`,
    );
  });

  app.post('/admin/disputes/:id/resolve', async (req) => {
    const arbiter = requirePermission(req, 'disputes.manage');
    const body = z.object({ outcome: z.enum(['buyer', 'seller']), note: z.string().min(3).max(2_000) }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await resolveDispute(ctx, id, arbiter.id, body.outcome, body.note);
    await audit(ctx.db, req, 'dispute.resolve', { type: 'dispute', id }, body);
    return res;
  });

  // --- Fraud review queue ---------------------------------------------------------------
  app.get('/admin/risk-flags', async (req) => {
    requirePermission(req, 'risk.review');
    return many(
      ctx.db,
      `SELECT f.*, u.email, u.display_name, u.withdrawals_frozen FROM risk_flags f JOIN users u ON u.id = f.user_id
        WHERE f.status = 'open' ORDER BY f.score DESC, f.created_at LIMIT 200`,
    );
  });

  /** Clear (false positive: unfreeze) or confirm (fraud: suspend) a flagged user. */
  app.post('/admin/risk-flags/:id/review', async (req) => {
    const admin = requirePermission(req, 'risk.review');
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
    requirePermission(req, 'owner_proofs.review');
    return many(
      ctx.db,
      `SELECT p.id, p.offer_id, p.seller_id, p.registration_email, p.registration_date, p.billing_name, p.status, p.created_at,
              u.legal_name AS seller_legal_name, f.title
         FROM owner_proofs p JOIN users u ON u.id = p.seller_id JOIN offers f ON f.id = p.offer_id
        WHERE p.status = 'pending' ORDER BY p.created_at`,
    );
  });

  app.post('/admin/owner-proofs/:id/review', async (req) => {
    const reviewer = requirePermission(req, 'owner_proofs.review');
    const body = z.object({ approve: z.boolean(), note: z.string().max(1_000).optional() }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await reviewOwnerProof(ctx, id, reviewer.id, body.approve, body.note);
    await audit(ctx.db, req, 'owner_proof.review', { type: 'owner_proof', id }, { ...body, result: res.status });
    return res;
  });

  // --- Chargebacks -------------------------------------------------------------------------
  app.get('/admin/chargebacks', async (req) => {
    requirePermission(req, 'chargebacks.manage');
    return many(
      ctx.db,
      `SELECT id, order_id, provider_ref, network, reason_code, category, amount_cents, received_at, respond_by, status, packet_sha256
         FROM chargebacks ORDER BY respond_by LIMIT 200`,
    );
  });

  /** Manual intake (e.g. a chargeback notified by email from an acquirer without webhooks). */
  app.post('/admin/chargebacks', async (req, reply) => {
    requirePermission(req, 'chargebacks.manage');
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
    requirePermission(req, 'chargebacks.manage');
    const { id } = Id.parse(req.params);
    const row = await maybeOne(ctx.db, 'SELECT packet_pdf FROM chargebacks WHERE id = $1', [id]);
    if (!row?.packet_pdf) throw notFound('Representment packet');
    await audit(ctx.db, req, 'chargeback.packet_viewed', { type: 'chargeback', id });
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'inline; filename="representment.pdf"');
    return reply.send(row.packet_pdf);
  });

  app.post('/admin/reviews/:id/hide', async (req) => {
    requirePermission(req, 'reviews.moderate');
    const body = z.object({ hidden: z.boolean().default(true), reason: z.string().min(3).max(200) }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await setReviewHidden(ctx, id, body.hidden, body.reason);
    await audit(ctx.db, req, body.hidden ? 'review.hide' : 'review.unhide', { type: 'review', id }, body);
    return res;
  });

  app.post('/admin/users/:id/suspend', async (req) => {
    requirePermission(req, 'users.suspend');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const { id } = Id.parse(req.params);
    await ctx.db.query(`UPDATE users SET status = 'suspended', suspension_reason = $2 WHERE id = $1`, [id, reason]);
    await audit(ctx.db, req, 'user.suspend', { type: 'user', id }, { reason });
    return { suspended: true };
  });

  app.get('/admin/reconciliation', async (req) => {
    requirePermission(req, 'reconciliation.run');
    return many(ctx.db, 'SELECT id, started_at, finished_at, status, report FROM reconciliation_runs ORDER BY started_at DESC LIMIT 30');
  });

  app.post('/admin/reconciliation/run', async (req) => {
    requirePermission(req, 'reconciliation.run');
    const run = await runReconciliation(ctx);
    await audit(ctx.db, req, 'reconciliation.run', { type: 'reconciliation_run', id: run.id }, { status: run.status });
    return run;
  });

  // --- Promo codes --------------------------------------------------------------------------
  app.get('/admin/promos', async (req) => {
    requirePermission(req, 'promos.manage');
    return listPromos(ctx);
  });
  app.post('/admin/promos', async (req, reply) => {
    const admin = requirePermission(req, 'promos.manage');
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
    requirePermission(req, 'promos.manage');
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await setPromoActive(ctx, id, active);
    await audit(ctx.db, req, active ? 'promo.activate' : 'promo.deactivate', { type: 'promo_code', id });
    return res;
  });

  // --- Platform earnings (four-eyes) ------------------------------------------------------
  app.get('/admin/treasury', async (req) => {
    requirePermission(req, 'treasury.request');
    return { balance: await treasuryBalance(ctx), withdrawals: await listTreasuryWithdrawals(ctx) };
  });
  app.post('/admin/treasury/withdrawals', async (req, reply) => {
    const admin = requirePermission(req, 'treasury.request');
    const body = z
      .object({ amountCents: z.number().int().positive(), note: z.string().trim().min(3).max(300), source: z.enum(['treasury', 'tax_payable']).default('treasury') })
      .parse(req.body);
    const w = await requestTreasuryWithdrawal(ctx, admin.id, body.amountCents, body.note, ctx.cfg.SETTLEMENT_CURRENCY, body.source);
    await audit(ctx.db, req, 'treasury.withdrawal_requested', { type: 'treasury_withdrawal', id: w.id }, body);
    return reply.status(201).send(w);
  });
  app.post('/admin/treasury/withdrawals/:id/decide', async (req) => {
    const admin = requirePermission(req, 'treasury.approve');
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
  // --- Status page incidents ------------------------------------------------------------
  app.get('/admin/incidents', async (req) => {
    requirePermission(req, 'status.manage');
    return { components: COMPONENT_IDS.map((id) => ({ id, name: COMPONENTS[id].name })), incidents: await listIncidents(ctx) };
  });
  app.post('/admin/incidents', async (req, reply) => {
    const staff = requirePermission(req, 'status.manage');
    const body = z
      .object({
        kind: z.enum(['incident', 'maintenance']).default('incident'),
        title: z.string().trim().min(5).max(140),
        impact: z.enum(['minor', 'major', 'critical']).default('minor'),
        components: z.array(z.string()).max(20).default([]),
        body: z.string().trim().min(5).max(4_000),
        scheduledStart: z.string().datetime().optional(),
        scheduledEnd: z.string().datetime().optional(),
        notify: z.boolean().default(true),
      })
      .parse(req.body);
    const incident: any = await createIncident(ctx, staff.id, body);
    await audit(ctx.db, req, 'status.incident_created', { type: 'incident', id: incident.id }, { title: body.title, kind: body.kind });
    return reply.status(201).send(incident);
  });
  app.post('/admin/incidents/:id/updates', async (req) => {
    const staff = requirePermission(req, 'status.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ status: z.string(), body: z.string().trim().min(3).max(4_000), impact: z.enum(['none', 'minor', 'major', 'critical']).optional(), notify: z.boolean().default(true) })
      .parse(req.body);
    const incident = await updateIncident(ctx, staff.id, id, body);
    await audit(ctx.db, req, 'status.incident_updated', { type: 'incident', id }, { status: body.status });
    return incident;
  });

  // --- Fraud model evaluation -------------------------------------------------------------
  app.get('/admin/fraud/model-report', async (req) => {
    requirePermission(req, 'risk.review');
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(730).default(180) }).parse(req.query);
    return fraudModelReport(ctx, days);
  });

  // --- Seller debts ---------------------------------------------------------------------
  app.get('/admin/debts', async (req) => {
    requirePermission(req, 'ledger.view');
    const { status } = z.object({ status: z.enum(['open', 'closed']).default('open') }).parse(req.query);
    return listDebts(ctx, status);
  });
  app.post('/admin/debts/run', async (req) => {
    requirePermission(req, 'ledger.adjust');
    const r = await collectDebts(ctx);
    await audit(ctx.db, req, 'debts.collection_run', { type: 'seller_debts', id: 'all' }, r);
    return r;
  });

  app.get('/admin/ledger/adjustments', async (req) => {
    requirePermission(req, 'ledger.adjust');
    return listAdjustments(ctx);
  });
  app.post('/admin/ledger/adjustments', async (req, reply) => {
    const admin = requirePermission(req, 'ledger.adjust');
    const body = z.object({ reason: z.string().trim().min(10).max(1_000), orderId: z.string().uuid().optional(), lines: z.array(AdjustmentLine).min(2).max(10) }).parse(req.body);
    const a = await requestAdjustment(ctx, admin.id, body);
    await audit(ctx.db, req, 'ledger.adjustment_requested', { type: 'ledger_adjustment', id: a.id }, body);
    return reply.status(201).send(a);
  });
  app.post('/admin/ledger/adjustments/:id/decide', async (req) => {
    const admin = requirePermission(req, 'ledger.adjust');
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const { id } = Id.parse(req.params);
    const res = await decideAdjustment(ctx, id, admin.id, approve);
    await audit(ctx.db, req, approve ? 'ledger.adjustment_posted' : 'ledger.adjustment_rejected', { type: 'ledger_adjustment', id });
    return res;
  });
  app.get('/admin/users/:id/ledger', async (req) => {
    requirePermission(req, 'ledger.view');
    const { id } = Id.parse(req.params);
    await audit(ctx.db, req, 'ledger.user_viewed', { type: 'user', id });
    return userLedger(ctx, id);
  });

  app.put('/admin/users/:id/payout-hold', async (req) => {
    requirePermission(req, 'payout_holds.set');
    const { id } = Id.parse(req.params);
    const { days, reason } = z.object({ days: z.number().int().min(0).max(90).nullable(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    await ctx.db.query('UPDATE users SET payout_hold_days = $2 WHERE id = $1', [id, days]);
    await audit(ctx.db, req, 'user.payout_hold_set', { type: 'user', id }, { days, reason });
    return withdrawable(ctx, ctx.db, id);
  });

  // --- Encryption keys & escrow signer --------------------------------------------------
  app.get('/admin/keys', async (req) => {
    requirePermission(req, 'keys.manage');
    return {
      data: await keyStatus(ctx),
      escrowSigner: ctx.escrowSigner ? { kind: ctx.escrowSigner.kind, address: await ctx.escrowSigner.address() } : null,
    };
  });
  app.post('/admin/keys/rotate', async (req) => {
    requirePermission(req, 'keys.manage');
    const reencrypted = await rotateAll(ctx);
    await audit(ctx.db, req, 'keys.rotated', { type: 'keyring', id: null }, { current: ctx.keyring.currentVersion, reencrypted });
    return { reencrypted, status: await keyStatus(ctx) };
  });

  // --- Currency position (sellers paid in EUR/GBP) ---------------------------------------
  app.get('/admin/fx/position', async (req) => {
    requirePermission(req, 'fx.manage');
    return { positions: await fxPosition(ctx), conversions: await many(ctx.db, 'SELECT * FROM fx_conversions ORDER BY created_at DESC LIMIT 50') };
  });
  // --- Support queue ------------------------------------------------------------------------
  app.get('/admin/support/tickets', async (req) => {
    const staff = requirePermission(req, 'support.manage');
    const f = z.object({ status: z.enum(['active', 'open', 'pending', 'resolved']).optional(), mine: z.enum(['true', 'false']).optional() }).parse(req.query);
    return ticketQueue(ctx.db, { status: f.status, assignedTo: f.mine === 'true' ? staff.id : undefined });
  });
  app.get('/admin/support/tickets/:id', async (req) => {
    const staff = requirePermission(req, 'support.manage');
    return getTicket(ctx.db, z.object({ id: z.string().uuid() }).parse(req.params).id, { id: staff.id, staff: true });
  });
  app.post('/admin/support/tickets/:id/messages', async (req) => {
    const staff = requirePermission(req, 'support.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ body: z.string().trim().min(1).max(5_000), internal: z.boolean().default(false), resolve: z.boolean().default(false) }).parse(req.body);
    await withTx(ctx.db, async (tx) => {
      await staffReply(ctx, tx, staff.id, id, body.body, body.internal, body.resolve);
      await audit(tx, req, body.internal ? 'support.note' : 'support.reply', { type: 'support_ticket', id }, { resolve: body.resolve });
    });
    return getTicket(ctx.db, id, { id: staff.id, staff: true });
  });
  app.patch('/admin/support/tickets/:id', async (req) => {
    const staff = requirePermission(req, 'support.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z
      .object({ status: z.enum(['open', 'pending', 'resolved']).optional(), priority: z.enum(['normal', 'high']).optional(), assignedTo: z.string().uuid().nullable().optional() })
      .parse(req.body);
    await withTx(ctx.db, async (tx) => {
      await updateTicket(tx, id, patch);
      await audit(tx, req, 'support.update', { type: 'support_ticket', id }, patch);
    });
    return getTicket(ctx.db, id, { id: staff.id, staff: true });
  });

  app.get('/admin/analytics', async (req) => {
    requirePermission(req, 'analytics.view');
    const { days } = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)])).default(30) }).parse(req.query);
    return businessMetrics(ctx.dbRead, days);
  });

  app.get('/admin/fx/topups', async (req) => {
    requirePermission(req, 'fx.manage');
    return { provider: ctx.fxExchange?.name ?? null, autoApproveCents: ctx.cfg.FX_TOPUP_AUTO_APPROVE_CENTS, topups: await listTopUps(ctx) };
  });
  app.post('/admin/fx/topups/plan', async (req) => {
    const admin = requirePermission(req, 'fx.manage');
    const created = await planTopUps(ctx, admin.id);
    await audit(ctx.db, req, 'fx.topups_planned', { type: 'fx_topup', id: null }, { created: created.map((t: any) => t.id) });
    return created;
  });
  app.post('/admin/fx/topups/:id/decide', async (req) => {
    const admin = requirePermission(req, 'fx.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const t = await decideTopUp(ctx, admin.id, id, approve);
    await audit(ctx.db, req, approve ? 'fx.topup_approved' : 'fx.topup_rejected', { type: 'fx_topup', id }, { status: t.status });
    return t;
  });
  app.post('/admin/fx/conversions', async (req, reply) => {
    const admin = requirePermission(req, 'fx.manage');
    const body = z
      .object({ fromCurrency: z.string().length(3), fromCents: z.number().int().positive(), toCurrency: z.string().length(3), toCents: z.number().int().positive(), reference: z.string().trim().min(3).max(200) })
      .parse(req.body);
    const row = await recordConversion(ctx, admin.id, body);
    await audit(ctx.db, req, 'fx.conversion_recorded', { type: 'fx_conversion', id: row.id }, body);
    return reply.status(201).send(row);
  });

  // --- Tax ------------------------------------------------------------------------------
  app.get('/admin/tax/report', async (req, reply) => {
    requirePermission(req, 'tax.manage');
    const q = z.object({ from: z.string().date(), to: z.string().date(), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const rows = await taxReport(ctx, q.from, q.to);
    if (q.format === 'json') return rows;
    const cols = ['country', 'treatment', 'rate_bps', 'currency', 'orders', 'credit_notes', 'commission_gross_cents', 'tax_cents', 'commission_net_cents'];
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', `attachment; filename="tax-${q.from}-${q.to}.csv"`);
    return [cols.join(','), ...rows.map((r: any) => cols.map((c) => r[c] ?? '').join(','))].join('\n');
  });
  app.get('/admin/tax/rates', async (req) => {
    requirePermission(req, 'tax.manage');
    return many(ctx.db, 'SELECT * FROM tax_rates ORDER BY country, valid_from DESC');
  });
  app.put('/admin/tax/rates', async (req) => {
    requirePermission(req, 'tax.manage');
    const body = z
      .object({ country: z.string().length(2), rateBps: z.number().int().min(0).max(5000), name: z.string().trim().min(1).max(20).default('VAT'), validFrom: z.string().date() })
      .parse(req.body);
    const row = await setRate(ctx, body.country, body.rateBps, body.name, body.validFrom);
    await audit(ctx.db, req, 'tax.rate_set', { type: 'tax_rate', id: null }, body);
    return row;
  });
  app.post('/admin/invoices/issue', async (req) => {
    requirePermission(req, 'invoices.manage');
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
    const res = await issueMonthlyInvoices(ctx, `${month}-01`);
    await audit(ctx.db, req, 'invoices.issued', { type: 'invoice_period', id: null }, { month, count: res.issued.length });
    return res;
  });
  app.get('/admin/invoices/:id/pdf', async (req, reply) => {
    requirePermission(req, 'invoices.manage');
    const inv = await getInvoice(ctx, Id.parse(req.params).id, null);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    return reply.send(await invoicePdf(inv));
  });

  app.get('/admin/retention', async (req) => {
    requirePermission(req, 'retention.manage');
    return { policy: retentionPolicy(ctx), runs: await many(ctx.db, 'SELECT * FROM retention_runs ORDER BY started_at DESC LIMIT 30') };
  });
  /** Erasure request: destroy the user's chat key so everything they wrote becomes unreadable. */
  app.post('/admin/users/:id/erase-chat', async (req) => {
    requirePermission(req, 'retention.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    if (!(await maybeOne(ctx.db, 'SELECT 1 FROM users WHERE id = $1', [id]))) throw notFound('User');
    const hold = await chatLegalHold(ctx.db, id);
    if (hold) throw new AppError(409, 'legal_hold', `Can't erase while there is ${hold}; the messages are evidence`);
    const shredded = await shredUserChatKey(ctx.db, id, reason);
    await audit(ctx.db, req, 'chat.erased', { type: 'user', id }, { reason });
    return { erased: true, alreadyErased: !shredded };
  });

  app.post('/admin/retention/run', async (req) => {
    requirePermission(req, 'retention.manage');
    const res = await runRetention(ctx);
    await audit(ctx.db, req, 'retention.run', { type: 'retention_run', id: res.id }, res.counts);
    return res;
  });

  // --- Refunds after release ------------------------------------------------------------
  app.post('/admin/orders/:id/refund-after-release', async (req) => {
    const staff = requirePermission(req, 'orders.refund_after_release');
    const { id } = Id.parse(req.params);
    const body = z
      .object({ amountCents: z.number().int().positive().optional(), paidBy: z.enum(['seller', 'platform', 'reserve']), reason: z.string().trim().min(10).max(500) })
      .parse(req.body);
    const res = await refundAfterRelease(ctx, id, staff.id, body);
    await audit(ctx.db, req, 'order.refunded_after_release', { type: 'order', id }, { ...body, refundId: res.refund.id, creditNote: res.creditNote.number });
    return res;
  });

  // --- AML ---------------------------------------------------------------------------------
  app.get('/admin/aml/cases', async (req) => {
    requirePermission(req, 'aml.review');
    const { status } = z.object({ status: z.enum(['open', 'escalated', 'cleared', 'reported']).optional() }).parse(req.query);
    return listCases(ctx, status);
  });
  app.get('/admin/aml/cases/:id', async (req) => {
    requirePermission(req, 'aml.review');
    const { id } = Id.parse(req.params);
    await audit(ctx.db, req, 'aml.case_viewed', { type: 'aml_case', id });
    return getCase(ctx, id);
  });
  app.post('/admin/aml/cases/:id/notes', async (req, reply) => {
    const staff = requirePermission(req, 'aml.review');
    const { note } = z.object({ note: z.string().trim().min(3).max(2_000) }).parse(req.body);
    await addNote(ctx, Id.parse(req.params).id, staff.id, note);
    return reply.status(204).send();
  });
  app.post('/admin/aml/cases/:id/decide', async (req) => {
    const body = z
      .object({ decision: z.enum(['clear', 'escalate', 'hold', 'report']), note: z.string().trim().min(3).max(2_000), sarReference: z.string().trim().max(100).optional() })
      .parse(req.body);
    const staff = requirePermission(req, body.decision === 'report' ? 'aml.sar' : 'aml.review');
    const { id } = Id.parse(req.params);
    const res = await decideCase(ctx, id, staff.id, body);
    await audit(ctx.db, req, `aml.case_${body.decision}`, { type: 'aml_case', id }, { note: body.note, sarReference: body.sarReference });
    return res;
  });
  app.post('/admin/aml/cases', async (req, reply) => {
    requirePermission(req, 'aml.review');
    const body = z.object({ userId: z.string().uuid(), reason: z.string().trim().min(10).max(2_000), holdPayouts: z.boolean().default(false) }).parse(req.body);
    await openCase(ctx, body.userId, { source: 'manual', rule: 'manual_referral', severity: body.holdPayouts ? 'high' : 'medium', holdsPayouts: body.holdPayouts, details: { reason: body.reason } });
    await audit(ctx.db, req, 'aml.case_opened', { type: 'user', id: body.userId }, body);
    return reply.status(201).send(await listCases(ctx, 'open'));
  });
  app.post('/admin/aml/users/:id/screen', async (req) => {
    requirePermission(req, 'aml.review');
    const { id } = Id.parse(req.params);
    await audit(ctx.db, req, 'aml.screened', { type: 'user', id });
    return screenUser(ctx, id);
  });
  app.get('/admin/aml/lists', async (req) => {
    requirePermission(req, 'aml.review');
    return many(ctx.db, 'SELECT list, version, entries, loaded_at FROM sanctions_lists ORDER BY list');
  });
  app.post('/admin/aml/lists/refresh', async (req) => {
    requirePermission(req, 'aml.review');
    const changed = await refreshLists(ctx);
    const rescreened = await rescreenSellers(ctx);
    await audit(ctx.db, req, 'aml.lists_refreshed', { type: 'sanctions_lists', id: null }, { changed, rescreened });
    return { changed, rescreened };
  });
  app.post('/admin/aml/monitoring/run', async (req) => {
    requirePermission(req, 'aml.review');
    const opened = await runMonitoring(ctx);
    await audit(ctx.db, req, 'aml.monitoring_run', { type: 'aml', id: null }, { opened: opened.length });
    return { opened };
  });

  // --- Staff & permissions -------------------------------------------------------------
  app.get('/admin/staff', async (req) => {
    requirePermission(req, 'staff.manage');
    const rows = await many(
      ctx.db,
      `SELECT id, email, display_name, role, staff_roles, totp_enabled_at IS NOT NULL AS totp_enabled, status FROM users
        WHERE role <> 'user' OR cardinality(staff_roles) > 0 ORDER BY display_name`,
    );
    return rows.map((u) => ({ ...u, permissions: [...permissionsOf(u)].sort() }));
  });
  app.get('/admin/roles', async (req) => {
    requirePermission(req, 'staff.manage');
    return ROLE_PERMISSIONS;
  });
  app.put('/admin/staff/:id', async (req) => {
    const admin = requirePermission(req, 'staff.manage');
    const { id } = Id.parse(req.params);
    const body = z.object({ roles: z.array(z.enum(STAFF_ROLES)).max(5), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    if (id === admin.id) throw forbidden('self_change', 'Ask another admin to change your own access');
    const roles = [...new Set(body.roles)];
    return withScope(ctx, async (s) => {
      const target = await maybeOne(s.tx, 'SELECT id, role, staff_roles, totp_enabled_at, status FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!target) throw notFound('User');
      if (roles.length && req.staffMfaRequired && !target.totp_enabled_at) throw badRequest('mfa_required_for_staff', 'The user must turn on two-factor login before getting staff access');
      // Never leave the platform without an admin.
      if (rolesOf(target).includes('admin') && !roles.includes('admin')) {
        await s.tx.query('SELECT pg_advisory_xact_lock(727279)');
        const { n } = await one(s.tx, `SELECT count(*)::int AS n FROM users WHERE (role = 'admin' OR 'admin' = ANY(staff_roles)) AND status = 'active' AND deleted_at IS NULL AND id <> $1`, [id]);
        if (n === 0) throw conflict('last_admin', 'This is the last admin');
      }
      const [primary, ...extra] = roles;
      await s.tx.query('UPDATE users SET role = $2, staff_roles = $3 WHERE id = $1', [id, primary ?? 'user', extra]);
      await audit(s.tx, req, 'staff.roles_changed', { type: 'user', id }, { from: rolesOf(target), to: roles, reason: body.reason });
      await notify(s.tx, id, 'staff_roles_changed', { roles, by: admin.display_name });
      return { id, roles, permissions: [...permissionsOf({ role: primary ?? 'user', staff_roles: extra })].sort() };
    });
  });

  app.get('/admin/audit', async (req) => {
    requirePermission(req, 'audit.view');
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
    requirePermission(req, 'ledger.view');
    return many(
      ctx.db,
      `SELECT a.kind, a.currency, COALESCE(SUM(e.amount_cents), 0)::bigint AS balance_cents
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_id IS NULL GROUP BY a.kind, a.currency ORDER BY a.kind`,
    );
  });
}
