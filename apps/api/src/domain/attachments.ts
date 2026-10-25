import { randomUUID } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import type { Ctx } from '../context.js';
import { maybeOne, one } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { appendMessage, roomForParticipant } from './chat.js';
import { withScope } from './events.js';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/**
 * Delivery proof videos (a trade window recording) may be larger than screenshots. Uploads through the API stay
 * under Cloudflare's 100 MB request limit; with object storage (S3/R2) larger videos go straight to the bucket
 * (startDirectVideoUpload) up to MAX_DIRECT_VIDEO_BYTES.
 */
export const MAX_VIDEO_BYTES = 95 * 1024 * 1024;
export const MAX_DIRECT_VIDEO_BYTES = 500 * 1024 * 1024;
const DIRECT_UPLOAD_TTL_SECONDS = 15 * 60;
const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 2560;
const UPLOADS_PER_HOUR = 20;

type Kind = 'png' | 'jpeg' | 'webp' | 'mp4' | 'webm';
const MIME: Record<Kind, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };
const VIDEO: ReadonlySet<Kind> = new Set<Kind>(['mp4', 'webm']);

/** Identify the file by its bytes, never by the declared type or file name. */
export function sniffImage(buf: Buffer): Kind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // ISO base media: a size then 'ftyp' (MP4, M4V, MOV-style brands).
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  // Matroska/WebM EBML header.
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return null;
}

/** Malware-scan uploaded bytes; uploads pause (fail closed) while the scanner is unreachable. */
export async function scanOrPause(ctx: Ctx, body: Buffer): Promise<{ clean: boolean; signature?: string }> {
  try {
    return await ctx.scanner.scan(body);
  } catch (err) {
    ctx.log.error({ err }, 'malware scanner unavailable');
    throw new AppError(503, 'scanner_unavailable', 'Uploads are paused for a moment. Try again shortly.');
  }
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
  const kind = sniffImage(body);
  if (!kind) throw badRequest('unsupported_file', 'Only PNG, JPEG and WebP images or MP4/WebM videos can be attached');
  const isVideo = VIDEO.has(kind);
  if (!isVideo && body.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'file_too_large', 'Images can be up to 8 MB');
  if (isVideo && body.length > MAX_VIDEO_BYTES) throw videoTooLarge(ctx);
  await checkUploadRate(ctx, user.id);
  const name = cleanName(fileName);
  return acceptUpload(ctx, room, user, name, kind, body);
}

/** 413 with the limit in `details`, so the web app shows a translated message (and the size). */
function videoTooLarge(ctx: Ctx) {
  const direct = !!ctx.storage.presignPut;
  return new AppError(413, 'file_too_large', `Videos can be up to ${MAX_VIDEO_BYTES / 1_048_576} MB`, {
    maxBytes: MAX_VIDEO_BYTES,
    maxMb: MAX_VIDEO_BYTES / 1_048_576,
    directUpload: direct,
  });
}

async function checkUploadRate(ctx: Ctx, userId: string) {
  const recent = await one<{ n: number }>(
    ctx.db,
    `SELECT count(*)::int AS n FROM chat_attachments WHERE uploader_id = $1 AND created_at > now() - interval '1 hour'`,
    [userId],
  );
  if (recent.n >= UPLOADS_PER_HOUR) throw new AppError(429, 'too_many_uploads', 'Upload limit reached; try again later');
}

/** Scan, re-encode (images), store and post the chat message. `pending`: a direct upload already stored at its key. */
async function acceptUpload(
  ctx: Ctx,
  room: { id: string; buyer_id: string; seller_id: string },
  user: { id: string },
  name: string,
  kind: Kind,
  body: Buffer,
  pending?: { id: string; key: string },
) {
  const roomId = room.id;
  const isVideo = VIDEO.has(kind);
  const scan = await scanOrPause(ctx, body);
  if (!scan.clean) {
    if (pending) await ctx.storage.delete(pending.key);
    await withScope(ctx, async (s) => {
      if (pending) {
        await s.tx.query(`UPDATE chat_attachments SET status = 'infected', scan_result = $2, storage_key = NULL WHERE id = $1`, [pending.id, scan.signature ?? 'malware']);
      } else {
        await s.tx.query(
          `INSERT INTO chat_attachments (room_id, uploader_id, original_name, mime, bytes, status, scan_result) VALUES ($1, $2, $3, $4, $5, 'infected', $6)`,
          [roomId, user.id, name, MIME[kind], body.length, scan.signature ?? 'malware'],
        );
      }
      await s.tx.query(
        `INSERT INTO risk_flags (user_id, score, reasons) VALUES ($1, 0.9, $2)`,
        [user.id, JSON.stringify([{ code: 'malware_upload', weight: 0.9, detail: { signature: scan.signature, roomId } }])],
      );
    });
    throw new AppError(422, 'malware_detected', 'This file was blocked by our malware scan');
  }

  // Images are re-encoded (strips metadata and anything smuggled after the image data); videos are
  // stored as scanned, since they cannot be re-encoded here.
  let out: { data: Buffer; info: Pick<OutputInfo, 'width' | 'height'> };
  if (isVideo) out = { data: body, info: { width: 0, height: 0 } };
  else {
    try {
      const img = sharp(body, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
        .rotate() // apply EXIF orientation before metadata is dropped
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
      const encoded = kind === 'png' ? img.png({ compressionLevel: 9 }) : kind === 'webp' ? img.webp({ quality: 85 }) : img.jpeg({ quality: 85, mozjpeg: true });
      out = await encoded.toBuffer({ resolveWithObject: true });
    } catch {
      throw badRequest('invalid_image', 'This image could not be read');
    }
  }

  const hash = sha256(out.data);
  const id = pending?.id ?? randomUUID();
  const key = pending?.key ?? `chat/${roomId}/${id}`;
  if (!pending) await ctx.storage.put(key, out.data, MIME[kind]);

  return withScope(ctx, async (s) => {
    const msg = await appendMessage(
      s,
      roomId,
      user.id,
      'attachment',
      isVideo ? `🎬 ${name} (${(out.data.length / 1_048_576).toFixed(1)} MB video, sha256 ${hash})` : `📎 ${name} (${out.info.width}×${out.info.height}, sha256 ${hash})`,
      [],
      ctx.keyring,
    );
    const att = pending
      ? await one(
          s.tx,
          `UPDATE chat_attachments SET message_id = $2, mime = $3, bytes = $4, sha256 = $5, status = 'clean', scan_result = $6, key_version = $7
            WHERE id = $1 AND status = 'uploading'
            RETURNING id, message_id, original_name, mime, bytes, width, height, sha256, created_at`,
          [id, msg.id, MIME[kind], out.data.length, hash, `${ctx.scanner.name}: clean`, ctx.storage.keyVersion],
        )
      : await one(
          s.tx,
          `INSERT INTO chat_attachments (id, room_id, uploader_id, message_id, original_name, mime, bytes, width, height, sha256, storage_key, status, scan_result, key_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'clean', $12, $13)
           RETURNING id, message_id, original_name, mime, bytes, width, height, sha256, created_at`,
          [id, roomId, user.id, msg.id, name, MIME[kind], out.data.length, isVideo ? null : out.info.width, isVideo ? null : out.info.height, hash, key, `${ctx.scanner.name}: clean`, ctx.storage.keyVersion],
        );
    const counterpart = room.buyer_id === user.id ? room.seller_id : room.buyer_id;
    s.notifyUser(counterpart, 'chat.message', { roomId, seq: msg.seq });
    return { ...att, seq: msg.seq };
  });
}

/**
 * Round 23a: a proof video larger than the API accepts (Cloudflare's 100 MB request limit) goes straight to object
 * storage. Step 1 reserves the attachment and returns a signed PUT URL (15 minutes, exact type and size); step 2
 * (completeDirectVideoUpload) reads the object back, checks it is a video of that size, scans it and posts it.
 */
export async function startDirectVideoUpload(
  ctx: Ctx,
  roomId: string,
  user: { id: string; role: string; status: string },
  input: { fileName: string; contentType: 'video/mp4' | 'video/webm'; bytes: number },
) {
  if (!ctx.storage.presignPut) throw new AppError(409, 'direct_upload_unavailable', `Videos can be up to ${MAX_VIDEO_BYTES / 1_048_576} MB`, { maxBytes: MAX_VIDEO_BYTES, maxMb: MAX_VIDEO_BYTES / 1_048_576 });
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  const room = await roomForParticipant(ctx.db, roomId, user);
  if (room.buyer_id !== user.id && room.seller_id !== user.id) throw forbidden('not_participant', 'Only the buyer and seller can add evidence');
  if (input.bytes > MAX_DIRECT_VIDEO_BYTES) {
    throw new AppError(413, 'file_too_large', `Videos can be up to ${MAX_DIRECT_VIDEO_BYTES / 1_048_576} MB`, { maxBytes: MAX_DIRECT_VIDEO_BYTES, maxMb: MAX_DIRECT_VIDEO_BYTES / 1_048_576 });
  }
  await checkUploadRate(ctx, user.id);
  const id = randomUUID();
  const key = `chat/${roomId}/${id}`;
  const signed = await ctx.storage.presignPut(key, input.contentType, input.bytes, DIRECT_UPLOAD_TTL_SECONDS);
  await ctx.db.query(
    `INSERT INTO chat_attachments (id, room_id, uploader_id, original_name, mime, bytes, storage_key, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading')`,
    [id, roomId, user.id, cleanName(input.fileName), input.contentType, input.bytes, key],
  );
  return { id, url: signed.url, method: 'PUT' as const, headers: signed.headers, expiresInSeconds: DIRECT_UPLOAD_TTL_SECONDS };
}

export async function completeDirectVideoUpload(ctx: Ctx, attachmentId: string, user: { id: string; role: string; status: string }) {
  const att = await maybeOne<{ id: string; room_id: string; uploader_id: string; original_name: string; bytes: number; storage_key: string; created_at: string }>(
    ctx.db,
    `SELECT id, room_id, uploader_id, original_name, bytes, storage_key, created_at FROM chat_attachments WHERE id = $1 AND status = 'uploading'`,
    [attachmentId],
  );
  if (!att || att.uploader_id !== user.id) throw notFound('Upload');
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  const room = await roomForParticipant(ctx.db, att.room_id, user);
  let body: Buffer;
  try {
    body = await ctx.storage.get(att.storage_key);
  } catch {
    throw badRequest('upload_missing', 'The upload has not arrived yet. Try again.');
  }
  const kind = sniffImage(body);
  if (body.length !== Number(att.bytes) || !kind || !VIDEO.has(kind)) {
    await ctx.storage.delete(att.storage_key);
    await ctx.db.query(`DELETE FROM chat_attachments WHERE id = $1 AND status = 'uploading'`, [att.id]);
    throw badRequest('unsupported_file', 'Only MP4/WebM videos can be uploaded this way');
  }
  return acceptUpload(ctx, room, user, att.original_name, kind, body, { id: att.id, key: att.storage_key });
}

export async function readAttachment(ctx: Ctx, id: string, user: { id: string; role: string }) {
  const att = await maybeOne(ctx.db, `SELECT * FROM chat_attachments WHERE id = $1 AND status = 'clean'`, [id]);
  if (!att) throw notFound('Attachment');
  const room = await roomForParticipant(ctx.db, att.room_id, user);
  const bytes = await ctx.storage.get(att.storage_key);
  if (sha256(bytes) !== att.sha256) throw new AppError(500, 'integrity_error', 'Stored file failed its integrity check');
  return { att, bytes, isParticipant: room.buyer_id === user.id || room.seller_id === user.id };
}
