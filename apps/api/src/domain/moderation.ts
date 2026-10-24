import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { openMessages } from './chat.js';
import { notify } from './notifications.js';
import { detectOffPlatform, matchTerms, type ModerationTerm } from './safety.js';

/**
 * Moderation: listings whose text matches a staff-maintained term (or shares contact details)
 * wait in a review queue instead of going live, and chat messages caught by the off-platform
 * check land in a queue for staff to confirm or dismiss. Terms are cached briefly per process.
 */
let cache: { at: number; terms: ModerationTerm[] } | null = null;
const CACHE_MS = 30_000;

export async function listingTerms(q: Queryable): Promise<ModerationTerm[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.terms;
  const terms = await many<ModerationTerm>(q, 'SELECT term, action FROM moderation_terms ORDER BY action, lower(term)');
  cache = { at: Date.now(), terms };
  return terms;
}

export interface ListingVerdict {
  action: 'allow' | 'review' | 'block';
  reasons: string[];
}

/** Check a listing's title and description. Contact details in a listing always go to review. */
export async function screenListing(q: Queryable, title: string, description: string): Promise<ListingVerdict> {
  const text = `${title}\n${description}`;
  const hits = matchTerms(text, await listingTerms(q));
  const contact = detectOffPlatform(text).map((r) => `contact:${r}`);
  if (hits.some((h) => h.action === 'block')) return { action: 'block', reasons: hits.filter((h) => h.action === 'block').map((h) => `term:${h.term}`) };
  const reasons = [...hits.map((h) => `term:${h.term}`), ...contact];
  return { action: reasons.length ? 'review' : 'allow', reasons };
}

/** Throws for blocked listings; returns the status a new or edited listing should get. */
export async function listingStatusFor(q: Queryable, title: string, description: string): Promise<{ review: boolean; reasons: string[] }> {
  const v = await screenListing(q, title, description);
  if (v.action === 'block') throw badRequest('listing_blocked', 'This listing breaks the rules on prohibited goods and can’t be published');
  return { review: v.action === 'review', reasons: v.reasons };
}

// ---- Listing review queue ------------------------------------------------------------------
export async function reviewQueue(q: Queryable) {
  return many(
    q,
    `SELECT f.id, f.title, f.description, f.game, f.category_slug, f.price_cents, f.currency, f.review_reasons, f.created_at, f.updated_at,
            f.seller_id, u.display_name AS seller_name, u.email AS seller_email,
            u.completed_orders AS seller_completed_orders
       FROM offers f JOIN users u ON u.id = f.seller_id
      WHERE f.status = 'review' ORDER BY f.updated_at LIMIT 200`,
  );
}

export async function decideListing(ctx: Ctx, offerId: string, staffId: string, approve: boolean, note?: string) {
  return withTx(ctx.db, async (tx) => {
    const f = await maybeOne(tx, `SELECT id, seller_id, title, status FROM offers WHERE id = $1 FOR UPDATE`, [offerId]);
    if (!f) throw notFound('Listing');
    if (f.status !== 'review') throw conflict('not_in_review', 'This listing is not waiting for review');
    if (!approve && !note?.trim()) throw badRequest('note_required', 'Tell the seller why the listing was rejected');
    await tx.query(
      `UPDATE offers SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
      [offerId, approve ? 'active' : 'removed', note?.trim() || null, staffId],
    );
    await notify(tx, f.seller_id, approve ? 'listing_approved' : 'listing_rejected', { offer_id: offerId, title: f.title, note: note?.trim() ?? '' }, `listing:${offerId}:${approve ? 'approved' : 'rejected'}:${Date.now()}`);
    return { id: offerId, status: approve ? 'active' : 'removed' };
  });
}

// ---- Flagged chats -------------------------------------------------------------------------
// Flags are raised by postUserMessage (chat.ts) when the off-platform check matches.
/** Open flags with the flagged message and the two before it for context (staff reads are audited by the route). */
export async function chatFlagQueue(ctx: Ctx, status: 'open' | 'confirmed' | 'dismissed' = 'open') {
  const flags = await many<any>(
    ctx.db,
    `SELECT cf.*, u.display_name AS user_name, u.email AS user_email, u.offplatform_strikes, u.status AS user_status,
            r.order_id, r.offer_id, r.buyer_id, r.seller_id,
            (SELECT count(*)::int FROM chat_flags x WHERE x.user_id = cf.user_id AND x.status = 'confirmed') AS confirmed_before
       FROM chat_flags cf JOIN users u ON u.id = cf.user_id JOIN chat_rooms r ON r.id = cf.room_id
      WHERE cf.status = $1 ORDER BY cf.created_at ${status === 'open' ? 'ASC' : 'DESC'} LIMIT 100`,
    [status],
  );
  for (const f of flags) {
    const rows = await many<any>(ctx.db, `SELECT * FROM chat_messages WHERE room_id = $1 AND seq BETWEEN $2 - 2 AND $2 ORDER BY seq`, [f.room_id, f.seq]);
    f.context = (await openMessages(ctx.keyring, ctx.db, rows)).map((m) => ({ seq: m.seq, sender_id: m.sender_id, kind: m.kind, body: m.body, erased: !!m.erased, created_at: m.created_at }));
    f.role = f.user_id === f.seller_id ? 'seller' : 'buyer';
  }
  return flags;
}

export async function decideChatFlag(ctx: Ctx, flagId: string, staffId: string, confirm: boolean, note?: string) {
  const f = await maybeOne(
    ctx.db,
    `UPDATE chat_flags SET status = $2, reviewed_by = $3, note = $4, reviewed_at = now() WHERE id = $1 AND status = 'open' RETURNING id, status, user_id, strike`,
    [flagId, confirm ? 'confirmed' : 'dismissed', staffId, note?.trim() || null],
  );
  if (!f) throw notFound('Open flag');
  // A false alarm shouldn't count towards the automatic suspension.
  if (!confirm && f.strike) await ctx.db.query('UPDATE users SET offplatform_strikes = GREATEST(offplatform_strikes - 1, 0) WHERE id = $1', [f.user_id]);
  return f;
}

// ---- Terms ---------------------------------------------------------------------------------
export async function listTerms(q: Queryable) {
  return many(q, 'SELECT id, term, action, created_at FROM moderation_terms ORDER BY action, lower(term)');
}

export async function addTerm(q: Queryable, term: string, action: 'block' | 'review', staffId: string) {
  cache = null;
  const t = await maybeOne(q, `INSERT INTO moderation_terms (term, action, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, term, action, created_at`, [term.trim(), action, staffId]);
  if (!t) throw conflict('duplicate_term', 'That term is already on the list');
  return t;
}

export async function removeTerm(q: Queryable, id: string) {
  cache = null;
  const res = await q.query('DELETE FROM moderation_terms WHERE id = $1', [id]);
  if (!res.rowCount) throw notFound('Term');
}

export async function moderationCounts(q: Queryable) {
  return one<{ listings: number; chats: number }>(
    q,
    `SELECT (SELECT count(*)::int FROM offers WHERE status = 'review') AS listings, (SELECT count(*)::int FROM chat_flags WHERE status = 'open') AS chats`,
  );
}
