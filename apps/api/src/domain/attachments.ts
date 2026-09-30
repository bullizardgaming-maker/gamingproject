import { randomUUID } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import type { Ctx } from '../context.js';
import { maybeOne, one } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { appendMessage, roomForParticipant } from './chat.js';
import { withScope } from './events.js';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 2560;
const UPLOADS_PER_HOUR = 20;

type Kind = 'png' | 'jpeg' | 'webp';
const MIME: Record<Kind, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Identify the image by its bytes, never by the declared type or file name. */
export function sniffImage(buf: Buffer): Kind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const cleanName = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'image';

/**
 * Upload a screenshot to an order chat:
 *  1. only room participants; 20 uploads/hour per user
 *  2. real PNG/JPEG/WebP by magic bytes, ≤ 8 MB, ≤ 40 MP
 *  3. malware scan of the original bytes (fails closed if the scanner is down)
 *  4. re-encode: strips EXIF/GPS and anything smuggled after the image data
 *  5. store encrypted; post a chat message containing the stored image's SHA-256,
 *     so the chat hash chain also proves the evidence wasn't replaced later
 */
export async function uploadAttachment(ctx: Ctx, roomId: string, user: { id: string; role: string; status: string }, fileName: string, body: Buffer) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  const room = await roomForParticipant(ctx.db, roomId, user);
  if (room.buyer_id !== user.id && room.seller_id !== user.id) throw forbidden('not_participant', 'Only the buyer and seller can add evidence');
  if (body.length === 0) throw badRequest('empty_file', 'The file is empty');
  if (body.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'file_too_large', 'Images can be up to 8 MB');
  const recent = await one<{ n: number }>(
    ctx.db,
    `SELECT count(*)::int AS n FROM chat_attachments WHERE uploader_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (recent.n >= UPLOADS_PER_HOUR) throw new AppError(429, 'too_many_uploads', 'Upload limit reached; try again later');
  const kind = sniffImage(body);
  if (!kind) throw badRequest('unsupported_file', 'Only PNG, JPEG and WebP images can be attached');
  const name = cleanName(fileName);

  let scan: { clean: boolean; signature?: string };
  try {
    scan = await ctx.scanner.scan(body);
  } catch (err) {
    ctx.log.error({ err }, 'malware scanner unavailable');
    throw new AppError(503, 'scanner_unavailable', 'Uploads are paused for a moment. Try again shortly.');
  }
  if (!scan.clean) {
    await withScope(ctx, async (s) => {
      await s.tx.query(
        `INSERT INTO chat_attachments (room_id, uploader_id, original_name, mime, bytes, status, scan_result) VALUES ($1, $2, $3, $4, $5, 'infected', $6)`,
        [roomId, user.id, name, MIME[kind], body.length, scan.signature ?? 'malware'],
      );
      await s.tx.query(
        `INSERT INTO risk_flags (user_id, score, reasons) VALUES ($1, 0.9, $2)`,
        [user.id, JSON.stringify([{ code: 'malware_upload', weight: 0.9, detail: { signature: scan.signature, roomId } }])],
      );
    });
    throw new AppError(422, 'malware_detected', 'This file was blocked by our malware scan');
  }

  let out: { data: Buffer; info: OutputInfo };
  try {
    const img = sharp(body, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      .rotate() // apply EXIF orientation before metadata is dropped
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    const encoded = kind === 'png' ? img.png({ compressionLevel: 9 }) : kind === 'webp' ? img.webp({ quality: 85 }) : img.jpeg({ quality: 85, mozjpeg: true });
    out = await encoded.toBuffer({ resolveWithObject: true });
  } catch {
    throw badRequest('invalid_image', 'This image could not be read');
  }

  const hash = sha256(out.data);
  const id = randomUUID();
  const key = `chat/${roomId}/${id}`;
  await ctx.storage.put(key, out.data, MIME[kind]);

  return withScope(ctx, async (s) => {
    const msg = await appendMessage(
      s,
      roomId,
      user.id,
      'attachment',
      `📎 ${name} (${out.info.width}×${out.info.height}, sha256 ${hash})`,
    );
    const att = await one(
      s.tx,
      `INSERT INTO chat_attachments (id, room_id, uploader_id, message_id, original_name, mime, bytes, width, height, sha256, storage_key, status, scan_result, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'clean', $12, $13)
       RETURNING id, message_id, original_name, mime, bytes, width, height, sha256, created_at`,
      [id, roomId, user.id, msg.id, name, MIME[kind], out.data.length, out.info.width, out.info.height, hash, key, `${ctx.scanner.name}: clean`, ctx.storage.keyVersion],
    );
    const counterpart = room.buyer_id === user.id ? room.seller_id : room.buyer_id;
    s.notifyUser(counterpart, 'chat.message', { roomId, seq: msg.seq });
    return { ...att, seq: msg.seq };
  });
}

export async function readAttachment(ctx: Ctx, id: string, user: { id: string; role: string }) {
  const att = await maybeOne(ctx.db, `SELECT * FROM chat_attachments WHERE id = $1 AND status = 'clean'`, [id]);
  if (!att) throw notFound('Attachment');
  const room = await roomForParticipant(ctx.db, att.room_id, user);
  const bytes = await ctx.storage.get(att.storage_key);
  if (sha256(bytes) !== att.sha256) throw new AppError(500, 'integrity_error', 'Stored file failed its integrity check');
  return { att, bytes, isParticipant: room.buyer_id === user.id || room.seller_id === user.id };
}
