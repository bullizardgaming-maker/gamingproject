import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne } from '../db.js';
import { postUserMessage } from '../domain/chat.js';
import { bulkUpdatePrices, uploadInventory } from '../domain/offers.js';
import { deliverManually } from '../domain/orders.js';
import { getInvoice, invoicePdf, listInvoices } from '../domain/invoices.js';
import { listDeliveries, redeliver, replayDead } from '../domain/webhooks.js';
import { notFound } from '../lib/errors.js';
import { me, requireScope } from '../server.js';
import { ChatMessageBody, DeliverBody, InventoryUploadBody, MerchantOrdersQuery, PricesBody, ReplayBody, WebhookDeliveriesQuery } from '../api-schemas.js';

/**
 * Seller automation API, authenticated with `Authorization: Bearer mk_...` API keys.
 * Mirrors what high-volume merchants run bots against: poll orders, push stock,
 * reprice, deliver, and talk to buyers — all recorded exactly like UI actions.
 */
export async function merchantRoutes(app: FastifyInstance, ctx: Ctx) {
  const scope = requireScope(ctx);
  const Id = z.object({ id: z.string().uuid() });

  app.get('/merchant/orders', { preHandler: scope('orders:read') }, async (req) => {
    const q = MerchantOrdersQuery.parse(req.query);
    return many(
      ctx.db,
      `SELECT o.id, o.offer_id, f.title AS offer_title, o.buyer_id, o.quantity, o.amount_cents, o.currency, o.commission_bps,
              o.commission_cents, o.seller_net_cents, o.status, o.rail, o.protection, o.protection_ends_at,
              o.paid_at, o.delivered_at, o.completed_at, o.created_at, r.id AS chat_room_id
         FROM orders o JOIN offers f ON f.id = o.offer_id JOIN chat_rooms r ON r.order_id = o.id
        WHERE o.seller_id = $1 AND ($2::text IS NULL OR o.status = $2) AND ($3::timestamptz IS NULL OR o.updated_at >= $3)
        ORDER BY o.created_at DESC LIMIT $4`,
      [me(req).id, q.status ?? null, q.since ?? null, q.limit],
    );
  });

  app.get('/merchant/orders/:id', { preHandler: scope('orders:read') }, async (req) => {
    const row = await maybeOne(ctx.db, 'SELECT * FROM orders WHERE id = $1 AND seller_id = $2', [Id.parse(req.params).id, me(req).id]);
    if (!row) throw notFound('Order');
    return row;
  });

  app.post('/merchant/orders/:id/deliver', { preHandler: scope('orders:write') }, async (req) => {
    const { payload } = DeliverBody.parse(req.body ?? {});
    return deliverManually(ctx, Id.parse(req.params).id, me(req).id, payload);
  });

  app.post('/merchant/inventory', { preHandler: scope('inventory:write') }, async (req) => {
    const body = InventoryUploadBody.parse(req.body);
    return uploadInventory(ctx, me(req).id, body.offerId, body.format, body.content);
  });

  app.patch('/merchant/prices', { preHandler: scope('offers:write') }, async (req) => {
    const { updates } = PricesBody.parse(req.body);
    return { results: await bulkUpdatePrices(ctx, me(req).id, updates) };
  });

  app.post('/merchant/chat/:id/messages', { preHandler: scope('chat:write') }, async (req, reply) => {
    const { body } = ChatMessageBody.parse(req.body);
    return reply.status(201).send(await postUserMessage(ctx, Id.parse(req.params).id, me(req), body));
  });

  // --- Webhook deliveries (for bots that watch their own integration health) --------------
  app.get('/merchant/webhooks/deliveries', { preHandler: scope('webhooks:manage') }, async (req) => {
    return listDeliveries(ctx, me(req).id, WebhookDeliveriesQuery.parse(req.query));
  });
  app.post('/merchant/webhooks/deliveries/:id/redeliver', { preHandler: scope('webhooks:manage') }, async (req) => redeliver(ctx, me(req).id, Id.parse(req.params).id));
  app.post('/merchant/webhooks/:id/replay', { preHandler: scope('webhooks:manage') }, async (req) => {
    const { since } = ReplayBody.parse(req.body ?? {});
    return replayDead(ctx, me(req).id, Id.parse(req.params).id, since);
  });

  // --- Invoices (and accounting exports) -------------------------------------------------
  app.get('/merchant/invoices', { preHandler: scope('reports:read') }, async (req) => listInvoices(ctx, me(req).id));
  app.get('/merchant/invoices/:id/pdf', { preHandler: scope('reports:read') }, async (req, reply) => {
    const inv = await getInvoice(ctx, Id.parse(req.params).id, me(req).id);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    return reply.send(await invoicePdf(inv));
  });
}
