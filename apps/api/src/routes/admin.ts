import { retentionMetrics } from '../domain/cohorts.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { receiveChargeback } from '../domain/chargebacks.js';
import { withScope } from '../domain/events.js';
import { reviewOwnerProof } from '../domain/offers.js';
import { LEAD_REVIEW_ABOVE_CENTS, isLeadOrder, openDisputeFromTicket, releaseByStaff, resolveDispute, unconfirmedDeliveries } from '../domain/orders.js';
import { controls, updateControls } from '../domain/controls.js';
import { setReviewHidden } from '../domain/reviews.js';
import { reconciliationSnapshots, runReconciliation } from '../domain/reconciliation.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ROLE_PERMISSIONS, STAFF_ROLES, hasPermission, outranks, permissionsOf, rolesOf } from '../domain/permissions.js';
import { notify } from '../domain/notifications.js';
import { refundAfterRelease } from '../domain/clawback.js';
import { addNote, decideCase, getCase, listCases, openCase, refreshLists, rescreenSellers, runMonitoring, screenUser } from '../domain/aml.js';
import { collectDebts, listDebts } from '../domain/debts.js';
import { fraudModelReport } from '../domain/fraud.js';
import { COMPONENTS, COMPONENT_IDS, createIncident, listIncidents, updateIncident } from '../domain/status.js';
import { decideTopUp, listTopUps, planTopUps } from '../domain/fxtopups.js';
import { chatLegalHold } from '../domain/chatkeys.js';
import { eraseUserChat } from '../domain/privacy.js';
import { assertMayChangeStatus } from '../domain/users.js';
import { revokeOtherSessions } from '../domain/sessions.js';
import { toCsv } from '../domain/exports.js';
import { businessMetrics } from '../domain/analytics.js';
import { getTicket, staffReply, ticketQueue, updateTicket } from '../domain/support.js';
import { DISPUTE_CATEGORIES, caseFile } from '../domain/disputes.js';
import { addTerm, chatFlagQueue, decideChatFlag, decideListing, listTerms, moderationCounts, removeTerm, reviewQueue } from '../domain/moderation.js';
import { me, requirePermission } from '../server.js';
import { audit, listAudit } from '../domain/audit.js';
import { decideClaim, escalatedClaims } from '../domain/warranty.js';
import { clearStorefront } from '../domain/storefront.js';
import { createPromo, listPromos, setPromoActive } from '../domain/promos.js';
import { withdrawable } from '../domain/payoutholds.js';
import { retentionPolicy, runRetention } from '../domain/retention.js';
import { keyStatus, rotateAll } from '../domain/keyrotation.js';
import { setRate, taxReport } from '../domain/tax.js';
import { fxPosition, recordConversion } from '../domain/sellerfx.js';
import { getInvoice, invoicePdf, issueMonthlyInvoices } from '../domain/invoices.js';
import { decideAdjustment, listAdjustments, requestAdjustment, userLedger } from '../domain/adjustments.js';
import { decideTreasuryWithdrawal, listTreasuryWithdrawals, requestTreasuryWithdrawal, treasuryBalance } from '../domain/treasury.js';
import { listCryptoRefunds, markRefundSent, listCryptoPayments, recheckCryptoPayment } from '../domain/cryptoPayments.js';
import { recheckUnknownPayout, decideWithdrawal, listPendingWithdrawals } from '../domain/cryptoPayouts.js';
import { commissionSettings, listRanks, updateRanks } from '../domain/commission.js';
import { referralSettings, updateReferralSettings } from '../domain/referrals.js';
import { LEGAL_DOCS, publishDocument } from '../domain/legal.js';
import { INACTIVE_SELLER_DAYS, LEAGUE_GAMES, createLeague, expireEndedLeagueListings, listLeagues, updateLeague } from '../domain/leagues.js';
import { enforceIdDeadlines, listQuestions, rulesSettings, updateRulesTest } from '../domain/onboarding.js';
import { createAffiliate, listAffiliates, updateAffiliate } from '../domain/affiliates.js';
import { setSuggestionStatus } from '../domain/gameVotes.js';
import { offplatformPolicy, setOffplatformPolicy } from '../domain/chat.js';
import { newsletterCsv } from '../domain/newsletter.js';

const Id = z.object({ id: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  // --- Arbitration -------------------------------------------------------------------
  // Warranty claims sent to an arbiter (account warranty, after release).
  app.get('/admin/warranty-claims', async (req) => {
    requirePermission(req, 'disputes.manage');
    return escalatedClaims(ctx.db);
  });
  app.post('/admin/warranty-claims/:id/decide', async (req) => {
    const body = z
      .object({ outcome: z.enum(['refund', 'reject']), note: z.string().trim().min(5).max(1_000), amountCents: z.number().int().positive().optional(), paidBy: z.enum(['seller', 'platform', 'reserve']).optional() })
      .parse(req.body);
    const staff = requirePermission(req, body.outcome === 'refund' ? 'orders.refund_after_release' : 'disputes.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Round 22 (14): a warranty refund on an order above the Lead threshold needs the Support Lead, like any other refund.
    if (body.outcome === 'refund') {
      const c = await maybeOne<{ order_id: string }>(ctx.db, 'SELECT order_id FROM warranty_claims WHERE id = $1', [id]);
      if (c) await requireLeadForLargeOrder(req, c.order_id);
    }
    const claim = await decideClaim(ctx, staff.id, id, body);
    await audit(ctx.db, req, 'warranty_claim.decide', { type: 'warranty_claim', id }, body);
    return claim;
  });

  /** Orders above the Lead threshold ($200, playbook): only the Support Lead (or an admin) releases or decides them. */
  async function requireLeadForLargeOrder(req: FastifyRequest, orderId: string) {
    // Round 25 (M2): the order's USD value, whatever currency it is in.
    const o = await maybeOne<{ amount_cents: string; amount_usd_cents: string; currency: string }>(ctx.db, 'SELECT amount_cents, amount_usd_cents, currency FROM orders WHERE id = $1', [orderId]);
    if (o && isLeadOrder(o)) requirePermission(req, 'orders.lead');
  }

  // ---- Kill switches and beta limits (launch gate §4) ----
  app.get('/admin/controls', async (req) => {
    requirePermission(req, 'controls.manage');
    return controls(ctx.db, true);
  });
  app.put('/admin/controls', async (req) => {
    const staff = requirePermission(req, 'controls.manage');
    const body = z
      .object({
        pause_withdrawals: z.boolean().optional(), pause_orders: z.boolean().optional(), pause_chat: z.boolean().optional(), pause_signups: z.boolean().optional(),
        pause_message: z.string().trim().max(300).nullable().optional(),
        max_withdrawal_day_cents: z.number().int().min(100).max(100_000_00).optional(), max_order_cents: z.number().int().min(100).max(100_000_00).optional(),
        new_account_days: z.number().int().min(0).max(90).optional(), new_account_max_order_cents: z.number().int().min(100).max(100_000_00).optional(), new_account_max_open_orders: z.number().int().min(1).max(100).optional(),
        alert_dispute_hour: z.number().int().min(1).max(1000).optional(), alert_bans_hour: z.number().int().min(1).max(1000).optional(), alert_withdrawal_cents: z.number().int().min(100).max(100_000_00).optional(),
        four_eyes_withdrawal_cents: z.number().int().min(100).max(100_000_00).optional(), four_eyes_user_day_cents: z.number().int().min(100).max(100_000_00).optional(), max_platform_payout_day_cents: z.number().int().min(100).max(10_000_000_00).optional(),
      })
      .parse(req.body);
    const res = await updateControls(ctx, staff.id, body);
    await audit(ctx.db, req, 'controls.update', { type: 'controls', id: 'platform' }, body);
    return res;
  });

  app.get('/admin/disputes', async (req) => {
    requirePermission(req, 'disputes.manage');
    return many(
      ctx.db,
      `SELECT d.*, o.amount_cents, o.currency, o.buyer_id, o.seller_id, r.id AS room_id, f.title AS offer_title,
              (o.amount_usd_cents > $1) AS lead_review,
              (SELECT count(*)::int FROM dispute_statements s WHERE s.dispute_id = d.id) AS statements
         FROM disputes d JOIN orders o ON o.id = d.order_id JOIN chat_rooms r ON r.order_id = o.id JOIN offers f ON f.id = o.offer_id
        WHERE d.status = 'open' ORDER BY d.created_at LIMIT 200`,
      [LEAD_REVIEW_ABOVE_CENTS],
    );
  });
  /** The arbiter's case file: one timeline, the listing as bought, payment checks, both sides' records. */
  app.get('/admin/disputes/:id/case', async (req) => {
    requirePermission(req, 'disputes.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const file = await caseFile(ctx, id);
    await audit(ctx.db, req, 'dispute.case_viewed', { type: 'dispute', id });
    return file;
  });

  app.post('/admin/disputes/:id/resolve', async (req) => {
    const arbiter = requirePermission(req, 'disputes.manage');
    const body = z.object({ outcome: z.enum(['buyer', 'seller', 'split']), refundCents: z.number().int().positive().optional(), note: z.string().min(3).max(2_000) }).parse(req.body);
    const { id } = Id.parse(req.params);
    const d = await maybeOne<{ order_id: string }>(ctx.db, 'SELECT order_id FROM disputes WHERE id = $1', [id]);
    if (d) await requireLeadForLargeOrder(req, d.order_id);
    const res = await resolveDispute(ctx, id, arbiter.id, body.outcome, body.note, body.refundCents);
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
      if (decision === 'confirm') await assertMayChangeStatus(s.tx, admin, flag.user_id); // Round 23e: confirming bans
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
        await s.tx.query(`UPDATE users SET status = 'banned', banned_at = now(), suspension_reason = 'fraud_confirmed', withdrawals_frozen = true WHERE id = $1`, [flag.user_id]);
        await revokeOtherSessions(s.tx, flag.user_id, null, 'banned');
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
              u.legal_name AS seller_legal_name, f.title,
              la.provider AS linked_platform, la.display_name AS linked_name, la.profile_url AS linked_profile_url,
              la.account_created_at AS linked_account_created_at, la.linked_at
         FROM owner_proofs p JOIN users u ON u.id = p.seller_id JOIN offers f ON f.id = p.offer_id
         LEFT JOIN linked_accounts la ON la.id = f.linked_account_id AND la.unlinked_at IS NULL
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

  /** Round 23d: staff can only suspend or ban accounts below their own rank (a lead cannot touch an admin). */
  const assertOutranks = (actor: { id: string; role: string; staff_roles?: string[] | null }, targetId: string) => assertMayChangeStatus(ctx.db, actor, targetId);
  /** Suspend for a number of days (lifts itself) or until staff lift it (no days). */
  app.post('/admin/users/:id/suspend', async (req) => {
    const actor = requirePermission(req, 'users.suspend');
    const { reason, days } = z.object({ reason: z.string().min(3).max(500), days: z.number().int().min(1).max(365).optional() }).parse(req.body);
    const { id } = Id.parse(req.params);
    await assertOutranks(actor, id);
    const r = await ctx.db.query(
      `UPDATE users SET status = 'suspended', suspension_reason = $2, suspended_until = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END WHERE id = $1 AND status <> 'banned' RETURNING suspended_until`,
      [id, reason, days ?? null],
    );
    if (!r.rowCount) throw conflict('banned', 'This account is banned; a ban is not shortened into a suspension');
    // Round 23e: a suspension takes effect at once — every session is signed out (an ordinary user may sign in again to read).
    await revokeOtherSessions(ctx.db, id, null, 'suspended');
    await audit(ctx.db, req, 'user.suspend', { type: 'user', id }, { reason, days: days ?? null });
    return { suspended: true, until: r.rows[0].suspended_until };
  });
  /** Ban: permanent, never lifted automatically. Lifting it is a Lead/admin decision (reinstate). */
  app.post('/admin/users/:id/ban', async (req) => {
    const actor = requirePermission(req, 'users.suspend');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const { id } = Id.parse(req.params);
    await assertOutranks(actor, id);
    await ctx.db.query(`UPDATE users SET status = 'banned', banned_at = now(), suspension_reason = $2, suspended_until = NULL WHERE id = $1`, [id, reason]);
    await ctx.db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'banned' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(ctx.db, req, 'user.ban', { type: 'user', id }, { reason });
    return { banned: true };
  });
  app.post('/admin/users/:id/reinstate', async (req) => {
    const actor = requirePermission(req, 'users.suspend');
    const { id } = Id.parse(req.params);
    await assertOutranks(actor, id); // Round 23e: reinstating changes the status too
    const { note } = z.object({ note: z.string().min(3).max(500) }).parse(req.body);
    const cur = await maybeOne<{ status: string }>(ctx.db, 'SELECT status FROM users WHERE id = $1', [id]);
    if (!cur) throw notFound('User');
    if (cur.status === 'banned') requirePermission(req, 'orders.lead'); // lifting a ban: the Lead or an admin
    await ctx.db.query(`UPDATE users SET status = 'active', suspended_until = NULL, suspension_reason = NULL WHERE id = $1`, [id]);
    await audit(ctx.db, req, 'user.reinstate', { type: 'user', id }, { note, from: cur.status });
    return { active: true };
  });

  /** Listing ban (penalty ladder step 2): the account stays, but it can't create or relist offers; live offers pause. */
  app.post('/admin/users/:id/listing-ban', async (req) => {
    requirePermission(req, 'moderation.manage'); // the penalty ladder's middle rung: support (the Lead) and arbiters
    const { on, reason } = z.object({ on: z.boolean(), reason: z.string().trim().min(3).max(500).optional() }).parse(req.body);
    const { id } = Id.parse(req.params);
    if (on) {
      await ctx.db.query(`UPDATE users SET listing_banned_at = now(), listing_ban_reason = $2 WHERE id = $1`, [id, reason ?? null]);
      await ctx.db.query(`UPDATE offers SET status = 'paused', expired_reason = 'listing_ban', version = version + 1, updated_at = now() WHERE seller_id = $1 AND status = 'active'`, [id]);
    } else {
      await ctx.db.query(`UPDATE users SET listing_banned_at = NULL, listing_ban_reason = NULL WHERE id = $1`, [id]);
      await ctx.db.query(`UPDATE offers SET status = 'active', expired_reason = NULL, version = version + 1, updated_at = now() WHERE seller_id = $1 AND status = 'paused' AND expired_reason = 'listing_ban'`, [id]);
    }
    await audit(ctx.db, req, on ? 'user.listing_ban' : 'user.listing_unban', { type: 'user', id }, { reason });
    return { listingBanned: on };
  });

  // --- Legal documents (Terms, Privacy, Seller Agreement, Refunds, restricted countries) -------------
  app.get('/admin/legal', async (req) => {
    requirePermission(req, 'support.manage');
    return many(ctx.db, 'SELECT doc, locale, version, effective_at, title, sha256, material, created_at FROM legal_documents ORDER BY doc, effective_at DESC, locale');
  });
  app.put('/admin/legal/:doc', async (req) => {
    const staff = requirePermission(req, 'legal.publish'); // Round 23d: admin and compliance only
    const { doc } = z.object({ doc: z.enum(LEGAL_DOCS) }).parse(req.params);
    const body = z
      .object({
        lang: z.string().regex(/^[a-z]{2}$/).default('en'),
        version: z.string().trim().min(1).max(40),
        effectiveAt: z.string().datetime().optional(),
        title: z.string().trim().min(2).max(120),
        contentMd: z.string().min(20).max(400_000),
        // Round 22: materiality is always stated by staff, never defaulted.
        material: z.boolean({ error: 'Say whether this is a material change (true or false)' }),
      })
      .parse(req.body);
    const row = await publishDocument(ctx, staff.id, { doc, ...body });
    await audit(ctx.db, req, 'legal.publish', { type: 'legal_document', id: `${doc}:${body.lang}:${body.version}` }, { material: body.material, previousMaterial: row.previous_material, effectiveAt: body.effectiveAt, sha256: row.sha256 });
    return row;
  });

  app.get('/admin/reconciliation/snapshots', async (req) => {
    requirePermission(req, 'reconciliation.run');
    return reconciliationSnapshots(ctx.db);
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
  // --- Ranks and the launch promo (commission) ------------------------------------------------
  // --- Referral share (G2G-style: a cut of our commission on every order of a referred user) -----
  app.get('/admin/referral', async (req) => {
    requirePermission(req, 'ranks.manage');
    return referralSettings(ctx.db);
  });
  app.put('/admin/referral', async (req) => {
    const staff = requirePermission(req, 'ranks.manage');
    const body = z.object({ rateBps: z.number().int().min(0).max(5000).optional(), activeDays: z.number().int().min(1).max(3650).optional() }).parse(req.body);
    const out = await updateReferralSettings(ctx.db, staff.id, body);
    await audit(ctx.db, req, 'referral.settings', { type: 'referral', id: 'referral' }, body);
    return out;
  });
  app.get('/admin/ranks', async (req) => {
    requirePermission(req, 'ranks.manage');
    return { ranks: await listRanks(ctx.db), settings: await commissionSettings(ctx.db) };
  });
  // --- Site texts (the chat safety panel), one row per locale ----------------------------------------
  app.get('/admin/texts/:key', async (req) => {
    requirePermission(req, 'support.manage');
    const { key } = z.object({ key: z.enum(['chat_safety']) }).parse(req.params);
    return many(ctx.db, 'SELECT key, locale, body, link_label, link_href, updated_at FROM site_texts WHERE key = $1 ORDER BY (locale = $2) DESC, locale', [key, 'en']);
  });
  app.put('/admin/texts/:key', async (req) => {
    const staff = requirePermission(req, 'support.manage');
    const { key } = z.object({ key: z.enum(['chat_safety']) }).parse(req.params);
    const body = z
      .object({ body: z.string().trim().min(10).max(2_000), linkLabel: z.string().trim().max(60).default(''), linkHref: z.string().trim().max(200).regex(/^\/|^$/).default(''), lang: z.string().regex(/^[a-z]{2}$/).default('en') })
      .parse(req.body);
    const row = await one(
      ctx.db,
      `INSERT INTO site_texts (key, locale, body, link_label, link_href, updated_by) VALUES ($1, $6, $2, $3, $4, $5)
       ON CONFLICT (key, locale) DO UPDATE SET body = EXCLUDED.body, link_label = EXCLUDED.link_label, link_href = EXCLUDED.link_href, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, locale, body, link_label, link_href, updated_at`,
      [key, body.body, body.linkLabel, body.linkHref, staff.id, body.lang],
    );
    await audit(ctx.db, req, 'texts.update', { type: 'site_text', id: key }, body);
    return row;
  });

  // --- Creator affiliate codes and game voting ----------------------------------------------
  app.get('/admin/affiliates', async (req) => (requirePermission(req, 'promos.manage'), listAffiliates(ctx.db)));
  app.post('/admin/affiliates', async (req, reply) => {
    const user = requirePermission(req, 'promos.manage');
    const body = z.object({ userId: z.string().uuid(), code: z.string().trim().min(3).max(20), rateBps: z.number().int().min(0).max(5000), note: z.string().trim().max(300).optional() }).parse(req.body);
    const a = await createAffiliate(ctx, user.id, body);
    await audit(ctx.db, req, 'affiliate.create', { type: 'affiliate', id: a.id }, body);
    return reply.status(201).send(a);
  });
  app.patch('/admin/affiliates/:id', async (req) => {
    requirePermission(req, 'promos.manage');
    const body = z.object({ rateBps: z.number().int().min(0).max(5000).optional(), status: z.enum(['active', 'paused']).optional(), note: z.string().trim().max(300).optional() }).parse(req.body);
    const a = await updateAffiliate(ctx, Id.parse(req.params).id, body);
    await audit(ctx.db, req, 'affiliate.update', { type: 'affiliate', id: a.id }, body);
    return a;
  });
  app.patch('/admin/games/votes/:id', async (req) => {
    requirePermission(req, 'moderation.manage');
    const body = z.object({ status: z.enum(['open', 'planned', 'added', 'declined']), note: z.string().trim().max(300).default('') }).parse(req.body);
    return setSuggestionStatus(ctx, Id.parse(req.params).id, body.status, body.note);
  });

  // --- Launch phase: which categories are on sale ---------------------------------------------
  app.get('/admin/launch', async (req) => {
    requirePermission(req, 'ranks.manage');
    const l = await one<any>(ctx.db, 'SELECT phase, founding_until, founding_featured_slots, featured_days, allowed_games FROM launch_settings');
    return { phase: Number(l.phase), foundingUntil: l.founding_until, foundingFeaturedSlots: Number(l.founding_featured_slots), featuredDays: Number(l.featured_days), allowedGames: l.allowed_games, categories: await many(ctx.db, 'SELECT slug, name, phase FROM categories ORDER BY phase, name') };
  });
  app.put('/admin/launch', async (req) => {
    requirePermission(req, 'ranks.manage');
    const body = z
      .object({
        phase: z.number().int().min(1).max(3).optional(),
        foundingUntil: z.string().datetime().optional(),
        foundingFeaturedSlots: z.number().int().min(0).max(10).optional(),
        featuredDays: z.number().int().min(1).max(90).optional(),
        /** Games sellers may list; null opens every game. */
        allowedGames: z.array(z.string().trim().min(1).max(80)).max(500).nullable().optional(),
      })
      .parse(req.body);
    await ctx.db.query(
      'UPDATE launch_settings SET phase = COALESCE($1, phase), founding_until = COALESCE($2, founding_until), founding_featured_slots = COALESCE($3, founding_featured_slots), featured_days = COALESCE($4, featured_days), updated_at = now()',
      [body.phase ?? null, body.foundingUntil ?? null, body.foundingFeaturedSlots ?? null, body.featuredDays ?? null],
    );
    if (body.allowedGames !== undefined) await ctx.db.query('UPDATE launch_settings SET allowed_games = $1, updated_at = now()', [body.allowedGames]);
    await audit(ctx.db, req, 'launch.settings', { type: 'launch', id: 'launch' }, body);
    const l = await one<any>(ctx.db, 'SELECT phase, founding_until, founding_featured_slots, featured_days, allowed_games FROM launch_settings');
    return { phase: Number(l.phase), foundingUntil: l.founding_until, foundingFeaturedSlots: Number(l.founding_featured_slots), featuredDays: Number(l.featured_days), allowedGames: l.allowed_games };
  });

  // --- Seller rules test (questions, pass mark, ID deadline) -----------------------------------
  app.get('/admin/rules-test', async (req) => {
    requirePermission(req, 'rules.manage');
    return { questions: await listQuestions(ctx.db), settings: await rulesSettings(ctx.db) };
  });
  app.put('/admin/rules-test', async (req) => {
    const user = requirePermission(req, 'rules.manage');
    const body = z
      .object({
        questions: z.array(z.object({ id: z.string().uuid().optional(), position: z.number().int().min(1).max(100), question: z.string().trim().min(10).max(500), options: z.array(z.string().trim().min(1).max(200)).min(2).max(6), correct: z.number().int().min(0).max(5), explanation: z.string().trim().max(600).default(''), active: z.boolean().default(true), question_ar: z.string().trim().max(500).nullable().optional(), options_ar: z.array(z.string().trim().min(1).max(200)).max(6).nullable().optional(), explanation_ar: z.string().trim().max(600).nullable().optional() })).min(1).max(50),
        settings: z.object({ passMarkPct: z.number().int().min(1).max(100).optional(), idDueDays: z.number().int().min(1).max(365).optional() }).optional(),
      })
      .parse(req.body);
    const r = await updateRulesTest(ctx, user.id, body);
    await audit(ctx.db, req, 'rules_test.update', { type: 'rules_test', id: 'rules_test' }, { questions: body.questions.length, settings: body.settings ?? null });
    return r;
  });
  /** Run the ID-deadline check now (it also runs in the worker). */
  app.post('/admin/rules-test/enforce', async (req) => {
    requirePermission(req, 'rules.manage');
    return enforceIdDeadlines(ctx);
  });

  // --- Challenge leagues (Path of Exile) -----------------------------------------------------
  app.get('/admin/leagues', async (req) => {
    requirePermission(req, 'leagues.manage');
    return { leagues: await listLeagues(ctx.db), games: LEAGUE_GAMES, inactiveSellerDays: INACTIVE_SELLER_DAYS };
  });
  app.post('/admin/leagues', async (req, reply) => {
    const user = requirePermission(req, 'leagues.manage');
    const body = z.object({ game: z.string().min(1).max(80), name: z.string().trim().min(2).max(60), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional() }).parse(req.body);
    const l = await createLeague(ctx, user.id, body);
    await audit(ctx.db, req, 'league.create', { type: 'league', id: l.id }, body);
    return reply.status(201).send(l);
  });
  app.patch('/admin/leagues/:id', async (req) => {
    requirePermission(req, 'leagues.manage');
    const body = z.object({ startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional() }).parse(req.body);
    const l = await updateLeague(ctx, Id.parse(req.params).id, body);
    await audit(ctx.db, req, 'league.update', { type: 'league', id: l.id }, body);
    return l;
  });
  /** Run the league expiry now (it also runs in the worker). */
  app.post('/admin/leagues/expire', async (req) => {
    requirePermission(req, 'leagues.manage');
    return { expired: await expireEndedLeagueListings(ctx) };
  });

  app.put('/admin/ranks', async (req) => {
    requirePermission(req, 'ranks.manage');
    const body = z
      .object({
        ranks: z.array(z.object({ position: z.number().int().min(1).max(5), name: z.string().trim().min(2).max(30), minMonthlySalesCents: z.number().int().min(0), rateBps: z.number().int().min(0).max(5000), perks: z.array(z.string().max(120)).max(8).optional() })).length(5),
        settings: z.object({ promoRateBps: z.number().int().min(0).max(5000).optional(), promoDays: z.number().int().min(0).max(365).optional() }).optional(),
      })
      .parse(req.body);
    const r = await updateRanks(ctx, body.ranks, body.settings);
    await audit(ctx.db, req, 'ranks.update', { type: 'ranks', id: 'ranks' }, body);
    return r;
  });

  // --- Unconfirmed deliveries: staff release 24h+ after delivery ------------------------------
  app.get('/admin/orders/unconfirmed', async (req) => {
    requirePermission(req, 'orders.release');
    return unconfirmedDeliveries(ctx.dbRead);
  });
  app.post('/admin/orders/:id/release', async (req) => {
    const staff = requirePermission(req, 'orders.release');
    const { id } = Id.parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(3).max(1_000) }).parse(req.body);
    await requireLeadForLargeOrder(req, id);
    const o = await releaseByStaff(ctx, id, staff.id, note);
    await audit(ctx.db, req, 'order.release', { type: 'order', id }, { note });
    return { id: o.id, status: 'completed' };
  });

  // --- Seller withdrawals (crypto): CFO approval -------------------------------------------
  /** Finance (treasury) or the Support Lead (who only co-signs the large ones, Round 22). */
  const withdrawalStaff = (req: FastifyRequest) => (hasPermission(me(req), 'withdrawals.second_approve') && !hasPermission(me(req), 'treasury.approve') ? requirePermission(req, 'withdrawals.second_approve') : requirePermission(req, 'treasury.approve'));
  app.get('/admin/withdrawals', async (req) => {
    if (!hasPermission(me(req), 'withdrawals.second_approve')) requirePermission(req, 'treasury.request');
    else requirePermission(req, 'withdrawals.second_approve');
    return listPendingWithdrawals(ctx.db);
  });
  app.post('/admin/withdrawals/:id/decide', async (req) => {
    const staff = withdrawalStaff(req);
    const { id } = Id.parse(req.params);
    const body = z.object({ approve: z.boolean(), note: z.string().max(500).optional() }).parse(req.body);
    try {
      const w = await decideWithdrawal(ctx, id, staff, body.approve, body.note);
      await audit(ctx.db, req, body.approve ? (w.status === 'pending_approval' ? 'withdrawal.first_approve' : 'withdrawal.approve') : 'withdrawal.reject', { type: 'withdrawal', id }, body);
      return w;
    } catch (err) {
      // Round 22 (12): the approval stands even when the provider call fails afterwards, so it is audited either way.
      if (err instanceof AppError && ['payout_failed', 'payout_unknown'].includes(err.code)) {
        await audit(ctx.db, req, 'withdrawal.approve', { type: 'withdrawal', id }, { ...body, payout: err.code, reason: (err.details as any)?.reason ?? null });
      }
      throw err;
    }
  });
  /** A payout whose provider call timed out: ask NOWPayments whether it exists before anything is reversed. */
  app.post('/admin/withdrawals/:id/recheck', async (req) => {
    requirePermission(req, 'treasury.approve');
    const { id } = Id.parse(req.params);
    const w = await recheckUnknownPayout(ctx, id, { manual: true });
    if (!w) throw notFound('Withdrawal in the unknown state');
    await audit(ctx.db, req, 'withdrawal.recheck', { type: 'withdrawal', id }, { status: w.status });
    return w;
  });

  // --- Crypto payments (Round 26 A3): the list that replaces logs, and a provider re-check -------------
  app.get('/admin/crypto/payments', async (req) => {
    requirePermission(req, 'ledger.view');
    const q = z.object({ status: z.string().max(30).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().positive().max(500).optional() }).parse(req.query);
    return listCryptoPayments(ctx.db, q);
  });
  app.post('/admin/crypto/payments/:paymentId/recheck', async (req) => {
    requirePermission(req, 'treasury.request');
    const { paymentId } = z.object({ paymentId: z.string().min(1).max(60) }).parse(req.params);
    const res = await recheckCryptoPayment(ctx, paymentId);
    await audit(ctx.db, req, 'crypto_payment.recheck', { type: 'crypto_payment', id: paymentId }, { before: res.before, providerStatus: res.provider_status, state: res.payment?.state ?? null });
    return res;
  });

  // --- Crypto refunds: sent by hand from the store wallet -----------------------------------
  app.get('/admin/crypto/refunds', async (req) => {
    requirePermission(req, 'treasury.request');
    const { status } = z.object({ status: z.enum(['awaiting_address', 'pending', 'sent', 'cancelled']).optional() }).parse(req.query);
    return listCryptoRefunds(ctx.db, status);
  });
  app.post('/admin/crypto/refunds/:id/sent', async (req) => {
    const staff = requirePermission(req, 'treasury.approve');
    const body = z.object({ txHash: z.string().trim().min(8).max(200), note: z.string().max(500).optional() }).parse(req.body);
    const r = await markRefundSent(ctx, Id.parse(req.params).id, staff.id, body);
    await audit(ctx.db, req, 'crypto_refund.sent', { type: 'crypto_refund', id: r.id }, body);
    return r;
  });

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

  // --- Currency position (sellers paid in EUR/EGP) ---------------------------------------
  app.get('/admin/fx/position', async (req) => {
    requirePermission(req, 'fx.manage');
    return { positions: await fxPosition(ctx), conversions: await many(ctx.db, 'SELECT * FROM fx_conversions ORDER BY created_at DESC LIMIT 50') };
  });
  // --- Support queue ------------------------------------------------------------------------
  // ---- Moderation: listing review queue, flagged chats, banned terms ----
  app.get('/admin/moderation/summary', async (req) => (requirePermission(req, 'moderation.manage'), moderationCounts(ctx.db)));
  app.get('/admin/moderation/listings', async (req) => (requirePermission(req, 'moderation.manage'), reviewQueue(ctx.db)));
  /** Remove a shop's banner and/or intro (offensive image, rule-breaking text). */
  app.post('/admin/sellers/:id/storefront/clear', async (req) => {
    requirePermission(req, 'moderation.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ banner: z.boolean().default(false), intro: z.boolean().default(false), note: z.string().trim().min(3).max(500) }).parse(req.body);
    await clearStorefront(ctx, id, body);
    await audit(ctx.db, req, 'storefront.clear', { type: 'user', id }, body);
    return { ok: true };
  });
  app.post('/admin/moderation/listings/:id', async (req) => {
    const staff = requirePermission(req, 'moderation.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean(), note: z.string().trim().max(1_000).optional() }).parse(req.body);
    const res = await decideListing(ctx, id, staff.id, body.approve, body.note);
    await audit(ctx.db, req, body.approve ? 'moderation.listing_approved' : 'moderation.listing_rejected', { type: 'offer', id }, { note: body.note });
    return res;
  });
  app.get('/admin/moderation/chats', async (req) => {
    requirePermission(req, 'moderation.manage');
    const { status } = z.object({ status: z.enum(['open', 'confirmed', 'dismissed']).default('open') }).parse(req.query);
    const flags = await chatFlagQueue(ctx, status);
    // Staff reading chat excerpts is logged, as for opening an order's chat.
    if (flags.length) await audit(ctx.db, req, 'moderation.chats_viewed', { type: 'chat_flags', id: status }, { count: flags.length });
    return flags;
  });
  app.post('/admin/moderation/chats/:id', async (req) => {
    const staff = requirePermission(req, 'moderation.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ confirm: z.boolean(), note: z.string().trim().max(1_000).optional() }).parse(req.body);
    const res = await decideChatFlag(ctx, id, staff.id, body.confirm, body.note);
    await audit(ctx.db, req, body.confirm ? 'moderation.chat_confirmed' : 'moderation.chat_dismissed', { type: 'chat_flag', id }, { note: body.note });
    // Round 22b: the automatic ban this flag caused was lifted with it.
    if ((res as any).banLifted) await audit(ctx.db, req, 'user.auto_ban_lifted', { type: 'user', id: res.user_id }, { flag: id, restored: (res as any).restoredStatus, note: body.note });
    return res;
  });
  /** Outside-contact policy: the action per offence (warn = block only, suspend, ban); the last repeats. */
  app.get('/admin/moderation/offplatform-policy', async (req) => (requirePermission(req, 'moderation.manage'), { actions: await offplatformPolicy(ctx.db) }));
  app.put('/admin/moderation/offplatform-policy', async (req) => {
    const staff = requirePermission(req, 'moderation.manage');
    const { actions } = z.object({ actions: z.array(z.enum(['warn', 'suspend', 'ban'])).min(1).max(5) }).parse(req.body);
    const saved = await setOffplatformPolicy(ctx.db, actions, staff.id);
    await audit(ctx.db, req, 'moderation.offplatform_policy', { type: 'moderation', id: 'offplatform_policy' }, { actions });
    return { actions: saved };
  });
  app.get('/admin/moderation/terms', async (req) => (requirePermission(req, 'moderation.manage'), listTerms(ctx.db)));
  app.post('/admin/moderation/terms', async (req, reply) => {
    const staff = requirePermission(req, 'moderation.manage');
    const body = z.object({ term: z.string().trim().min(2).max(60), action: z.enum(['block', 'review']) }).parse(req.body);
    const t = await addTerm(ctx.db, body.term, body.action, staff.id);
    await audit(ctx.db, req, 'moderation.term_added', { type: 'moderation_term', id: t.id }, body);
    return reply.status(201).send(t);
  });
  app.delete('/admin/moderation/terms/:id', async (req, reply) => {
    requirePermission(req, 'moderation.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await removeTerm(ctx.db, id);
    await audit(ctx.db, req, 'moderation.term_removed', { type: 'moderation_term', id });
    return reply.status(204).send();
  });

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
  /**
   * Round 24: buyers no longer open disputes on the order page; they write to support. Staff who decide disputes open
   * one from the ticket: on the ticket's order (or the customer's order named here when the ticket has none), with the
   * ticket's subject as the reason and its first message as the customer's statement. Same rules as before: paid or
   * delivered, not already disputed, escrow frozen, orders above $200 decided by the Lead.
   */
  app.post('/admin/support/tickets/:id/dispute', async (req, reply) => {
    const staff = requirePermission(req, 'disputes.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ orderId: z.string().uuid().optional(), category: z.enum(DISPUTE_CATEGORIES).default('other'), reason: z.string().trim().min(3).max(2_000).optional() })
      .parse(req.body ?? {});
    const dispute = await openDisputeFromTicket(ctx, id, staff.id, body);
    await audit(ctx.db, req, 'dispute.open_from_ticket', { type: 'dispute', id: dispute.id }, { ticketId: id, orderId: dispute.order_id, category: body.category });
    const amount = await maybeOne<{ amount_cents: string; amount_usd_cents: string; currency: string }>(ctx.db, 'SELECT amount_cents, amount_usd_cents, currency FROM orders WHERE id = $1', [dispute.order_id]);
    return reply.status(201).send({
      dispute: { ...dispute, lead_review: !!amount && isLeadOrder(amount) },
      // The ticket thread (with internal notes) only for staff who work the support queue.
      ticket: hasPermission(staff, 'support.manage') ? await getTicket(ctx.db, id, { id: staff.id, staff: true }) : null,
    });
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
  app.get('/admin/analytics/retention', async (req) => {
    requirePermission(req, 'analytics.view');
    const { months } = z.object({ months: z.coerce.number().pipe(z.union([z.literal(6), z.literal(12), z.literal(24)])).default(12) }).parse(req.query);
    return retentionMetrics(ctx.dbRead, months);
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

  // --- Newsletter (Round 23a) -----------------------------------------------------------
  /** Opted-in subscribers as CSV (for the newsletter tool when the Brevo sync is off). Personal data: audited. */
  app.get('/admin/newsletter/status', async (req) => {
    requirePermission(req, 'newsletter.export');
    const n = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM users WHERE news_opt_in AND deleted_at IS NULL AND status = 'active'`);
    return { subscribers: n.n, brevoSync: !!ctx.cfg.BREVO_API_KEY };
  });
  app.get('/admin/newsletter.csv', async (req, reply) => {
    const user = requirePermission(req, 'newsletter.export');
    await audit(ctx.db, req, 'newsletter.exported', { type: 'user', id: user.id }, {});
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="bullizard-newsletter-${new Date().toISOString().slice(0, 10)}.csv"`);
    return newsletterCsv(ctx.db);
  });

  // --- Tax ------------------------------------------------------------------------------
  app.get('/admin/tax/report', async (req, reply) => {
    requirePermission(req, 'tax.manage');
    const q = z.object({ from: z.string().date(), to: z.string().date(), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const rows = await taxReport(ctx, q.from, q.to);
    if (q.format === 'json') return rows;
    const cols = ['country', 'treatment', 'rate_bps', 'currency', 'orders', 'credit_notes', 'commission_gross_cents', 'tax_cents', 'commission_net_cents'];
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', `attachment; filename="tax-${q.from}-${q.to}.csv"`);
    return toCsv(cols, rows as any); // Round 23d (item 15): cells go through csvCell (quoting, formula neutralising)
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
    // Round 23e: key and files in one transaction; the stored objects are deleted after commit (retried if that fails).
    const { shredded, files } = await eraseUserChat(ctx, id, reason);
    await audit(ctx.db, req, 'chat.erased', { type: 'user', id }, { reason, files });
    return { erased: true, alreadyErased: !shredded, files };
  });

  /** Round 23d: KYC applicants of deleted accounts, to be deleted at the provider by compliance (irreversible, so a person does it). */
  app.get('/admin/privacy/kyc-deletions', async (req) => {
    requirePermission(req, 'retention.manage');
    return many(ctx.db, `SELECT id, user_id, provider, external_id, created_at, done_at, done_by FROM kyc_deletion_requests WHERE done_at IS NULL ORDER BY created_at LIMIT 200`);
  });
  app.post('/admin/privacy/kyc-deletions/:id/done', async (req) => {
    const staff = requirePermission(req, 'retention.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await ctx.db.query(`UPDATE kyc_deletion_requests SET done_at = now(), done_by = $2 WHERE id = $1 AND done_at IS NULL`, [id, staff.id]);
    if (!r.rowCount) throw notFound('Request');
    await audit(ctx.db, req, 'kyc.deleted_at_provider', { type: 'kyc_deletion_request', id }, {});
    return { done: true };
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
    await requireLeadForLargeOrder(req, id);
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
