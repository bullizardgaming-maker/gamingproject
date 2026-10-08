import PDFDocument from 'pdfkit';
import { sellerCurrencyOf, sellerLeg, toSettlement } from './sellerfx.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { listMessages, verifyChain } from './chat.js';
import { withScope } from './events.js';
import { accountId, orderEscrowBalance, post, sellerAvailable } from './ledger.js';
import { enqueueWebhook } from './webhooks.js';
import { enqueueEmail } from './notifications.js';

export type ChargebackCategory = 'fraud' | 'not_as_described' | 'credit_not_processed';

interface ReasonSpec {
  category: ChargebackCategory;
  title: string;
  strategy: string;
}

/**
 * Reason-code map. Generic evidence loses: each packet is assembled for the
 * specific code. Mastercard 4853 ("Cardholder Dispute") covers both "not as
 * described" and "credit not processed"; callers may pass a sub-type.
 */
export const REASON_CODES: Record<string, ReasonSpec> = {
  'visa:10.4': { category: 'fraud', title: 'Visa 10.4 — Other Fraud: Card-Absent Environment', strategy: 'AVS/CVV match, IP geolocation vs billing, prior undisputed orders from the same device/card.' },
  'mastercard:4837': { category: 'fraud', title: 'Mastercard 4837 — No Cardholder Authorization', strategy: 'AVS/CVV match, IP geolocation vs billing, prior undisputed orders from the same device/card.' },
  'visa:13.3': { category: 'not_as_described', title: 'Visa 13.3 — Not as Described or Defective', strategy: 'Listing snapshot at time of sale, immutable chat log showing no attempt to resolve, ToS acceptance.' },
  'mastercard:4853': { category: 'not_as_described', title: 'Mastercard 4853 — Cardholder Dispute', strategy: 'Listing snapshot at time of sale, immutable chat log showing no attempt to resolve, ToS acceptance.' },
  'visa:13.6': { category: 'credit_not_processed', title: 'Visa 13.6 — Credit Not Processed', strategy: 'Ledger proof of refund to the original payment method, or proof the order did not qualify under the cancellation policy.' },
};

export const RESPONSE_WINDOW_DAYS = { visa: 30, mastercard: 45 } as const;

export function classify(network: 'visa' | 'mastercard', reasonCode: string, subtype?: ChargebackCategory): ReasonSpec {
  const spec = REASON_CODES[`${network}:${reasonCode}`];
  if (spec && subtype && network === 'mastercard' && reasonCode === '4853') {
    return subtype === 'credit_not_processed'
      ? { ...spec, category: 'credit_not_processed', strategy: REASON_CODES['visa:13.6']!.strategy }
      : spec;
  }
  return spec ?? { category: 'not_as_described', title: `${network} ${reasonCode}`, strategy: 'General digital-delivery evidence.' };
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------
export interface ChargebackInput {
  paymentRef?: string;
  orderId?: string;
  disputeRef?: string;
  network: 'visa' | 'mastercard';
  reasonCode: string;
  amountCents: number;
  subtype?: ChargebackCategory;
}

/**
 * Record a chargeback, move the money, then build and submit the representment packet.
 *
 * Chargeback Shield: when the seller is protected (delivered through the platform,
 * listing not flagged High Risk - Secondary Market) the platform reserve absorbs
 * the loss. Otherwise the seller's balance is debited first.
 */
export async function receiveChargeback(ctx: Ctx, input: ChargebackInput) {
  const cb = await withScope(ctx, async (s) => {
    const order = await maybeOne(
      s.tx,
      `SELECT * FROM orders WHERE ${input.orderId ? 'id = $1' : 'payment_ref = $1'} FOR UPDATE`,
      [input.orderId ?? input.paymentRef],
    );
    if (!order) throw notFound('Order for chargeback');
    if (input.disputeRef) {
      const dup = await maybeOne(s.tx, 'SELECT * FROM chargebacks WHERE provider_ref = $1', [input.disputeRef]);
      if (dup) return dup;
    }
    const spec = classify(input.network, input.reasonCode, input.subtype);
    // Only the card-paid part can be charged back (promo discounts and store credit weren't on the card),
    // less anything already refunded to the card after release.
    const { card_refunded } = await one<{ card_refunded: number }>(s.tx, 'SELECT COALESCE(SUM(card_cents), 0)::bigint AS card_refunded FROM post_release_refunds WHERE order_id = $1', [order.id]);
    const amount = Math.max(0, Math.min(input.amountCents, Number(order.charged_cents ?? order.amount_cents) - Number(card_refunded)));

    // Pull the money back: from escrow if still held, else seller balance / reserve.
    const allocation: Record<string, number> = {};
    const held = await orderEscrowBalance(s.tx, order.id, order.currency);
    const clearing = await accountId(s.tx, 'gateway_clearing', order.currency);
    if (held > 0) {
      allocation.escrow = Math.min(held, amount);
      // Whatever else sat in escrow for this order (promo top-up, store credit) is forfeited to the platform,
      // so the order's escrow is fully cleared. Reversed if the chargeback is won.
      if (held > allocation.escrow) allocation.forfeit = held - allocation.escrow;
    }
    let rest = amount - (allocation.escrow ?? 0);
    if (rest > 0) {
      if (!order.seller_protected) {
        // The seller's balance may be in their own currency: count it in settlement terms at the order's rate.
        const avail = toSettlement(order, Math.max(0, await sellerAvailable(s.tx, order.seller_id, sellerCurrencyOf(order))));
        allocation.seller_available = Math.min(avail, rest);
        rest -= allocation.seller_available;
      }
      allocation.reserve = rest;
    }
    const postings = [{ account: clearing, amountCents: amount }];
    if (allocation.escrow) postings.push({ account: await accountId(s.tx, 'escrow', order.currency), amountCents: -allocation.escrow });
    if (allocation.seller_available) postings.push(await sellerLeg(s.tx, order, -allocation.seller_available, 'chargeback_debit'));
    if (allocation.reserve) postings.push({ account: await accountId(s.tx, 'reserve', order.currency), amountCents: -allocation.reserve });
    if (allocation.forfeit) {
      postings.push({ account: await accountId(s.tx, 'escrow', order.currency), amountCents: -allocation.forfeit });
      postings.push({ account: await accountId(s.tx, 'treasury', order.currency), amountCents: allocation.forfeit });
    }
    await post(s.tx, postings, 'chargeback_debit', order.id);

    const cb = await one(
      s.tx,
      `INSERT INTO chargebacks (order_id, provider_ref, network, reason_code, category, amount_cents, respond_by, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), $8) RETURNING id, order_id, network, reason_code, category, amount_cents, respond_by, status`,
      [order.id, input.disputeRef ?? null, input.network, input.reasonCode, spec.category, amount, RESPONSE_WINDOW_DAYS[input.network], JSON.stringify({ allocation })],
    );
    if (order.status !== 'charged_back') {
      await s.tx.query(`UPDATE orders SET status = 'charged_back', escrow_frozen = true, version = version + 1, updated_at = now() WHERE id = $1`, [order.id]);
      await s.tx.query('INSERT INTO order_events (order_id, from_status, to_status, reason, meta) VALUES ($1, $2, $3, $4, $5)', [
        order.id, order.status, 'charged_back', 'chargeback_received', { network: input.network, reason_code: input.reasonCode },
      ]);
    }
    await enqueueEmail(s.tx, order.seller_id, 'chargeback_received', {
      order_id: order.id, network: input.network, reason_code: input.reasonCode, amount_cents: amount, seller_protected: order.seller_protected,
    });
    await enqueueWebhook(s.tx, order.seller_id, 'chargeback.created', {
      order_id: order.id, network: input.network, reason_code: input.reasonCode, amount_cents: amount, seller_protected: order.seller_protected,
    });
    return cb;
  });

  if (cb.status === 'received') await buildAndSubmitPacket(ctx, cb.id);
  return cb;
}

export async function closeChargeback(ctx: Ctx, disputeRef: string, won: boolean) {
  return withScope(ctx, async (s) => {
    const cb = await maybeOne(s.tx, 'SELECT * FROM chargebacks WHERE provider_ref = $1 FOR UPDATE', [disputeRef]);
    if (!cb || ['won', 'lost'].includes(cb.status)) return cb;
    await s.tx.query('UPDATE chargebacks SET status = $2 WHERE id = $1', [cb.id, won ? 'won' : 'lost']);
    if (won) {
      // Funds returned by the issuer: reverse the original allocation.
      const order = await one(s.tx, 'SELECT * FROM orders WHERE id = $1', [cb.order_id]);
      const a = (cb.evidence?.allocation ?? {}) as Record<string, number>;
      const postings = [{ account: await accountId(s.tx, 'gateway_clearing', order.currency), amountCents: -cb.amount_cents }];
      if (a.escrow) postings.push({ account: await accountId(s.tx, 'escrow', order.currency), amountCents: a.escrow });
      if (a.seller_available) postings.push(await sellerLeg(s.tx, order, a.seller_available, 'chargeback_reversal'));
      if (a.reserve) postings.push({ account: await accountId(s.tx, 'reserve', order.currency), amountCents: a.reserve });
      if (a.forfeit) {
        postings.push({ account: await accountId(s.tx, 'escrow', order.currency), amountCents: a.forfeit });
        postings.push({ account: await accountId(s.tx, 'treasury', order.currency), amountCents: -a.forfeit });
      }
      await post(s.tx, postings, 'chargeback_reversal', order.id);
      // Money is back where it was, so the order goes back to its pre-chargeback state.
      const prev = await maybeOne<{ from_status: string }>(
        s.tx,
        `SELECT from_status FROM order_events WHERE order_id = $1 AND to_status = 'charged_back' ORDER BY id DESC LIMIT 1`,
        [order.id],
      );
      if (prev?.from_status && order.status === 'charged_back') {
        await s.tx.query(`UPDATE orders SET status = $2, escrow_frozen = false, version = version + 1, updated_at = now() WHERE id = $1`, [order.id, prev.from_status]);
        await s.tx.query('INSERT INTO order_events (order_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)', [
          order.id, 'charged_back', prev.from_status, 'chargeback_won',
        ]);
      }
    }
    return { ...cb, status: won ? 'won' : 'lost' };
  });
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
export async function collectEvidence(q: Queryable, chargebackId: string) {
  const cb = await one(q, 'SELECT * FROM chargebacks WHERE id = $1', [chargebackId]);
  const order = await one(
    q,
    `SELECT o.*, u.email AS buyer_email, u.created_at AS buyer_since, u.kyc_tier AS buyer_kyc_tier,
            u.email_verified_at, u.phone_verified_at, host(o.buyer_ip) AS buyer_ip_text
       FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.id = $1`,
    [cb.order_id],
  );
  const payment = await maybeOne(q, 'SELECT * FROM payment_details WHERE order_id = $1', [order.id]);
  const delivery = await many(q, `SELECT id, fingerprint, delivered_at FROM inventory_items WHERE order_id = $1 AND status IN ('delivered', 'revoked') ORDER BY delivered_at`, [order.id]);
  const events = await many(q, 'SELECT from_status, to_status, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY id', [order.id]);
  const room = await one<{ id: string }>(q, 'SELECT id FROM chat_rooms WHERE order_id = $1', [order.id]);

  const common = {
    order: {
      id: order.id, amount: `${(order.amount_cents / 100).toFixed(2)} ${order.currency}`, created_at: order.created_at,
      paid_at: order.paid_at, delivered_at: order.delivered_at, completed_at: order.completed_at, protection: order.protection,
    },
    customer: {
      email: order.buyer_email, account_since: order.buyer_since, kyc_tier: order.buyer_kyc_tier,
      email_verified_at: order.email_verified_at, phone_verified_at: order.phone_verified_at,
    },
    terms_acceptance: { tos_version: order.tos_version, accepted_at: order.tos_accepted_at, ip: order.buyer_ip_text },
    digital_delivery: {
      delivered_at: order.delivered_at,
      items: delivery.map((d) => ({ id: d.id, fingerprint: d.fingerprint, delivered_at: d.delivered_at })),
    },
    timeline: events,
  };

  let specific: Record<string, unknown> = {};
  if (cb.category === 'fraud') {
    const prior = await many(
      q,
      `SELECT o.id, o.created_at, o.amount_cents, o.buyer_device
         FROM orders o LEFT JOIN payment_details p ON p.order_id = o.id
        WHERE o.buyer_id = $1 AND o.id <> $2 AND o.status = 'completed'
          AND (o.buyer_device = $3 OR p.card_fingerprint = $4)
        ORDER BY o.created_at DESC LIMIT 20`,
      [order.buyer_id, order.id, order.buyer_device, payment?.card_fingerprint ?? null],
    );
    specific = {
      avs_result: payment?.avs_result ?? 'unavailable',
      cvv_result: payment?.cvv_result ?? 'unavailable',
      card: payment ? `${payment.card_brand ?? ''} •••• ${payment.card_last4 ?? ''}` : null,
      ip_address: order.buyer_ip_text,
      ip_country: order.buyer_ip_country ?? payment?.ip_country ?? 'unknown',
      billing_country: payment?.billing_country ?? 'unknown',
      ip_matches_billing: !!(order.buyer_ip_country && payment?.billing_country && order.buyer_ip_country === payment.billing_country),
      device_fingerprint: order.buyer_device,
      prior_undisputed_orders_same_device_or_card: prior,
    };
  } else if (cb.category === 'not_as_described') {
    const snap = await maybeOne(q, 'SELECT snapshot, sha256, created_at FROM offer_snapshots WHERE order_id = $1', [order.id]);
    const dispute = await maybeOne(q, 'SELECT reason, created_at FROM disputes WHERE order_id = $1', [order.id]);
    const buyerMessages = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM chat_messages WHERE room_id = $1 AND sender_id = $2', [room.id, order.buyer_id]);
    specific = {
      listing_snapshot: snap?.snapshot, listing_snapshot_sha256: snap?.sha256,
      customer_contacted_seller: buyerMessages.n > 0,
      customer_opened_platform_dispute: !!dispute,
      platform_dispute: dispute,
    };
  } else {
    const refunds = await many(q, `SELECT txn_id, amount_cents, memo, created_at FROM ledger_entries WHERE order_id = $1 AND memo IN ('refund', 'chargeback_debit')`, [order.id]);
    specific = {
      refund_ledger_entries: refunds,
      refund_issued: refunds.some((r) => r.memo === 'refund'),
      cancellation_policy:
        'Digital goods are delivered instantly and are non-refundable once delivered unless a dispute is opened within the protection window. ' +
        `The customer accepted this policy (ToS ${order.tos_version}) at ${new Date(order.tos_accepted_at).toISOString()}.`,
      disputed_within_window: !!(await maybeOne(q, 'SELECT 1 FROM disputes WHERE order_id = $1', [order.id])),
    };
  }

  const attachments = await many(
    q,
    `SELECT a.original_name, a.sha256, a.width, a.height, a.created_at,
            CASE WHEN a.uploader_id = $2 THEN 'buyer' ELSE 'seller' END AS uploaded_by
       FROM chat_attachments a WHERE a.room_id = $1 AND a.status = 'clean' ORDER BY a.created_at`,
    [room.id, order.buyer_id],
  );
  const chain = await verifyChain(q, room.id);
  const chat = await listMessages(q, room.id, 0, 500);
  return {
    chargeback: { id: cb.id, network: cb.network, reason_code: cb.reason_code, category: cb.category, amount_cents: cb.amount_cents, respond_by: cb.respond_by },
    spec: classify(cb.network, cb.reason_code, cb.category),
    common,
    specific,
    chat: { integrity: chain, attachments, messages: chat.map((m) => ({ seq: m.seq, at: m.created_at, from: m.sender_id === order.buyer_id ? 'buyer' : m.sender_id ? 'seller' : 'system', body: m.body, hash: m.hash })) },
  };
}

export type Evidence = Awaited<ReturnType<typeof collectEvidence>>;

export function renderPacketPdf(ev: Evidence): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Representment ${ev.chargeback.id}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const h = (t: string) => doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).text(t).moveDown(0.3).font('Helvetica').fontSize(9.5);
    const kv = (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) {
        const val = v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—');
        doc.font('Helvetica-Bold').text(`${k.replace(/_/g, ' ')}: `, { continued: true }).font('Helvetica').text(val);
      }
    };

    doc.font('Helvetica-Bold').fontSize(18).text('Chargeback Representment Packet');
    doc.font('Helvetica').fontSize(10).text(ev.spec.title).text(`Respond by: ${new Date(ev.chargeback.respond_by).toISOString()}`);
    doc.moveDown(0.5).fontSize(9.5).text(`Evidence strategy: ${ev.spec.strategy}`);

    h('1. Transaction');
    kv({ chargeback_id: ev.chargeback.id, amount_disputed: `${(ev.chargeback.amount_cents / 100).toFixed(2)}`, ...ev.common.order });
    h('2. Customer & Terms Acceptance');
    kv({ ...ev.common.customer, ...ev.common.terms_acceptance });
    h('3. Digital Delivery Proof');
    kv({ delivered_at: ev.common.digital_delivery.delivered_at, items_delivered: ev.common.digital_delivery.items.length });
    for (const i of ev.common.digital_delivery.items) doc.text(`  • item ${i.id} delivered ${new Date(i.delivered_at).toISOString()} (fingerprint ${i.fingerprint.slice(0, 16)}…)`);
    h(`4. Reason-Code Evidence (${ev.chargeback.category.replace(/_/g, ' ')})`);
    kv(ev.specific);
    h('5. Order Timeline');
    for (const e of ev.common.timeline) doc.text(`  ${new Date(e.created_at).toISOString()}  ${e.from_status ?? '∅'} → ${e.to_status}  (${e.reason ?? ''})`);
    h('6. Communication Log (tamper-evident)');
    doc.text(
      `Hash chain ${ev.chat.integrity.valid ? 'VERIFIED' : 'BROKEN at seq ' + ev.chat.integrity.brokenAtSeq}: ${ev.chat.integrity.messages} messages, head ${ev.chat.integrity.headHash}. ` +
        'All buyer–seller communication is required to occur on-platform; off-platform contact is prohibited by the Terms of Service.',
    );
    if (ev.chat.attachments.length) {
      doc.moveDown(0.3).text('Image evidence (malware-scanned, re-encoded; SHA-256 of the stored file):');
      for (const a of ev.chat.attachments) {
        doc.text(`  • ${a.original_name} (${a.width}×${a.height}) by ${a.uploaded_by} at ${new Date(a.created_at).toISOString()} — ${a.sha256}`);
      }
    }
    doc.moveDown(0.3);
    for (const m of ev.chat.messages) doc.text(`  #${m.seq} [${new Date(m.at).toISOString()}] ${m.from}: ${m.body}`);
    doc.end();
  });
}

export async function buildAndSubmitPacket(ctx: Ctx, chargebackId: string) {
  const evidence = await collectEvidence(ctx.db, chargebackId);
  const pdf = await renderPacketPdf(evidence);
  await ctx.db.query(
    `UPDATE chargebacks SET status = 'packet_ready', packet_pdf = $2, packet_sha256 = $3,
            evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object('packet', $4::jsonb) WHERE id = $1`,
    [chargebackId, pdf, sha256(pdf), JSON.stringify({ specific: evidence.specific, spec: evidence.spec })],
  );
  const cb = await one(ctx.db, 'SELECT provider_ref FROM chargebacks WHERE id = $1', [chargebackId]);
  if (cb.provider_ref) {
    try {
      const summary = `${evidence.spec.title}. ${evidence.spec.strategy} Digital goods delivered at ${evidence.common.order.delivered_at ?? 'n/a'}.`;
      await ctx.payments.submitChargebackEvidence(cb.provider_ref, { summary, pdf });
      await ctx.db.query(`UPDATE chargebacks SET status = 'submitted' WHERE id = $1`, [chargebackId]);
    } catch (err) {
      ctx.log.error({ err, chargebackId }, 'evidence submission failed; packet kept for manual submission');
    }
  }
  return { bytes: pdf.length };
}
