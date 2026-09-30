import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { maybeOne, one } from '../db.js';
import { getOrCreateInquiryRoom, listMessages, listRooms, postUserMessage, roomForParticipant, verifyChain } from '../domain/chat.js';
import { revealDelivered } from '../domain/inventory.js';
import {
  cancelOrder, confirmOrder, createOrder, deliverManually, getOrderFor, listOrders, openDispute, updateChecklist,
} from '../domain/orders.js';
import { buildEscrowTerms } from '../domain/web3.js';
import { forbidden, notFound } from '../lib/errors.js';
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

  app.get('/orders', async (req) => {
    const q = z.object({ as: z.enum(['buyer', 'seller']).default('buyer'), status: z.string().optional() }).parse(req.query);
    return listOrders(ctx.db, me(req).id, q.as, q.status);
  });

  app.get('/orders/:id', async (req) => getOrderFor(ctx.db, Id.parse(req.params).id, me(req)));

  /** Buyer-only: decrypt delivered codes/credentials. */
  app.get('/orders/:id/items', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const user = me(req);
    const order = await maybeOne(ctx.db, 'SELECT buyer_id FROM orders WHERE id = $1', [id]);
    if (!order || order.buyer_id !== user.id) throw notFound('Order');
    reply.header('Cache-Control', 'no-store');
    return revealDelivered(ctx, id);
  });

  app.post('/orders/:id/deliver', async (req) => {
    const { payload } = z.object({ payload: z.string().max(8_000).optional() }).parse(req.body ?? {});
    return deliverManually(ctx, Id.parse(req.params).id, me(req).id, payload);
  });

  app.post('/orders/:id/confirm', async (req) => confirmOrder(ctx, Id.parse(req.params).id, me(req).id));

  app.post('/orders/:id/cancel', async (req) => cancelOrder(ctx, Id.parse(req.params).id, me(req).id, 'buyer_cancelled'));

  app.post('/orders/:id/dispute', async (req) => {
    const { reason } = z.object({ reason: z.string().trim().min(10).max(2_000) }).parse(req.body);
    return openDispute(ctx, Id.parse(req.params).id, me(req).id, reason);
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

  // --- Chat (REST mirror of the WebSocket protocol) ----------------------------------
  app.get('/chat/rooms', async (req) => listRooms(ctx.db, me(req).id));

  app.post('/chat/rooms', async (req) => {
    const { offerId } = z.object({ offerId: z.string().uuid() }).parse(req.body);
    return getOrCreateInquiryRoom(ctx, offerId, me(req).id);
  });

  app.get('/chat/rooms/:id/messages', async (req) => {
    const { id } = Id.parse(req.params);
    const { afterSeq, limit } = z.object({ afterSeq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().positive().max(500).default(200) }).parse(req.query);
    await roomForParticipant(ctx.db, id, me(req));
    return listMessages(ctx.db, id, afterSeq, limit);
  });

  app.post('/chat/rooms/:id/messages', async (req, reply) => {
    const { body } = z.object({ body: z.string().trim().min(1).max(4_000) }).parse(req.body);
    const msg = await postUserMessage(ctx, Id.parse(req.params).id, me(req), body);
    return reply.status(201).send(msg);
  });

  app.get('/chat/rooms/:id/verify', async (req) => {
    const { id } = Id.parse(req.params);
    await roomForParticipant(ctx.db, id, me(req));
    return verifyChain(ctx.db, id);
  });

  app.get('/chat/rooms/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const room = await roomForParticipant(ctx.db, id, me(req));
    const names = await one(ctx.db, 'SELECT b.display_name AS buyer_name, s.display_name AS seller_name FROM users b, users s WHERE b.id = $1 AND s.id = $2', [room.buyer_id, room.seller_id]);
    return { ...room, ...names };
  });
}
