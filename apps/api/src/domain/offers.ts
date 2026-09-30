import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { addInventory, parseBulkUpload } from './inventory.js';

export interface OfferInput {
  categorySlug: string;
  game: string;
  title: string;
  description?: string;
  priceCents: number;
  currency?: string;
  deliveryMode: 'auto' | 'manual';
  stock?: number;
  lowStockThreshold?: number;
  deliveryHours?: number;
}

export const OFFER_LIST_SQL = `
  SELECT f.id, f.seller_id, f.category_slug, f.game, f.title, f.description, f.price_cents, f.currency, f.delivery_mode,
         f.status, f.owner_proof_status, f.version, f.created_at, f.updated_at, f.low_stock_threshold,
         c.kind AS category_kind, c.risk_class, u.display_name AS seller_name, f.delivery_hours,
         (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now())) AS shop_paused,
         u.shop_paused_until, u.shop_pause_message,
         CASE WHEN f.delivery_mode = 'auto'
              THEN (SELECT count(*)::int FROM inventory_items i WHERE i.offer_id = f.id AND i.status = 'available')
              ELSE f.stock END AS stock,
         (c.kind = 'account' AND f.owner_proof_status <> 'verified') AS high_risk_secondary,
         (SELECT count(*)::int FROM orders o WHERE o.seller_id = f.seller_id AND o.status = 'completed') AS seller_completed_orders,
         (SELECT round(avg(rating)::numeric, 2) FROM reviews r WHERE r.seller_id = f.seller_id AND NOT r.hidden) AS seller_rating,
         (SELECT count(*)::int FROM reviews r WHERE r.seller_id = f.seller_id AND NOT r.hidden) AS seller_review_count
    FROM offers f JOIN categories c ON c.slug = f.category_slug JOIN users u ON u.id = f.seller_id`;

export function requireSeller(user: { kyc_tier: number; status: string }) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  if (user.kyc_tier < 2) throw forbidden('kyc_required', 'Tier 2 identity verification (photo ID + liveness) is required to sell');
}

export async function createOffer(ctx: Ctx, seller: { id: string; kyc_tier: number; status: string }, input: OfferInput) {
  requireSeller(seller);
  const cat = await maybeOne(ctx.db, 'SELECT * FROM categories WHERE slug = $1', [input.categorySlug]);
  if (!cat) throw badRequest('unknown_category', 'Unknown category');
  if (cat.kind === 'account' && input.deliveryMode === 'auto' && (input.stock ?? 0) > 0) {
    throw badRequest('invalid_stock', 'Account listings with auto-delivery take stock from uploaded inventory');
  }
  const stock = input.deliveryMode === 'manual' ? (cat.kind === 'account' ? 1 : input.stock ?? 1) : 0;
  const offer = await one(
    ctx.db,
    `INSERT INTO offers (seller_id, category_slug, game, title, description, price_cents, currency, delivery_mode, stock, low_stock_threshold, delivery_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [seller.id, input.categorySlug, input.game, input.title, input.description ?? '', input.priceCents, input.currency ?? 'USD',
     input.deliveryMode, stock, input.lowStockThreshold ?? 5, input.deliveryHours ?? 24],
  );
  return getOffer(ctx.db, offer.id);
}

export async function getOffer(q: Queryable, id: string) {
  const offer = await maybeOne(q, `${OFFER_LIST_SQL} WHERE f.id = $1`, [id]);
  if (!offer) throw notFound('Offer');
  return offer;
}

/**
 * Update an offer with optimistic concurrency. Clients send the version they
 * read; a concurrent edit (or a purchase that moved manual stock) bumps the
 * version and the stale update is rejected with 409.
 */
export async function updateOffer(
  ctx: Ctx,
  sellerId: string,
  offerId: string,
  version: number,
  patch: Partial<Pick<OfferInput, 'title' | 'description' | 'priceCents' | 'stock' | 'lowStockThreshold' | 'deliveryHours'>> & { status?: 'active' | 'paused' | 'removed' },
) {
  const res = await ctx.db.query(
    `UPDATE offers SET
        title = COALESCE($4, title), description = COALESCE($5, description), price_cents = COALESCE($6, price_cents),
        stock = CASE WHEN delivery_mode = 'manual' THEN COALESCE($7, stock) ELSE stock END,
        low_stock_threshold = COALESCE($8, low_stock_threshold), status = COALESCE($9, status),
        delivery_hours = COALESCE($10, delivery_hours),
        version = version + 1, updated_at = now()
      WHERE id = $1 AND seller_id = $2 AND version = $3 RETURNING id`,
    [offerId, sellerId, version, patch.title, patch.description, patch.priceCents, patch.stock, patch.lowStockThreshold, patch.status, patch.deliveryHours],
  );
  if (res.rowCount === 0) {
    const cur = await maybeOne(ctx.db, 'SELECT seller_id, version FROM offers WHERE id = $1', [offerId]);
    if (!cur || cur.seller_id !== sellerId) throw notFound('Offer');
    throw conflict('version_conflict', `Offer was modified concurrently (current version ${cur.version})`);
  }
  return getOffer(ctx.db, offerId);
}

/** Bulk price update for merchant bots. Each entry may carry an expected version. */
export async function bulkUpdatePrices(ctx: Ctx, sellerId: string, updates: Array<{ offerId: string; priceCents: number; version?: number }>) {
  return withTx(ctx.db, async (tx) => {
    const results = [];
    for (const u of updates) {
      const res = await tx.query(
        `UPDATE offers SET price_cents = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND seller_id = $2 AND ($4::int IS NULL OR version = $4) RETURNING id, price_cents, version`,
        [u.offerId, sellerId, u.priceCents, u.version ?? null],
      );
      results.push(res.rowCount ? { ...res.rows[0], ok: true } : { id: u.offerId, ok: false, error: 'not_found_or_version_conflict' });
    }
    return results;
  });
}

export async function uploadInventory(ctx: Ctx, sellerId: string, offerId: string, format: 'txt' | 'json', content: string) {
  const offer = await maybeOne(ctx.db, 'SELECT seller_id, delivery_mode FROM offers WHERE id = $1', [offerId]);
  if (!offer || offer.seller_id !== sellerId) throw notFound('Offer');
  if (offer.delivery_mode !== 'auto') throw badRequest('not_auto_delivery', 'Inventory uploads are only for auto-delivery offers');
  const items = parseBulkUpload(format, content);
  return withTx(ctx.db, (tx) => addInventory(ctx, tx, sellerId, offerId, items));
}

// ---------------------------------------------------------------------------
// Original Owner Proof (account listings)
// ---------------------------------------------------------------------------
export async function submitOwnerProof(
  ctx: Ctx,
  sellerId: string,
  offerId: string,
  input: { registrationEmail: string; registrationDate: string; billingName?: string; evidence: Record<string, unknown> },
) {
  return withTx(ctx.db, async (tx) => {
    const offer = await maybeOne(tx, `SELECT f.seller_id, c.kind FROM offers f JOIN categories c ON c.slug = f.category_slug WHERE f.id = $1`, [offerId]);
    if (!offer || offer.seller_id !== sellerId) throw notFound('Offer');
    if (offer.kind !== 'account') throw badRequest('not_account', 'Owner proof applies to account listings only');
    // Legacy security answers etc. are sensitive: encrypt the evidence blob.
    const proof = await one(
      tx,
      `INSERT INTO owner_proofs (offer_id, seller_id, registration_email, registration_date, billing_name, evidence)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, status, created_at`,
      [offerId, sellerId, input.registrationEmail, input.registrationDate, input.billingName ?? null,
       JSON.stringify({ sealed: ctx.keyring.encrypt(JSON.stringify(input.evidence), `owner_proof:${offerId}`) })],
    );
    await tx.query(`UPDATE offers SET owner_proof_status = 'pending', version = version + 1 WHERE id = $1`, [offerId]);
    return proof;
  });
}

export async function reviewOwnerProof(ctx: Ctx, proofId: string, reviewerId: string, approve: boolean, note?: string) {
  return withTx(ctx.db, async (tx) => {
    const proof = await maybeOne(
      tx,
      `SELECT p.*, u.legal_name FROM owner_proofs p JOIN users u ON u.id = p.seller_id WHERE p.id = $1 FOR UPDATE OF p`,
      [proofId],
    );
    if (!proof) throw notFound('Owner proof');
    // Billing history must match the seller's eKYC identity.
    const nameMatches = !proof.billing_name || !proof.legal_name || proof.billing_name.trim().toLowerCase() === proof.legal_name.trim().toLowerCase();
    const status = approve && nameMatches ? 'verified' : 'rejected';
    await tx.query('UPDATE owner_proofs SET status = $2, reviewed_by = $3, review_note = $4 WHERE id = $1', [
      proofId, status, reviewerId, note ?? (nameMatches ? null : 'Billing name does not match verified identity'),
    ]);
    await tx.query('UPDATE offers SET owner_proof_status = $2, version = version + 1 WHERE id = $1', [proof.offer_id, status]);
    return { id: proofId, status };
  });
}
