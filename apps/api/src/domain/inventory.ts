import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db.js';
import { many, one } from '../db.js';
import { hmacSha256 } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';

export const MAX_ITEMS_PER_UPLOAD = 10_000;
export const MAX_ITEM_BYTES = 4_096;

/**
 * Parse a bulk upload. `txt`: one code/credential per non-empty line.
 * `json`: an array of strings, or of objects (stored as compact JSON, e.g.
 * {"login": "...", "password": "...", "recovery": "..."} for accounts).
 */
export function parseBulkUpload(format: 'txt' | 'json', content: string): string[] {
  let items: string[];
  if (format === 'txt') {
    items = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw badRequest('invalid_json', 'Upload is not valid JSON');
    }
    if (!Array.isArray(parsed)) throw badRequest('invalid_json', 'JSON upload must be an array');
    items = parsed.map((v) => (typeof v === 'string' ? v.trim() : JSON.stringify(v)));
  }
  if (!items.length) throw badRequest('empty_upload', 'No items found in upload');
  if (items.length > MAX_ITEMS_PER_UPLOAD) throw badRequest('too_many_items', `At most ${MAX_ITEMS_PER_UPLOAD} items per upload`);
  const tooBig = items.findIndex((i) => Buffer.byteLength(i) > MAX_ITEM_BYTES || !i);
  if (tooBig >= 0) throw badRequest('invalid_item', `Item #${tooBig + 1} is empty or exceeds ${MAX_ITEM_BYTES} bytes`);
  return items;
}

const aad = (offerId: string) => `inventory:${offerId}`;

/** Encrypts and stores items. Duplicates (same seller + same plaintext) are skipped via a keyed fingerprint. */
export async function addInventory(ctx: Ctx, q: Queryable, sellerId: string, offerId: string, items: string[]) {
  let added = 0;
  const batch = 500;
  for (let i = 0; i < items.length; i += batch) {
    const chunk = items.slice(i, i + batch);
    const cipher = chunk.map((p) => ctx.keyring.encrypt(p, aad(offerId)));
    const fps = chunk.map((p) => hmacSha256(ctx.cfg.FINGERPRINT_KEY, `${sellerId}:${p}`));
    const res = await q.query(
      `INSERT INTO inventory_items (offer_id, seller_id, ciphertext, fingerprint)
         SELECT $1, $2, c, f FROM unnest($3::text[], $4::text[]) AS t(c, f)
       ON CONFLICT (seller_id, fingerprint) DO NOTHING`,
      [offerId, sellerId, cipher, fps],
    );
    added += res.rowCount ?? 0;
  }
  return { added, duplicates: items.length - added, available: await availableCount(q, offerId) };
}

export async function availableCount(q: Queryable, offerId: string): Promise<number> {
  const row = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM inventory_items WHERE offer_id = $1 AND status = 'available'`, [offerId]);
  return row.n;
}

/**
 * Reserve `quantity` items for an order using optimistic locking.
 *
 * Candidate rows are read without locks; each claim is a conditional UPDATE on
 * (id, version, status). If a concurrent buyer claimed the row first its
 * version has moved on, our UPDATE matches zero rows, and we move to the next
 * candidate. No row locks are held across reads, so there are no deadlocks,
 * and double-allocation is impossible.
 */
export async function reserveInventory(tx: Tx, offerId: string, orderId: string, quantity: number): Promise<string[]> {
  const claimed: string[] = [];
  const tried = new Set<string>();
  for (let round = 0; round < 8 && claimed.length < quantity; round++) {
    const need = quantity - claimed.length;
    const candidates = await many<{ id: string; version: number }>(
      tx,
      `SELECT id, version FROM inventory_items
        WHERE offer_id = $1 AND status = 'available' AND NOT (id = ANY($2::uuid[]))
        ORDER BY position LIMIT $3`,
      [offerId, [...tried], need * 2 + 4],
    );
    if (!candidates.length) break;
    for (const c of candidates) {
      if (claimed.length >= quantity) break;
      tried.add(c.id);
      const res = await tx.query(
        `UPDATE inventory_items SET status = 'reserved', order_id = $3, version = version + 1
          WHERE id = $1 AND version = $2 AND status = 'available'`,
        [c.id, c.version, orderId],
      );
      if (res.rowCount === 1) claimed.push(c.id);
    }
  }
  if (claimed.length < quantity) throw conflict('out_of_stock', 'Not enough stock for this order');
  return claimed;
}

/** Manual-delivery offers keep a stock counter guarded by the offer's version column. */
export async function reserveManualStock(tx: Tx, offerId: string, quantity: number): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const offer = await one<{ stock: number; version: number }>(tx, 'SELECT stock, version FROM offers WHERE id = $1', [offerId]);
    if (offer.stock < quantity) throw conflict('out_of_stock', 'Not enough stock for this order');
    const res = await tx.query(
      `UPDATE offers SET stock = stock - $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2 AND stock >= $3`,
      [offerId, offer.version, quantity],
    );
    if (res.rowCount === 1) return;
  }
  throw conflict('out_of_stock', 'Item was just purchased by another buyer');
}

export async function releaseReservation(tx: Tx, order: { id: string; offer_id: string; quantity: number; delivery_mode: string }) {
  if (order.delivery_mode === 'auto') {
    await tx.query(
      `UPDATE inventory_items SET status = 'available', order_id = NULL, version = version + 1
        WHERE order_id = $1 AND status = 'reserved'`,
      [order.id],
    );
  } else {
    await tx.query('UPDATE offers SET stock = stock + $2, version = version + 1, updated_at = now() WHERE id = $1', [order.offer_id, order.quantity]);
  }
}

export async function markDelivered(tx: Tx, orderId: string): Promise<number> {
  const res = await tx.query(
    `UPDATE inventory_items SET status = 'delivered', delivered_at = now(), version = version + 1
      WHERE order_id = $1 AND status = 'reserved'`,
    [orderId],
  );
  return res.rowCount ?? 0;
}

/** Decrypt delivered goods for the buyer's private dashboard. */
export async function revealDelivered(ctx: Ctx, orderId: string) {
  const rows = await many<{ id: string; offer_id: string; ciphertext: string; delivered_at: string }>(
    ctx.db,
    `SELECT id, offer_id, ciphertext, delivered_at FROM inventory_items WHERE order_id = $1 AND status = 'delivered' ORDER BY position`,
    [orderId],
  );
  return rows.map((r) => ({ id: r.id, deliveredAt: r.delivered_at, content: ctx.keyring.decrypt(r.ciphertext, aad(r.offer_id)) }));
}

/** Store a manually delivered payload (e.g. account credentials) encrypted and attached to the order. */
export async function storeManualDelivery(ctx: Ctx, tx: Tx, order: { id: string; offer_id: string; seller_id: string }, payload: string) {
  await tx.query(
    `INSERT INTO inventory_items (offer_id, seller_id, ciphertext, fingerprint, status, order_id, delivered_at)
       VALUES ($1, $2, $3, $4, 'delivered', $5, now())`,
    [order.offer_id, order.seller_id, ctx.keyring.encrypt(payload, aad(order.offer_id)), hmacSha256(ctx.cfg.FINGERPRINT_KEY, `${order.seller_id}:${order.id}:${payload}`), order.id],
  );
}
