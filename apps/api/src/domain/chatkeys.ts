import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Queryable } from '../db.js';
import { maybeOne } from '../db.js';
import type { Keyring } from '../lib/crypto.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Per-user chat keys (crypto-shredding). Each user who writes in chat gets a random 32-byte key,
 * stored wrapped by the data keyring (so key rotation covers it). Their messages are sealed with
 * it (AES-256-GCM, bound to the room and sequence number), and the hash chain covers
 * HMAC(key, text) rather than the text. Destroying the key makes their messages unreadable for
 * everyone, while the chain over the stored digests still verifies.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { key: Buffer | null; at: number }>();
const aadOf = (userId: string) => `chatkey:${userId}`;

export async function userChatKey(keyring: Keyring, q: Queryable, userId: string, create = false): Promise<Buffer | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS && (hit.key || !create)) return hit.key;
  let row = await maybeOne<{ key_ciphertext: string | null }>(q, 'SELECT key_ciphertext FROM chat_user_keys WHERE user_id = $1', [userId]);
  if (!row && create) {
    const fresh = keyring.encrypt(randomBytes(32).toString('base64'), aadOf(userId));
    await q.query('INSERT INTO chat_user_keys (user_id, key_ciphertext) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, fresh]);
    row = await maybeOne(q, 'SELECT key_ciphertext FROM chat_user_keys WHERE user_id = $1', [userId]);
  }
  const key = row?.key_ciphertext ? Buffer.from(keyring.decrypt(row.key_ciphertext, aadOf(userId)), 'base64') : null;
  if (cache.size > 5_000) cache.clear();
  cache.set(userId, { key, at: Date.now() });
  return key;
}

export const bodyMac = (key: Buffer, body: string) => createHmac('sha256', key).update(body, 'utf8').digest('hex');
export const systemMac = (body: string) => sha256(body);

const positionAad = (roomId: string, seq: number) => Buffer.from(`chat:${roomId}:${seq}`);

export function seal(key: Buffer, body: string, roomId: string, seq: number) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(positionAad(roomId, seq));
  const ct = Buffer.concat([c.update(body, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function unseal(key: Buffer, sealed: string, roomId: string, seq: number) {
  const buf = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(positionAad(roomId, seq));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** Destroy a user's chat key: everything they wrote becomes unreadable for good. */
export async function shredUserChatKey(q: Queryable, userId: string, reason: string) {
  const { rowCount } = await q.query(
    `INSERT INTO chat_user_keys (user_id, key_ciphertext, shredded_at, shred_reason) VALUES ($1, NULL, now(), $2)
     ON CONFLICT (user_id) DO UPDATE SET key_ciphertext = NULL, shredded_at = COALESCE(chat_user_keys.shredded_at, now()), shred_reason = COALESCE(chat_user_keys.shred_reason, $2)
     WHERE chat_user_keys.key_ciphertext IS NOT NULL OR chat_user_keys.shredded_at IS NULL`,
    [userId, reason],
  );
  cache.delete(userId);
  return (rowCount ?? 0) > 0;
}

/** Test hook: forget cached keys (another process may have shredded them). */
export const clearChatKeyCache = () => cache.clear();

/**
 * Why a user's chat can't be erased yet: messages are evidence while a dispute, chargeback or
 * compliance case is open. Returns null when erasure is allowed.
 */
export async function chatLegalHold(q: Queryable, userId: string): Promise<string | null> {
  const r = await maybeOne<{ disputes: number; chargebacks: number; aml: number }>(
    q,
    `SELECT (SELECT count(*)::int FROM orders WHERE (buyer_id = $1 OR seller_id = $1) AND status = 'disputed') AS disputes,
            (SELECT count(*)::int FROM chargebacks c JOIN orders o ON o.id = c.order_id
              WHERE (o.buyer_id = $1 OR o.seller_id = $1) AND c.status NOT IN ('won', 'lost')) AS chargebacks,
            (SELECT count(*)::int FROM aml_cases WHERE user_id = $1 AND status IN ('open', 'escalated', 'reported')) AS aml`,
    [userId],
  );
  if (r?.disputes) return 'an open dispute';
  if (r?.chargebacks) return 'an open chargeback';
  if (r?.aml) return 'a compliance case';
  return null;
}
