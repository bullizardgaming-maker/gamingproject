import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { cleanAttributes } from './attributeSets.js';
import { assertSupported, getRate } from './fx.js';
import { notify } from './notifications.js';
import { requireSeller } from './offers.js';
import { detectOffPlatform } from './safety.js';

const noContact = (...texts: Array<string | undefined>) => {
  if (detectOffPlatform(texts.filter(Boolean).join('\n')).length) throw badRequest('offplatform_contact', 'Keep contact details and outside payment methods off Bullizard: deals made elsewhere aren’t protected');
};

/**
 * Buyer requests ("wanted" posts). A buyer describes what they want; sellers answer with a price
 * and delivery time. Accepting a proposal creates a manual-delivery listing reserved for that
 * buyer (hidden everywhere else), which they buy through the normal escrow checkout. Nothing is
 * charged until then, so a request can be withdrawn at any time before it's accepted.
 */
export const REQUEST_DAYS = 14;
export const MAX_OPEN_REQUESTS = 10;
/** Sellers already listing in the request's game and category hear about it (newest sellers last). */
export const NOTIFY_SELLERS = 50;

export interface RequestInput {
  game: string;
  categorySlug: string;
  title: string;
  description?: string;
  budgetCents?: number;
  currency?: string;
  attributes?: Record<string, string>;
}

const REQUEST_COLS = `r.id, r.buyer_id, r.game, r.category_slug, r.title, r.description, r.budget_cents, r.currency, r.attributes,
  r.status, r.accepted_proposal_id, r.expires_at, r.created_at, r.updated_at, b.display_name AS buyer_name, c.kind AS category_kind,
  (SELECT count(*)::int FROM request_proposals p WHERE p.request_id = r.id AND p.status IN ('pending', 'accepted')) AS proposals`;
const REQUEST_FROM = `buyer_requests r JOIN users b ON b.id = r.buyer_id JOIN categories c ON c.slug = r.category_slug`;

const PROPOSAL_COLS = `p.id, p.request_id, p.seller_id, p.price_cents, p.delivery_hours, p.message, p.status, p.offer_id, p.created_at, p.updated_at,
  s.display_name AS seller_name,
  (SELECT count(*)::int FROM orders o WHERE o.seller_id = p.seller_id AND o.status = 'completed') AS seller_completed_orders,
  (SELECT round(avg(rating)::numeric, 2) FROM reviews v WHERE v.seller_id = p.seller_id AND NOT v.hidden) AS seller_rating`;

export async function createRequest(ctx: Ctx, buyer: { id: string; kyc_tier: number; status: string }, input: RequestInput) {
  if (buyer.status !== 'active') throw forbidden('suspended', 'Account suspended');
  if (buyer.kyc_tier < 1) throw forbidden('kyc_required', 'Verify your email and phone (Tier 1) before posting a request');
  noContact(input.title, input.description);
  const cat = await maybeOne(ctx.db, 'SELECT slug FROM categories WHERE slug = $1', [input.categorySlug]);
  if (!cat) throw badRequest('unknown_category', 'Unknown category');
  const currency = (input.currency ?? ctx.cfg.SETTLEMENT_CURRENCY).toUpperCase();
  assertSupported(ctx, currency);
  // Wanted posts may leave fields open ("any server"), so only check the values given.
  const attrs = cleanAttributes(input.game, input.categorySlug, input.attributes, { partial: true });
  if (!attrs.ok) throw badRequest('invalid_attributes', attrs.error);

  return withTx(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [buyer.id]);
    const { n } = await one(tx, `SELECT count(*)::int AS n FROM buyer_requests WHERE buyer_id = $1 AND status = 'open' AND expires_at > now()`, [buyer.id]);
    if (n >= MAX_OPEN_REQUESTS) throw conflict('too_many_requests', `You can have up to ${MAX_OPEN_REQUESTS} open requests`);
    const r = await one(
      tx,
      `INSERT INTO buyer_requests (buyer_id, game, category_slug, title, description, budget_cents, currency, attributes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9)) RETURNING id`,
      [buyer.id, input.game, input.categorySlug, input.title, input.description ?? '', input.budgetCents ?? null, currency, JSON.stringify(attrs.value), REQUEST_DAYS],
    );
    const sellers = await many<{ seller_id: string }>(
      tx,
      `SELECT f.seller_id FROM offers f JOIN users u ON u.id = f.seller_id
        WHERE lower(f.game) = lower($1) AND f.category_slug = $2 AND f.status = 'active' AND f.reserved_for IS NULL
          AND u.status = 'active' AND u.deleted_at IS NULL AND f.seller_id <> $3
        GROUP BY f.seller_id ORDER BY max(f.updated_at) DESC LIMIT $4`,
      [input.game, input.categorySlug, buyer.id, NOTIFY_SELLERS],
    );
    for (const s of sellers) {
      await notify(tx, s.seller_id, 'request_posted', { request_id: r.id, title: input.title, game: input.game, budget_cents: input.budgetCents ?? null, currency }, `request:${r.id}:posted:${s.seller_id}`);
    }
    return getRequest(tx, r.id, buyer.id);
  });
}

export interface BoardFilter {
  game?: string;
  category?: string;
  q?: string;
  limit?: number;
}

/** Open requests anyone can browse. Budgets show; buyer identity shows as a display name only. */
export async function listBoard(q: Queryable, f: BoardFilter) {
  const params: unknown[] = [];
  const arg = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = [`r.status = 'open'`, `r.expires_at > now()`, `b.status = 'active'`, `b.deleted_at IS NULL`];
  if (f.game) where.push(`lower(r.game) = lower(${arg(f.game)})`);
  if (f.category) where.push(`r.category_slug = ${arg(f.category)}`);
  if (f.q) where.push(`(r.title ILIKE ${arg(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`)} OR r.game ILIKE $${params.length})`);
  return many(q, `SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ${arg(Math.min(f.limit ?? 50, 100))}`, params);
}

/** A request with the proposals the viewer may see: all of them for its buyer, their own for a seller. */
export async function getRequest(q: Queryable, id: string, viewerId?: string) {
  const r = await maybeOne<any>(q, `SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE r.id = $1`, [id]);
  if (!r) throw notFound('Request');
  const isBuyer = r.buyer_id === viewerId;
  // Closed and expired requests stay visible to their buyer and to sellers who proposed.
  const proposals = viewerId
    ? await many(q, `SELECT ${PROPOSAL_COLS} FROM request_proposals p JOIN users s ON s.id = p.seller_id WHERE p.request_id = $1 ${isBuyer ? `AND p.status <> 'withdrawn'` : 'AND p.seller_id = $2'} ORDER BY p.price_cents, p.created_at`, isBuyer ? [id] : [id, viewerId])
    : [];
  if (r.status !== 'open' && !isBuyer && proposals.length === 0) throw notFound('Request');
  return { ...r, open: r.status === 'open' && new Date(r.expires_at) > new Date(), mine: isBuyer, proposal_list: proposals };
}

export async function listMyRequests(q: Queryable, buyerId: string) {
  return many(q, `SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE r.buyer_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [buyerId]);
}

export async function listMyProposals(q: Queryable, sellerId: string) {
  return many(
    q,
    `SELECT ${PROPOSAL_COLS}, r.title AS request_title, r.game, r.category_slug, r.currency, r.status AS request_status, r.expires_at
       FROM request_proposals p JOIN users s ON s.id = p.seller_id JOIN buyer_requests r ON r.id = p.request_id
      WHERE p.seller_id = $1 ORDER BY p.updated_at DESC LIMIT 100`,
    [sellerId],
  );
}

export async function closeRequest(ctx: Ctx, id: string, buyerId: string) {
  return withTx(ctx.db, async (tx) => {
    const r = await maybeOne(tx, 'SELECT buyer_id, status FROM buyer_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r || r.buyer_id !== buyerId) throw notFound('Request');
    if (r.status !== 'open') throw conflict('not_open', 'This request is no longer open');
    await tx.query(`UPDATE buyer_requests SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
    await tx.query(`UPDATE request_proposals SET status = 'declined', updated_at = now() WHERE request_id = $1 AND status = 'pending'`, [id]);
    return getRequest(tx, id, buyerId);
  });
}

export interface ProposalInput {
  priceCents: number;
  deliveryHours: number;
  message?: string;
}

/** Send or revise a proposal. One per seller per request; revising a withdrawn one re-sends it. */
export async function propose(ctx: Ctx, seller: { id: string; kyc_tier: number; status: string; display_name?: string }, requestId: string, input: ProposalInput) {
  requireSeller(seller);
  noContact(input.message);
  return withTx(ctx.db, async (tx) => {
    const r = await maybeOne(tx, `SELECT buyer_id, status, expires_at, title, currency FROM buyer_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!r) throw notFound('Request');
    if (r.buyer_id === seller.id) throw forbidden('own_request', 'You cannot answer your own request');
    if (r.status !== 'open' || new Date(r.expires_at) <= new Date()) throw conflict('not_open', 'This request is no longer taking proposals');
    const p = await maybeOne(
      tx,
      `INSERT INTO request_proposals (request_id, seller_id, price_cents, delivery_hours, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id, seller_id) DO UPDATE
         SET price_cents = EXCLUDED.price_cents, delivery_hours = EXCLUDED.delivery_hours, message = EXCLUDED.message,
             status = 'pending', updated_at = now()
         WHERE request_proposals.status IN ('pending', 'withdrawn')
       RETURNING id, (xmax = 0) AS created`,
      [requestId, seller.id, input.priceCents, input.deliveryHours, input.message ?? ''],
    );
    if (!p) throw conflict('proposal_closed', 'Your proposal on this request can no longer be changed');
    await notify(tx, r.buyer_id, 'request_proposal', {
      request_id: requestId, title: r.title, seller_name: seller.display_name ?? 'A seller', price_cents: input.priceCents, currency: r.currency,
      delivery_hours: input.deliveryHours, revised: !p.created,
    }, `request:${requestId}:proposal:${p.id}:${Date.now()}`);
    return getRequest(tx, requestId, seller.id);
  });
}

export async function withdrawProposal(ctx: Ctx, sellerId: string, requestId: string) {
  const res = await ctx.db.query(
    `UPDATE request_proposals SET status = 'withdrawn', updated_at = now() WHERE request_id = $1 AND seller_id = $2 AND status = 'pending' RETURNING id`,
    [requestId, sellerId],
  );
  if (!res.rowCount) throw notFound('Proposal');
  return getRequest(ctx.db, requestId, sellerId);
}

/**
 * Accept a proposal: the request closes, other proposals are declined, and the seller's price
 * becomes a one-off manual-delivery listing only this buyer can see. The buyer is sent to its
 * checkout, so payment, escrow, delivery deadlines and disputes all work as for any order.
 */
export async function acceptProposal(ctx: Ctx, buyerId: string, requestId: string, proposalId: string) {
  return withTx(ctx.db, async (tx) => {
    const r = await maybeOne<any>(tx, `SELECT * FROM buyer_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!r || r.buyer_id !== buyerId) throw notFound('Request');
    if (r.status !== 'open' || new Date(r.expires_at) <= new Date()) throw conflict('not_open', 'This request is no longer open');
    const p = await maybeOne<any>(
      tx,
      `SELECT p.*, u.status AS seller_status, u.kyc_tier, u.display_name AS seller_name FROM request_proposals p JOIN users u ON u.id = p.seller_id
        WHERE p.id = $1 AND p.request_id = $2 FOR UPDATE OF p`,
      [proposalId, requestId],
    );
    if (!p || p.status !== 'pending') throw notFound('Proposal');
    if (p.seller_status !== 'active' || p.kyc_tier < 2) throw conflict('seller_unavailable', 'This seller can no longer sell');

    await getRate(ctx, tx, r.currency);
    const offer = await one(
      tx,
      `INSERT INTO offers (seller_id, category_slug, game, title, description, price_cents, currency, delivery_mode, stock, delivery_hours, attributes, reserved_for, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 1, $8, $9, $10, $11) RETURNING id`,
      [p.seller_id, r.category_slug, r.game, r.title, [r.description, p.message].filter(Boolean).join('\n\n'), p.price_cents, r.currency,
       p.delivery_hours, JSON.stringify(r.attributes ?? {}), buyerId, requestId],
    );
    await tx.query(`UPDATE request_proposals SET status = 'accepted', offer_id = $2, updated_at = now() WHERE id = $1`, [proposalId, offer.id]);
    await tx.query(`UPDATE request_proposals SET status = 'declined', updated_at = now() WHERE request_id = $1 AND id <> $2 AND status = 'pending'`, [requestId, proposalId]);
    await tx.query(`UPDATE buyer_requests SET status = 'accepted', accepted_proposal_id = $2, updated_at = now() WHERE id = $1`, [requestId, proposalId]);
    await notify(tx, p.seller_id, 'request_accepted', { request_id: requestId, title: r.title, price_cents: p.price_cents, currency: r.currency, offer_id: offer.id }, `request:${requestId}:accepted`);
    return { offerId: offer.id, request: await getRequest(tx, requestId, buyerId) };
  });
}

/** Worker: close requests whose time ran out. */
export async function expireRequests(ctx: Ctx, limit = 500): Promise<number> {
  return withTx(ctx.db, async (tx) => {
    const due = await many<{ id: string }>(
      tx,
      `UPDATE buyer_requests SET status = 'expired', updated_at = now()
        WHERE id IN (SELECT id FROM buyer_requests WHERE status = 'open' AND expires_at <= now() LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id`,
      [limit],
    );
    if (due.length) {
      await tx.query(`UPDATE request_proposals SET status = 'declined', updated_at = now() WHERE request_id = ANY($1) AND status = 'pending'`, [due.map((d) => d.id)]);
    }
    return due.length;
  });
}
