import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform, pipeline as pipelineCb, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp, { type OutputInfo } from 'sharp';
import type { Ctx } from '../context.js';
import { maybeOne, one, withTx } from '../db.js';
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
/** Proof clips don't need more (Round 23b). Videos are streamed to disk, the scanner and storage, never buffered whole. */
export const MAX_DIRECT_VIDEO_BYTES = 100 * 1024 * 1024;
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

/** The same for a spooled file, streamed to the scanner (fails closed, like scanOrPause). */
async function scanFileOrPause(ctx: Ctx, file: string, size: number) {
  try {
    return await ctx.scanner.scanStream(createReadStream(file), size);
  } catch (err) {
    ctx.log.error({ err }, 'malware scanner unavailable');
    throw new AppError(503, 'scanner_unavailable', 'Uploads are paused for a moment. Try again shortly.');
  }
}

/**
 * Round 23b: write an incoming stream to a private temp file in chunks, hashing and counting as it goes, and stop
 * as soon as it passes `max`. Memory stays at one chunk whatever the size. Call `cleanup` when done.
 */
/** Round 23d (item 8): a spool stops when the client goes quiet or drags on; temp space for spools is capped. */
export const spoolLimits = { idleMs: 30_000, totalMs: 10 * 60_000 }; // mutable so tests can shorten them
export const SPOOL_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // temp space all in-flight spools may claim together
let spoolReserved = 0;
export const spoolReservedBytes = () => spoolReserved;

export async function spool(source: Readable, max: number, tooLarge: () => Error) {
  if (spoolReserved + max > SPOOL_MAX_TOTAL_BYTES) throw new AppError(503, 'uploads_busy', 'Too many uploads in progress; try again in a minute');
  spoolReserved += max;
  let released = false;
  const release = () => {
    if (!released) spoolReserved -= max;
    released = true;
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'bz-upload-'));
  const file = path.join(dir, 'upload');
  const hash = createHash('sha256');
  let size = 0;
  const head: Buffer[] = [];
  let headLen = 0;
  const startedAt = Date.now();
  let idle: NodeJS.Timeout | null = null;
  // The meter (not the request) is failed: the 408 still gets written before the connection closes.
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => meter.destroy(new AppError(408, 'upload_stalled', 'The upload stalled; try again')), spoolLimits.idleMs);
  };
  const meter: Transform = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > max) return cb(tooLarge());
      if (Date.now() - startedAt > spoolLimits.totalMs) return cb(new AppError(408, 'upload_too_slow', 'The upload took too long; try again on a faster connection'));
      armIdle();
      hash.update(chunk);
      if (headLen < 16) {
        const part = Buffer.from(chunk.subarray(0, 16 - headLen));
        head.push(part);
        headLen += part.length;
      }
      cb(null, chunk);
    },
  });
  const cleanup = async () => {
    release();
    await rm(dir, { recursive: true, force: true });
  };
  armIdle();
  try {
    await pipeline(source, meter, createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    if (idle) clearTimeout(idle);
  }
  return { file, size, sha256: hash.digest('hex'), head: Buffer.concat(head), cleanup };
}

/**
 * Round 23d (item 7): a proof video is re-muxed with every metadata atom dropped (GPS, device, creation time,
 * chapters), streams copied as they are. ffmpeg is in the API image; if it is missing or fails the upload is refused
 * (fail closed) rather than stored with the location of the person who filmed it.
 */
export async function stripVideoMetadata(src: string, kind: 'mp4' | 'webm'): Promise<{ file: string; size: number; sha256: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bz-video-'));
  const out = path.join(dir, `clean.${kind}`);
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-map', '0', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', ...(kind === 'mp4' ? ['-movflags', '+faststart'] : []), '-f', kind === 'mp4' ? 'mp4' : 'webm', out];
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 1 << 20 }, (err, _stdout, stderr) => (err ? reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 500)}`)) : resolve()));
    });
    const size = (await stat(out)).size;
    if (size === 0) throw new Error('ffmpeg produced an empty file');
    const hash = createHash('sha256');
    await pipeline(createReadStream(out), new Transform({ transform(c: Buffer, _e, cb) { hash.update(c); cb(); } }));
    return { file: out, size, sha256: hash.digest('hex'), cleanup };
  } catch (err) {
    await cleanup();
    throw new AppError(422, 'video_not_processable', 'This video could not be processed. Export it again as MP4 (H.264) or WebM and retry', { reason: String((err as Error).message).slice(0, 200) });
  }
}

/** What acceptUpload stores: bytes in memory (images, ≤ 8 MB) or a spooled file (videos). */
type Incoming = { data: Buffer } | { file: string; size: number; sha256: string };

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
  return acceptUpload(ctx, room, user, name, kind, { data: body });
}

/**
 * Round 23b: a proof video posted to the API arrives as a stream (the video/* body parser does not buffer). It is
 * spooled to a temp file (≤ 95 MB, counted while reading), sniffed, streamed to the scanner and to storage.
 */
export async function uploadVideoStream(
  ctx: Ctx,
  roomId: string,
  user: { id: string; role: string; status: string },
  fileName: string,
  stream: Readable,
  declaredBytes?: number,
) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  const room = await roomForParticipant(ctx.db, roomId, user);
  if (room.buyer_id !== user.id && room.seller_id !== user.id) throw forbidden('not_participant', 'Only the buyer and seller can add evidence');
  if (declaredBytes && declaredBytes > MAX_VIDEO_BYTES) throw videoTooLarge(ctx);
  const releaseSlot = await reserveUploadSlot(ctx, user.id);
  try {
    const spooled = await spool(stream, MAX_VIDEO_BYTES, () => videoTooLarge(ctx));
    try {
      if (spooled.size === 0) throw badRequest('empty_file', 'The file is empty');
      const kind = sniffImage(spooled.head);
      if (!kind || !VIDEO.has(kind)) throw badRequest('unsupported_file', 'Only PNG, JPEG and WebP images or MP4/WebM videos can be attached');
      return await acceptUpload(ctx, room, user, cleanName(fileName), kind, { file: spooled.file, size: spooled.size, sha256: spooled.sha256 });
    } finally {
      await spooled.cleanup();
    }
  } finally {
    await releaseSlot();
  }
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

const CONCURRENT_UPLOADS = 2;
/**
 * Round 23d (item 8): the upload slot is reserved *before* any byte is spooled, so parallel requests cannot slip past
 * the hourly limit, and a user holds at most CONCURRENT_UPLOADS spools at once. Release the slot when done.
 */
async function reserveUploadSlot(ctx: Ctx, userId: string, opts: { spool: boolean } = { spool: true }): Promise<() => Promise<void>> {
  const slot = await withTx(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`upload:${userId}`]); // one reservation at a time per user
    return one<{ id: string | null; recent: number; active: number }>(
      tx,
      `WITH counts AS (
       SELECT count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS recent,
              count(*) FILTER (WHERE finished_at IS NULL AND started_at > now() - interval '15 minutes')::int AS active
         FROM upload_slots WHERE user_id = $1
     ), ins AS (
       INSERT INTO upload_slots (user_id, finished_at) SELECT $1, CASE WHEN $4::boolean THEN NULL ELSE now() END FROM counts WHERE recent < $2 AND (NOT $4::boolean OR active < $3) RETURNING id
     )
     SELECT (SELECT id FROM ins) AS id, recent, active FROM counts`,
      [userId, UPLOADS_PER_HOUR, CONCURRENT_UPLOADS, opts.spool],
    );
  });
  if (!slot.id) {
    if (opts.spool && slot.active >= CONCURRENT_UPLOADS) throw new AppError(429, 'upload_in_progress', 'Finish your current uploads first');
    throw new AppError(429, 'too_many_uploads', 'Upload limit reached; try again later');
  }
  const id = slot.id;
  return async () => void (await ctx.db.query('UPDATE upload_slots SET finished_at = now() WHERE id = $1', [id]).catch(() => {}));
}
/** Images arrive already buffered (≤ 8 MB): only the hourly count applies, the slot is closed at once. */
async function checkUploadRate(ctx: Ctx, userId: string) {
  await reserveUploadSlot(ctx, userId, { spool: false });
}

/** Scan, re-encode (images), store and post the chat message. `pending`: a direct upload already stored at its key. */
async function acceptUpload(
  ctx: Ctx,
  room: { id: string; buyer_id: string; seller_id: string },
  user: { id: string },
  name: string,
  kind: Kind,
  input: Incoming,
  pending?: { id: string; key: string },
) {
  const roomId = room.id;
  const isVideo = VIDEO.has(kind);
  const size = 'data' in input ? input.data.length : input.size;
  const scan = 'data' in input ? await scanOrPause(ctx, input.data) : await scanFileOrPause(ctx, input.file, input.size);
  if (!scan.clean) {
    if (pending) await ctx.storage.delete(pending.key);
    await withScope(ctx, async (s) => {
      if (pending) {
        await s.tx.query(`UPDATE chat_attachments SET status = 'infected', scan_result = $2, storage_key = NULL WHERE id = $1`, [pending.id, scan.signature ?? 'malware']);
      } else {
        await s.tx.query(
          `INSERT INTO chat_attachments (room_id, uploader_id, original_name, mime, bytes, status, scan_result) VALUES ($1, $2, $3, $4, $5, 'infected', $6)`,
          [roomId, user.id, name, MIME[kind], size, scan.signature ?? 'malware'],
        );
      }
      await s.tx.query(
        `INSERT INTO risk_flags (user_id, score, reasons) VALUES ($1, 0.9, $2)`,
        [user.id, JSON.stringify([{ code: 'malware_upload', weight: 0.9, detail: { signature: scan.signature, roomId } }])],
      );
    });
    throw new AppError(422, 'malware_detected', 'This file was blocked by our malware scan');
  }

  // Images are re-encoded (strips metadata and anything smuggled after the image data); videos are re-muxed
  // with their metadata dropped (Round 23d) — never stored as uploaded.
  let out: { data: Buffer | null; info: Pick<OutputInfo, 'width' | 'height'> };
  let video: Awaited<ReturnType<typeof stripVideoMetadata>> | null = null;
  if (isVideo && ctx.cfg.VIDEO_METADATA_STRIP === 'ffmpeg') {
    let src = 'data' in input ? '' : input.file;
    let srcDir: string | null = null;
    if ('data' in input) {
      srcDir = await mkdtemp(path.join(tmpdir(), 'bz-video-in-'));
      src = path.join(srcDir, 'in');
      await writeFile(src, input.data, { mode: 0o600 });
    }
    try {
      video = await stripVideoMetadata(src, kind as 'mp4' | 'webm');
    } finally {
      if (srcDir) await rm(srcDir, { recursive: true, force: true });
    }
    out = { data: null, info: { width: 0, height: 0 } };
  } else if (!('data' in input) || isVideo) out = { data: isVideo && 'data' in input ? input.data : null, info: { width: 0, height: 0 } };
  else {
    try {
      const img = sharp(input.data, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
        .rotate() // apply EXIF orientation before metadata is dropped
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
      const encoded = kind === 'png' ? img.png({ compressionLevel: 9 }) : kind === 'webp' ? img.webp({ quality: 85 }) : img.jpeg({ quality: 85, mozjpeg: true });
      out = await encoded.toBuffer({ resolveWithObject: true });
    } catch {
      throw badRequest('invalid_image', 'This image could not be read');
    }
  }

  const hash = video ? video.sha256 : out.data ? sha256(out.data) : (input as { sha256: string }).sha256;
  const storedBytes = video ? video.size : out.data ? out.data.length : size;
  const id = pending?.id ?? randomUUID();
  const key = pending?.key ?? `chat/${roomId}/${id}`;
  // Everything stored is what was checked here: a direct upload's object was already moved off the signed key (Round 23d).
  try {
    if (video) await ctx.storage.putFile(key, video.file, MIME[kind], video.size);
    else if (out.data) await ctx.storage.put(key, out.data, MIME[kind]);
    else await ctx.storage.putFile(key, (input as { file: string }).file, MIME[kind], size);
  } finally {
    if (video) await video.cleanup();
  }

  return withScope(ctx, async (s) => {
    const msg = await appendMessage(
      s,
      roomId,
      user.id,
      'attachment',
      isVideo ? `🎬 ${name} (${(storedBytes / 1_048_576).toFixed(1)} MB video, sha256 ${hash})` : `📎 ${name} (${out.info.width}×${out.info.height}, sha256 ${hash})`,
      [],
      ctx.keyring,
    );
    const att = pending
      ? await one(
          s.tx,
          `UPDATE chat_attachments SET message_id = $2, mime = $3, bytes = $4, sha256 = $5, status = 'clean', scan_result = $6, key_version = $7, storage_key = $8
            WHERE id = $1 AND status = 'uploading'
            RETURNING id, message_id, original_name, mime, bytes, width, height, sha256, created_at`,
          [id, msg.id, MIME[kind], storedBytes, hash, `${ctx.scanner.name}: clean`, ctx.storage.keyVersion, key],
        )
      : await one(
          s.tx,
          `INSERT INTO chat_attachments (id, room_id, uploader_id, message_id, original_name, mime, bytes, width, height, sha256, storage_key, status, scan_result, key_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'clean', $12, $13)
           RETURNING id, message_id, original_name, mime, bytes, width, height, sha256, created_at`,
          [id, roomId, user.id, msg.id, name, MIME[kind], storedBytes, isVideo ? null : out.info.width, isVideo ? null : out.info.height, hash, key, `${ctx.scanner.name}: clean`, ctx.storage.keyVersion],
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
  let source: Readable;
  try {
    source = await ctx.storage.getStream(att.storage_key);
  } catch {
    throw badRequest('upload_missing', 'The upload has not arrived yet. Try again.');
  }
  // Streamed from the bucket to a temp file (hash, size, first bytes), then to the scanner: never held in memory.
  const reject = async () => {
    await ctx.storage.delete(att.storage_key);
    await ctx.db.query(`DELETE FROM chat_attachments WHERE id = $1 AND status = 'uploading'`, [att.id]);
    return badRequest('unsupported_file', 'Only MP4/WebM videos can be uploaded this way');
  };
  const releaseSlot = await reserveUploadSlot(ctx, user.id);
  let spooled: Awaited<ReturnType<typeof spool>>;
  try {
    spooled = await spool(source, Number(att.bytes), () => new AppError(413, 'file_too_large', 'Larger than announced'));
  } catch (err) {
    await releaseSlot();
    if (err instanceof AppError && err.code === 'file_too_large') throw await reject();
    throw badRequest('upload_missing', 'The upload has not arrived yet. Try again.');
  }
  try {
    const kind = sniffImage(spooled.head);
    if (spooled.size !== Number(att.bytes) || !kind || !VIDEO.has(kind)) throw await reject();
    // Round 23d: the signed PUT stays valid for a while, so the scanned bytes are written to a key the client was
    // never given and the upload key is removed. What is served is exactly what was checked and scanned.
    const finalKey = `${att.storage_key}/v`;
    await ctx.storage.delete(att.storage_key);
    try {
      return await acceptUpload(ctx, room, user, att.original_name, kind, { file: spooled.file, size: spooled.size, sha256: spooled.sha256 }, { id: att.id, key: finalKey });
    } catch (err) {
      await ctx.storage.delete(finalKey).catch(() => {});
      if (!(err instanceof AppError && err.code === 'malware_detected')) await ctx.db.query(`DELETE FROM chat_attachments WHERE id = $1 AND status = 'uploading'`, [att.id]);
      throw err;
    }
  } finally {
    await spooled.cleanup();
    await releaseSlot();
  }
}

/**
 * Round 23b/23d: an attachment as a stream (videos). The stored file is first spooled to a temp file and hashed;
 * only a file that matches its SHA-256 is streamed back (from the verified copy), so a tampered or truncated object
 * never reaches the client as a 200 with a body. The temp file goes when the stream ends.
 */
export async function openAttachment(ctx: Ctx, id: string, user: { id: string; role: string }) {
  const att = await maybeOne(ctx.db, `SELECT * FROM chat_attachments WHERE id = $1 AND status = 'clean'`, [id]);
  if (!att) throw notFound('Attachment');
  const room = await roomForParticipant(ctx.db, att.room_id, user);
  let spooled: Awaited<ReturnType<typeof spool>>;
  try {
    spooled = await spool(await ctx.storage.getStream(att.storage_key), Number(att.bytes), () => new Error('larger than recorded'));
  } catch (err) {
    ctx.log.error({ attachmentId: att.id, err }, 'stored attachment could not be read back');
    throw new AppError(500, 'integrity_error', 'Stored file failed its integrity check');
  }
  if (spooled.size !== Number(att.bytes) || spooled.sha256 !== att.sha256) {
    await spooled.cleanup();
    ctx.log.error({ attachmentId: att.id }, 'stored attachment failed its integrity check');
    throw new AppError(500, 'integrity_error', 'Stored file failed its integrity check');
  }
  const stream = createReadStream(spooled.file);
  stream.once('close', () => void spooled.cleanup());
  return { att, stream, isParticipant: room.buyer_id === user.id || room.seller_id === user.id };
}

export async function readAttachment(ctx: Ctx, id: string, user: { id: string; role: string }) {
  const att = await maybeOne(ctx.db, `SELECT * FROM chat_attachments WHERE id = $1 AND status = 'clean'`, [id]);
  if (!att) throw notFound('Attachment');
  const room = await roomForParticipant(ctx.db, att.room_id, user);
  const bytes = await ctx.storage.get(att.storage_key);
  if (sha256(bytes) !== att.sha256) throw new AppError(500, 'integrity_error', 'Stored file failed its integrity check');
  return { att, bytes, isParticipant: room.buyer_id === user.id || room.seller_id === user.id };
}
