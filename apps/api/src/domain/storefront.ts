import { randomUUID } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { MAX_ATTACHMENT_BYTES, scanOrPause, sniffImage } from './attachments.js';
import { screenListing } from './moderation.js';
import { OFFER_LIST_SQL } from './offers.js';

/**
 * Seller storefronts (migration 047): a banner, a short intro, an accent colour and up to four
 * pinned listings on the public shop page. The intro is screened like a listing (no contact
 * details, nothing on the term list); the banner goes through the same checks as chat images
 * (real image by its bytes, malware scan, re-encoded so metadata and hidden payloads are gone).
 * Staff can clear either.
 */
export const ACCENTS = ['steel', 'teal', 'amber', 'rose', 'violet'] as const;
export type Accent = (typeof ACCENTS)[number];
export const MAX_PINNED = 4;
export const MAX_INTRO = 600;
const BANNER = { width: 1500, height: 400 };

const LIVE = `f.status = 'active' AND f.reserved_for IS NULL`;

/** What the shop page shows: intro, accent, banner URL (versioned for caching) and live pinned listings. */
export async function storefront(q: Queryable, sellerId: string) {
  const u = await maybeOne<{ shop_intro: string; shop_accent: Accent; shop_pinned: string[]; languages: string[]; banner_sha: string | null }>(
    q,
    `SELECT u.shop_intro, u.shop_accent, u.shop_pinned, u.languages, b.sha256 AS banner_sha
       FROM users u LEFT JOIN shop_banners b ON b.seller_id = u.id WHERE u.id = $1`,
    [sellerId],
  );
  if (!u) throw notFound('Seller');
  const pinned = u.shop_pinned.length
    ? await many(q, `${OFFER_LIST_SQL} WHERE f.id = ANY($1) AND f.seller_id = $2 AND ${LIVE}`, [u.shop_pinned, sellerId])
    : [];
  return {
    intro: u.shop_intro,
    languages: u.languages,
    accent: u.shop_accent,
    banner_url: u.banner_sha ? `/v1/sellers/${sellerId}/banner?v=${u.banner_sha.slice(0, 12)}` : null,
    // In the seller's chosen order; listings sold out or paused drop out on their own.
    pinned: u.shop_pinned.map((id) => pinned.find((o) => o.id === id)).filter(Boolean),
  };
}

export async function updateStorefront(ctx: Ctx, sellerId: string, input: { intro?: string; accent?: Accent; pinned?: string[]; languages?: string[] }) {
  if (input.intro != null) {
    const intro = input.intro.trim();
    if (intro.length > MAX_INTRO) throw badRequest('intro_too_long', `Keep the intro under ${MAX_INTRO} characters`);
    const v = await screenListing(ctx.db, '', intro);
    if (v.reasons.some((r) => r.startsWith('contact:'))) throw badRequest('contact_details', 'Contact details and outside payment methods aren’t allowed: buyers reach you through order chat');
    if (v.action !== 'allow') throw badRequest('intro_not_allowed', 'The intro mentions something our rules don’t allow on a shop page');
    input.intro = intro;
  }
  if (input.pinned) {
    const ids = [...new Set(input.pinned)];
    if (ids.length > MAX_PINNED) throw badRequest('too_many_pinned', `Pin up to ${MAX_PINNED} listings`);
    const own = await many<{ id: string }>(ctx.db, `SELECT f.id FROM offers f WHERE f.id = ANY($1) AND f.seller_id = $2 AND ${LIVE}`, [ids, sellerId]);
    if (own.length !== ids.length) throw badRequest('invalid_pinned', 'Pin your own active listings');
    input.pinned = ids;
  }
  await ctx.db.query(
    `UPDATE users SET shop_intro = COALESCE($2, shop_intro), shop_accent = COALESCE($3, shop_accent), shop_pinned = COALESCE($4::uuid[], shop_pinned), languages = COALESCE($5::text[], languages) WHERE id = $1`,
    [sellerId, input.intro ?? null, input.accent ?? null, input.pinned ?? null, input.languages ? [...new Set(input.languages.map((l) => l.toLowerCase()))] : null],
  );
  return storefront(ctx.db, sellerId);
}

export async function uploadBanner(ctx: Ctx, sellerId: string, body: Buffer) {
  if (body.length === 0) throw badRequest('empty_file', 'The file is empty');
  if (body.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'file_too_large', 'Images can be up to 8 MB');
  const prev = await maybeOne<{ storage_key: string; updated_at: string }>(ctx.db, 'SELECT storage_key, updated_at FROM shop_banners WHERE seller_id = $1', [sellerId]);
  if (prev && Date.now() - new Date(prev.updated_at).getTime() < 30_000) throw new AppError(429, 'too_many_uploads', 'Wait a moment before changing the banner again');
  if (!sniffImage(body)) throw badRequest('unsupported_file', 'Use a PNG, JPEG or WebP image');
  const scan = await scanOrPause(ctx, body);
  if (!scan.clean) {
    await ctx.db.query(`INSERT INTO risk_flags (user_id, score, reasons) VALUES ($1, 0.9, $2)`, [
      sellerId,
      JSON.stringify([{ code: 'malware_upload', weight: 0.9, detail: { signature: scan.signature, where: 'shop_banner' } }]),
    ]);
    throw new AppError(422, 'malware_detected', 'This file was blocked by our malware scan');
  }
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(body, { limitInputPixels: 40_000_000, failOn: 'error' })
      .rotate()
      .resize({ ...BANNER, fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw badRequest('invalid_image', 'This image could not be read');
  }
  const key = `shop/${sellerId}/${randomUUID()}`;
  await ctx.storage.put(key, out.data, 'image/webp');
  await ctx.db.query(
    `INSERT INTO shop_banners (seller_id, storage_key, sha256, width, height, key_version) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (seller_id) DO UPDATE SET storage_key = EXCLUDED.storage_key, sha256 = EXCLUDED.sha256, width = EXCLUDED.width,
       height = EXCLUDED.height, key_version = EXCLUDED.key_version, updated_at = now()`,
    [sellerId, key, sha256(out.data), out.info.width, out.info.height, ctx.storage.keyVersion],
  );
  if (prev) await ctx.storage.delete(prev.storage_key);
  return storefront(ctx.db, sellerId);
}

export async function deleteBanner(ctx: Ctx, sellerId: string) {
  const prev = await maybeOne<{ storage_key: string }>(ctx.db, 'DELETE FROM shop_banners WHERE seller_id = $1 RETURNING storage_key', [sellerId]);
  if (prev) await ctx.storage.delete(prev.storage_key);
}

/** The banner bytes, checked against the stored hash. */
export async function readBanner(ctx: Ctx, sellerId: string) {
  const b = await maybeOne<{ storage_key: string; sha256: string }>(ctx.db, 'SELECT storage_key, sha256 FROM shop_banners WHERE seller_id = $1', [sellerId]);
  if (!b) throw notFound('Banner');
  const bytes = await ctx.storage.get(b.storage_key);
  if (sha256(bytes) !== b.sha256) throw new AppError(500, 'integrity_error', 'Stored file failed its integrity check');
  return { bytes, sha256: b.sha256 };
}

/** Staff: remove a shop's banner and/or intro (offensive image, rule-breaking text). */
export async function clearStorefront(ctx: Ctx, sellerId: string, what: { banner: boolean; intro: boolean }) {
  if (what.banner) await deleteBanner(ctx, sellerId);
  if (what.intro) await ctx.db.query(`UPDATE users SET shop_intro = '' WHERE id = $1`, [sellerId]);
}
