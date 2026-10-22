import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import {
  acceptProposal, closeRequest, createRequest, getRequest, listBoard, listMyProposals, listMyRequests, propose, withdrawProposal,
} from '../domain/requests.js';
import { me } from '../server.js';

const Id = z.object({ id: z.string().uuid() });

/** Buyer requests board: buyers post what they want, sellers propose a price. */
export async function requestRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/requests', async (req) => {
    const q = z
      .object({ game: z.string().trim().max(80).optional(), category: z.string().max(40).optional(), q: z.string().trim().max(80).optional() })
      .parse(req.query);
    return listBoard(ctx.dbRead, q);
  });

  app.get('/requests/mine', async (req) => listMyRequests(ctx.db, me(req).id));
  app.get('/requests/proposals/mine', async (req) => listMyProposals(ctx.db, me(req).id));

  app.post('/requests', async (req, reply) => {
    const body = z
      .object({
        game: z.string().trim().min(1).max(80),
        categorySlug: z.string().max(40),
        title: z.string().trim().min(5).max(140),
        description: z.string().trim().max(2_000).optional(),
        budgetCents: z.number().int().positive().max(100_000_00).optional(),
        currency: z.string().length(3).toUpperCase().optional(),
        attributes: z.record(z.string().max(30), z.string().max(60)).optional(),
      })
      .parse(req.body);
    return reply.status(201).send(await createRequest(ctx, me(req), body));
  });

  app.get('/requests/:id', async (req) => getRequest(ctx.db, Id.parse(req.params).id, req.user?.id));
  app.post('/requests/:id/close', async (req) => closeRequest(ctx, Id.parse(req.params).id, me(req).id));

  app.post('/requests/:id/proposals', async (req, reply) => {
    const body = z
      .object({
        priceCents: z.number().int().positive().max(100_000_00).optional(),
        deliveryHours: z.number().int().min(1).max(168).optional(),
        message: z.string().trim().max(1_000).optional(),
        offerId: z.string().uuid().optional(),
      })
      .refine((b) => b.offerId || (b.priceCents != null && b.deliveryHours != null), 'Give a price and a delivery time, or offer one of your listings')
      .parse(req.body);
    return reply.status(201).send(await propose(ctx, me(req), Id.parse(req.params).id, body));
  });
  app.delete('/requests/:id/proposals/mine', async (req) => withdrawProposal(ctx, me(req).id, Id.parse(req.params).id));
  app.post('/requests/:id/proposals/:proposalId/accept', async (req) => {
    const p = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() }).parse(req.params);
    return acceptProposal(ctx, me(req).id, p.id, p.proposalId);
  });
}
