import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { maybeOne, one } from '../db.js';
import { getOrCreateInquiryRoom, listMessages, listRooms, postUserMessage, roomForParticipant, verifyChain } from '../domain/chat.js';
import { revealDelivered } from '../domain/inventory.js';
import {
  cancelLateOrder, cancelOrder, confirmOrder, createOrder, quoteOrder, deliverManually, getOrderFor, listOrders, openDispute, updateChecklist,
  STAFF_RELEASE_AFTER_HOURS,
} from '../domain/orders.js';
import { buildEscrowTerms } from '../domain/web3.js';
import { MAX_CART_ITEMS, cartView, createCartCheckout } from '../domain/cart.js';
import { DISPUTE_CATEGORIES, addStatement } from '../domain/disputes.js';
import { CLAIM_REASONS, buyerRespond, openClaim, sellerRespond } from '../domain/warranty.js';
import { postProgress } from '../domain/progress.js';
import { startHandover } from '../domain/linkedAccounts.js';
import { createTicket } from '../domain/support.js';
import { coinsFor, paymentsFor, refreshCryptoPayment, setRefundAddress, startCryptoPayment } from '../domain/cryptoPayments.js';
import { BUYER_TAGS, buyerReputation, rateBuyer } from '../domain/buyerReputation.js';
import { createReview, replyToReview, sellerProfile } from '../domain/reviews.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { readAttachment, uploadAttachment } from '../domain/attachments.js';
import { audit } from '../domain/audit.js';
import { readBanner } from '../domain/storefront.js';
import { me, requestMeta } from '../server.js';

const Id = z.object({ id: z.string().uuid() });

export async function orderRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/orders', async (req, reply) => {
    const body = z
      .object({
        offerId: z.string().uuid(),
        quantity: z.number().int().positive().max(1000).default(1),
        rail: z.enum(['fiat', 'crypto']).default('fiat'),
        acceptTos: z.literal(true),
        walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        promoCode: z.string().trim().min(1).max(40).optional(),
        sellerCode: z.string().trim().min(1).max(40).optional(),
        useCredit: z.boolean().optional(),
        currency: z.string().length(3).toUpperCase().optional(),
        characterName: z.string().trim().min(1).max(60).optional().describe('In-game character name or UID, for games that deliver in-game'),
      })
      .parse(req.body);
    const idem = req.headers['idempotency-key'];
    const m = requestMeta(req);
    const res = await createOrder(ctx, {
      buyer: me(req),
      ...body,
      idempotencyKey: typeof idem === 'string' ? idem.slice(0, 100) : undefined,
      ip: m.ip,
      ipCountry: m.ipCountry,
      device: m.device,
    });
    return reply.status(res.replayed ? 200 : 201).send(res);
  });

  /** Cart: several listings in one card payment; each listing becomes its own escrow order. */
  app.post('/orders/cart', async (req, reply) => {
    const body = z
      .object({
        items: z.array(z.object({ offerId: z.string().uuid(), quantity: z.number().int().positive().max(1000).default(1), characterName: z.string().trim().min(1).max(60).optional() })).min(1).max(MAX_CART_ITEMS),
        acceptTos: z.literal(true),
        currency: z.string().length(3).toUpperCase().optional(),
      })
      .parse(req.body);
    const idem = req.headers['idempotency-key'];
    const m = requestMeta(req);
    const res = await createCartCheckout(ctx, {
      buyer: me(req), ...body, rail: 'fiat',
      idempotencyKey: typeof idem === 'string' ? idem.slice(0, 100) : undefined,
      ip: m.ip, ipCountry: m.ipCountry, device: m.device,
    });
    return reply.status(res.replayed ? 200 : 201).send(res);
  });
  app.get('/checkouts/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const c = await maybeOne(ctx.db, 'SELECT buyer_id FROM checkouts WHERE id = $1', [id]);
    if (!c || c.buyer_id !== me(req).id) throw notFound('Checkout');
    return cartView(ctx.db, id);
  });

  /** Price breakdown before paying: FX conversion, promo discount, store credit, card amount. */
  app.post('/orders/quote', async (req) => {
    const body = z
      .object({
        offerId: z.string().uuid(),
        quantity: z.number().int().positive().max(1000).default(1),
        rail: z.enum(['fiat', 'crypto']).default('fiat'),
        promoCode: z.string().trim().min(1).max(40).optional(),
        sellerCode: z.string().trim().min(1).max(40).optional(),
        useCredit: z.boolean().optional(),
        currency: z.string().length(3).toUpperCase().optional(),
      })
      .parse(req.body);
    return quoteOrder(ctx, me(req).id, body);
  });

  app.get('/orders', async (req) => {
    const q = z.object({ as: z.enum(['buyer', 'seller']).default('buyer'), status: z.string().optional() }).parse(req.query);
    return listOrders(ctx.db, me(req).id, q.as, q.status);
  });

  app.get('/orders/:id', async (req) => {
    const user = me(req);
    const order = await getOrderFor(ctx, Id.parse(req.params).id, user);
    // Staff reading someone else's order (and its chat) is logged.
    if (order.buyer_id !== user.id && order.seller_id !== user.id) await audit(ctx.db, req, 'order.viewed', { type: 'order', id: order.id });
    return order;
  });

  /** Buyer-only: decrypt delivered codes/credentials. */
  app.get('/orders/:id/items', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const user = me(req);
    const order = await maybeOne(ctx.db, 'SELECT buyer_id FROM orders WHERE id = $1', [id]);
    if (!order || order.buyer_id !== user.id) throw notFound('Order');
    reply.header('Cache-Control', 'no-store');
    return revealDelivered(ctx, id);
  });

  /** Manual delivery. Goods handed over in-game need a photo/video proof (a chat attachment on this order). */
  app.post('/orders/:id/deliver', async (req) => {
    const { payload, proofAttachmentId } = z.object({ payload: z.string().max(8_000).optional(), proofAttachmentId: z.string().uuid().optional() }).parse(req.body ?? {});
    return deliverManually(ctx, Id.parse(req.params).id, me(req).id, payload, proofAttachmentId);
  });

  app.post('/orders/:id/confirm', async (req) => {
    const body = z.object({ handoverConsent: z.boolean().optional() }).parse(req.body ?? {});
    return confirmOrder(ctx, Id.parse(req.params).id, me(req).id, body);
  });

  /** Seller follow-up: the buyer has not confirmed 24h+ after delivery; opens a support ticket for release. */
  app.post('/orders/:id/follow-up', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const user = me(req);
    const { message } = z.object({ message: z.string().trim().max(2_000).optional() }).parse(req.body ?? {});
    const o = await maybeOne<{ seller_id: string; status: string; delivered_at: string | null; title: string }>(
      ctx.db, 'SELECT o.seller_id, o.status, o.delivered_at, f.title FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.id = $1', [id],
    );
    if (!o || o.seller_id !== user.id) throw notFound('Order');
    if (o.status !== 'delivered') throw conflict('invalid_state', `This order is ${o.status}`);
    const since = Date.now() - new Date(o.delivered_at!).getTime();
    if (since < STAFF_RELEASE_AFTER_HOURS * 3_600_000) throw conflict('too_early', `You can ask for a release ${STAFF_RELEASE_AFTER_HOURS} hours after delivery`);
    const open = await maybeOne(ctx.db, `SELECT id FROM support_tickets WHERE order_id = $1 AND user_id = $2 AND status <> 'resolved'`, [id, user.id]);
    if (open) throw conflict('already_open', 'You already have an open request on this order');
    const hours = Math.floor(since / 3_600_000);
    const ticketId = await createTicket(ctx, user.id, {
      category: 'order',
      subject: `Release request: ${o.title}`,
      orderId: id,
      body: `Delivered ${hours} hours ago and the buyer has not confirmed. Please review the delivery proof in the order chat and release the payment.${message ? `\n\n${message}` : ''}`,
    });
    return reply.status(201).send({ ticketId });
  });

  // --- Crypto checkout (NOWPayments): coin picker, payment address, status, refund address ----------
  const Coin = z.object({ coin: z.string().min(2).max(20).toLowerCase() });
  const PayId = z.object({ id: z.string().uuid(), pid: z.string().max(40) });
  for (const kind of ['orders', 'checkouts'] as const) {
    const refOf = (id: string) => (kind === 'orders' ? { orderId: id } : { checkoutId: id });
    app.get(`/${kind}/:id/crypto/coins`, async (req) => coinsFor(ctx, refOf(Id.parse(req.params).id), me(req).id));
    app.post(`/${kind}/:id/crypto/pay`, async (req, reply) => {
      const { coin } = Coin.parse(req.body);
      return reply.status(201).send(await startCryptoPayment(ctx, refOf(Id.parse(req.params).id), me(req).id, coin));
    });
    app.get(`/${kind}/:id/crypto/payments`, async (req) => {
      const { id } = Id.parse(req.params);
      const o = await maybeOne<{ buyer_id: string }>(ctx.db, `SELECT buyer_id FROM ${kind} WHERE id = $1`, [id]);
      if (!o || o.buyer_id !== me(req).id) throw notFound(kind === 'orders' ? 'Order' : 'Checkout');
      return paymentsFor(ctx.db, refOf(id));
    });
    app.post(`/${kind}/:id/crypto/payments/:pid/refresh`, async (req) => {
      const { id, pid } = PayId.parse(req.params);
      return refreshCryptoPayment(ctx, refOf(id), me(req).id, pid);
    });
  }
  app.put('/orders/:id/refund-address', async (req) => {
    const body = z.object({ address: z.string().trim().min(10).max(128), currency: z.string().min(2).max(20) }).parse(req.body);
    return setRefundAddress(ctx, Id.parse(req.params).id, me(req).id, body);
  });

  /** Handover check: the buyer signs in to the account they bought; the callback ticks the checklist. */
  app.post('/orders/:id/handover/start', async (req) => {
    const body = z.object({ mockAccount: z.string().max(80).optional() }).parse(req.body ?? {});
    return startHandover(ctx, Id.parse(req.params).id, me(req).id, body);
  });

  app.post('/orders/:id/cancel', async (req) => cancelOrder(ctx, Id.parse(req.params).id, me(req).id, 'buyer_cancelled'));

  /** Paid but undelivered past the promised delivery time: full refund. */
  app.post('/orders/:id/cancel-late', async (req) => cancelLateOrder(ctx, Id.parse(req.params).id, me(req).id));

  app.post('/orders/:id/dispute', async (req) => {
    const { reason, category } = z.object({ reason: z.string().trim().min(10).max(2_000), category: z.enum(DISPUTE_CATEGORIES).default('other') }).parse(req.body);
    return openDispute(ctx, Id.parse(req.params).id, me(req).id, reason, category);
  });
  /** Either side adds a written statement to an open dispute (up to five each). */
  app.post('/orders/:id/dispute/statements', async (req, reply) => {
    const { body } = z.object({ body: z.string().trim().min(10).max(2_000) }).parse(req.body);
    return reply.status(201).send(await addStatement(ctx, Id.parse(req.params).id, me(req).id, body));
  });

  /** The seller rates the buyer once the order is complete (positive/negative, tags from a fixed list). */
  app.post('/orders/:id/buyer-rating', async (req, reply) => {
    const body = z.object({ positive: z.boolean(), tags: z.array(z.enum(BUYER_TAGS)).max(4).default([]) }).parse(req.body);
    return reply.status(201).send(await rateBuyer(ctx, me(req).id, Id.parse(req.params).id, body));
  });
  /** A buyer's own reputation, as sellers see it. */
  app.get('/me/buyer-reputation', async (req) => buyerReputation(ctx.db, me(req).id));

  /** Boosting orders: the seller posts a progress milestone (percent, note, optional chat screenshot). */
  app.post('/orders/:id/progress', async (req, reply) => {
    const body = z.object({ percent: z.number().int().min(0).max(100), note: z.string().trim().max(500).default(''), attachmentId: z.string().uuid().optional() }).parse(req.body);
    return reply.status(201).send(await postProgress(ctx, me(req).id, Id.parse(req.params).id, body));
  });

  // Account warranty claims (after release, while the order's warranty runs).
  app.post('/orders/:id/warranty-claims', async (req, reply) => {
    const body = z.object({ reason: z.enum(CLAIM_REASONS), details: z.string().trim().min(10).max(2_000) }).parse(req.body);
    return reply.status(201).send(await openClaim(ctx, me(req).id, Id.parse(req.params).id, body));
  });
  app.post('/warranty-claims/:id/seller', async (req) => {
    const body = z.object({ action: z.enum(['fixed', 'refund', 'contest']), message: z.string().trim().max(1_000).optional() }).parse(req.body);
    return sellerRespond(ctx, me(req).id, Id.parse(req.params).id, body);
  });
  app.post('/warranty-claims/:id/buyer', async (req) => {
    const { action } = z.object({ action: z.enum(['confirm', 'escalate', 'withdraw']) }).parse(req.body);
    return buyerRespond(ctx, me(req).id, Id.parse(req.params).id, action);
  });

  app.patch('/orders/:id/checklist', async (req) => {
    const body = z.object({ key: z.string(), done: z.boolean() }).parse(req.body);
    return updateChecklist(ctx, Id.parse(req.params).id, me(req).id, body.key, body.done);
  });

  /** EIP-712 terms the buyer submits to the escrow contract together with the deposit. */
  app.get('/orders/:id/crypto-terms', async (req) => {
    const { id } = Id.parse(req.params);
    const { token, wallet } = z
      .object({ token: z.enum(['USDC', 'USDT']).default('USDC'), wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })
      .parse(req.query);
    const user = me(req);
    const order = await maybeOne(
      ctx.db,
      `SELECT o.*, c.kind AS category_kind, s.wallet_address AS seller_wallet
         FROM orders o JOIN offers f ON f.id = o.offer_id JOIN categories c ON c.slug = f.category_slug JOIN users s ON s.id = o.seller_id
        WHERE o.id = $1`,
      [id],
    );
    if (!order || order.buyer_id !== user.id) throw notFound('Order');
    if (order.rail !== 'crypto' || order.status !== 'awaiting_payment') throw forbidden('not_payable', 'Order is not awaiting a crypto deposit');
    return buildEscrowTerms(ctx, order, wallet, order.seller_wallet, token);
  });

  // --- Reviews ------------------------------------------------------------------
  app.post('/orders/:id/review', async (req, reply) => {
    const body = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1_000).default('') }).parse(req.body);
    return reply.status(201).send(await createReview(ctx, Id.parse(req.params).id, me(req).id, body.rating, body.comment));
  });
  app.post('/reviews/:id/reply', async (req) => {
    const { reply } = z.object({ reply: z.string().trim().min(1).max(1_000) }).parse(req.body);
    return replyToReview(ctx, Id.parse(req.params).id, me(req).id, reply);
  });
  app.get('/sellers/:id', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().positive().max(50).default(20), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return sellerProfile(ctx.dbRead, Id.parse(req.params).id, q.limit, q.offset);
  });
  app.get('/sellers/:id/banner', async (req, reply) => {
    const { bytes, sha256 } = await readBanner(ctx, Id.parse(req.params).id);
    return reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'public, max-age=86400') // the URL carries the hash, so a new banner is a new URL
      .header('ETag', `"${sha256.slice(0, 16)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(bytes);
  });

  // --- Chat (REST mirror of the WebSocket protocol) ----------------------------------
  app.get('/chat/rooms', async (req) => listRooms(ctx.keyring, ctx.db, me(req).id));

  app.post('/chat/rooms', async (req) => {
    const { offerId } = z.object({ offerId: z.string().uuid() }).parse(req.body);
    return getOrCreateInquiryRoom(ctx, offerId, me(req).id);
  });

  app.get('/chat/rooms/:id/messages', async (req) => {
    const { id } = Id.parse(req.params);
    const { afterSeq, limit } = z.object({ afterSeq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().positive().max(500).default(200) }).parse(req.query);
    const user = me(req);
    const room = await roomForParticipant(ctx.db, id, user);
    if (room.buyer_id !== user.id && room.seller_id !== user.id && afterSeq === 0) await audit(ctx.db, req, 'chat.viewed', { type: 'chat_room', id });
    return listMessages(ctx.keyring, ctx.db, id, afterSeq, limit);
  });

  app.post('/chat/rooms/:id/messages', async (req, reply) => {
    const { body } = z.object({ body: z.string().trim().min(1).max(4_000) }).parse(req.body);
    const msg = await postUserMessage(ctx, Id.parse(req.params).id, me(req), body);
    return reply.status(201).send(msg);
  });

  /** Upload a screenshot or a short video (raw PNG/JPEG/WebP/MP4/WebM body; file name in X-Filename). */
  app.post('/chat/rooms/:id/attachments', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!Buffer.isBuffer(req.body)) throw badRequest('unsupported_file', 'Send the file bytes with Content-Type image/png, image/jpeg, image/webp, video/mp4 or video/webm');
    let name = 'screenshot';
    try {
      if (typeof req.headers['x-filename'] === 'string') name = decodeURIComponent(req.headers['x-filename']);
    } catch {
      /* malformed percent-encoding: keep the default name */
    }
    return reply.status(201).send(await uploadAttachment(ctx, id, me(req), name, req.body));
  });

  app.get('/chat/attachments/:id', async (req, reply) => {
    const user = me(req);
    const { att, bytes, isParticipant } = await readAttachment(ctx, Id.parse(req.params).id, user);
    if (!isParticipant) await audit(ctx.db, req, 'attachment.viewed', { type: 'chat_attachment', id: att.id });
    return reply
      .header('Content-Type', att.mime)
      .header('Content-Disposition', `inline; filename="${att.original_name.replace(/"/g, '')}"`)
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('X-Content-Sha256', att.sha256)
      .send(bytes);
  });

  app.get('/chat/rooms/:id/verify', async (req) => {
    const { id } = Id.parse(req.params);
    await roomForParticipant(ctx.db, id, me(req));
    return verifyChain(ctx.db, id, ctx.keyring);
  });

  app.get('/chat/rooms/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const room = await roomForParticipant(ctx.db, id, me(req));
    const names = await one(ctx.db, 'SELECT b.display_name AS buyer_name, s.display_name AS seller_name FROM users b, users s WHERE b.id = $1 AND s.id = $2', [room.buyer_id, room.seller_id]);
    return { ...room, ...names };
  });
}
