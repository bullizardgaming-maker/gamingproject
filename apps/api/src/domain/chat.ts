import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { hasPermission } from './permissions.js';
import { sha256, type Keyring } from '../lib/crypto.js';
import { bodyMac, seal, systemMac, unseal, userChatKey } from './chatkeys.js';
import { forbidden, notFound } from '../lib/errors.js';
import type { TxScope } from './events.js';
import { withScope } from './events.js';
import { enqueueWebhook } from './webhooks.js';

export interface ChatRoom {
  id: string;
  order_id: string | null;
  offer_id: string | null;
  buyer_id: string;
  seller_id: string;
  last_seq: number;
  last_hash: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string | null;
  kind: 'text' | 'system' | 'delivery' | 'warning' | 'attachment';
  /** null when the sender's chat key was destroyed (the message is erased). */
  body: string | null;
  erased?: boolean;
  flags: string[];
  hash_version: number;
  body_mac: string | null;
  prev_hash: string;
  hash: string;
  created_at: string;
}

// Off-platform contact detection lives in safety.ts (shared with the web app).
export { detectOffPlatform } from './safety.js';
import { detectOffPlatform } from './safety.js';

/** v1 (messages written before per-user keys): the chain covers the text itself. */
export function messageHash(prevHash: string, seq: number, senderId: string | null, kind: string, body: string, createdAt: string) {
  return sha256([prevHash, seq, senderId ?? 'system', kind, body, createdAt].join('|'));
}

/** v2: the chain covers a digest of the text, so the text can be erased (key destroyed) without breaking it. */
export function messageHashV2(prevHash: string, seq: number, senderId: string | null, kind: string, mac: string, createdAt: string) {
  return sha256([prevHash, seq, senderId ?? 'system', kind, `mac:${mac}`, createdAt].join('|'));
}

type StoredMessage = ChatMessage & { body_sealed?: string | null };

/** Decrypt users' messages with their keys; a destroyed key shows the message as erased. */
export async function openMessages(keyring: Keyring, q: Queryable, rows: StoredMessage[]): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const { body_sealed, ...m } of rows) {
    if (m.hash_version === 2 && m.sender_id && body_sealed) {
      const key = await userChatKey(keyring, q, m.sender_id);
      out.push(key ? { ...m, body: unseal(key, body_sealed, m.room_id, Number(m.seq)) } : { ...m, body: null, erased: true });
    } else {
      out.push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
export async function createOrderRoom(q: Queryable, orderId: string, offerId: string, buyerId: string, sellerId: string): Promise<ChatRoom> {
  return one<ChatRoom>(
    q,
    `INSERT INTO chat_rooms (order_id, offer_id, buyer_id, seller_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [orderId, offerId, buyerId, sellerId],
  );
}

/** Pre-sale inquiry room (one per buyer per offer). */
export async function getOrCreateInquiryRoom(ctx: Ctx, offerId: string, buyerId: string): Promise<ChatRoom> {
  const offer = await maybeOne<{ seller_id: string }>(ctx.db, `SELECT seller_id FROM offers WHERE id = $1 AND status <> 'removed'`, [offerId]);
  if (!offer) throw notFound('Offer');
  if (offer.seller_id === buyerId) throw forbidden('own_offer', 'You cannot open an inquiry on your own offer');
  const existing = await maybeOne<ChatRoom>(ctx.db, 'SELECT * FROM chat_rooms WHERE offer_id = $1 AND buyer_id = $2 AND order_id IS NULL', [offerId, buyerId]);
  if (existing) return existing;
  return one<ChatRoom>(
    ctx.db,
    `INSERT INTO chat_rooms (offer_id, buyer_id, seller_id) VALUES ($1, $2, $3)
       ON CONFLICT (offer_id, buyer_id) WHERE order_id IS NULL DO UPDATE SET buyer_id = EXCLUDED.buyer_id
       RETURNING *`,
    [offerId, buyerId, offer.seller_id],
  );
}

export async function roomForParticipant(q: Queryable, roomId: string, user: { id: string; role: string; staff_roles?: string[] | null }): Promise<ChatRoom> {
  const room = await maybeOne<ChatRoom>(q, 'SELECT * FROM chat_rooms WHERE id = $1', [roomId]);
  if (!room) throw notFound('Chat room');
  const staff = hasPermission(user, 'orders.view_any');
  if (!staff && room.buyer_id !== user.id && room.seller_id !== user.id) throw forbidden('not_participant', 'Not a participant of this chat');
  return room;
}

export async function listRooms(keyring: Keyring, q: Queryable, userId: string) {
  const rooms = await many<any>(
    q,
    `SELECT r.*, o.title AS offer_title, ord.status AS order_status,
            (SELECT row_to_json(m) FROM (SELECT id, room_id, seq, sender_id, kind, body, body_sealed, hash_version FROM chat_messages m
                                          WHERE m.room_id = r.id ORDER BY seq DESC LIMIT 1) m) AS last
       FROM chat_rooms r
       LEFT JOIN offers o ON o.id = r.offer_id
       LEFT JOIN orders ord ON ord.id = r.order_id
      WHERE r.buyer_id = $1 OR r.seller_id = $1
      ORDER BY r.created_at DESC LIMIT 100`,
    [userId],
  );
  for (const r of rooms) {
    const last = r.last ? (await openMessages(keyring, q, [r.last]))[0]! : null;
    r.last_message = last ? (last.erased ? null : last.body) : null;
    delete r.last;
  }
  return rooms;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
/**
 * Append a message. The UPDATE on chat_rooms takes a row lock, so concurrent
 * writers to one room are serialized and seq is strictly monotonic and gapless
 * regardless of which API node accepted the message.
 */
export async function appendMessage(
  s: TxScope,
  roomId: string,
  senderId: string | null,
  kind: ChatMessage['kind'],
  body: string,
  flags: string[] = [],
  /** Required for messages from a user: their text is sealed with their own chat key. */
  keyring?: Keyring,
): Promise<ChatMessage> {
  if (senderId && !keyring) throw new Error('appendMessage: a user message needs the keyring to seal it');
  const createdAt = new Date().toISOString();
  const room = await one<{ last_seq: number; last_hash: string; buyer_id: string; seller_id: string; order_id: string | null }>(
    s.tx,
    `UPDATE chat_rooms SET last_seq = last_seq + 1 WHERE id = $1
       RETURNING last_seq, last_hash, buyer_id, seller_id, order_id`,
    [roomId],
  );
  const seq = room.last_seq;
  let mac: string;
  let sealed: string | null = null;
  if (senderId) {
    const key = (await userChatKey(keyring!, s.tx, senderId, true))!;
    if (!key) throw forbidden('chat_erased', 'Chat history for this account was erased');
    mac = bodyMac(key, body);
    sealed = seal(key, body, roomId, seq);
  } else {
    mac = systemMac(body);
  }
  const hash = messageHashV2(room.last_hash, seq, senderId, kind, mac, createdAt);
  const { body_sealed: _sealed, ...stored } = await one<StoredMessage>(
    s.tx,
    `INSERT INTO chat_messages (room_id, seq, sender_id, kind, body, flags, prev_hash, hash, created_at, hash_version, body_mac, body_sealed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, $10, $11) RETURNING *`,
    [roomId, seq, senderId, kind, sealed ? '' : body, flags, room.last_hash, hash, createdAt, mac, sealed],
  );
  const msg: ChatMessage = { ...stored, body };
  await s.tx.query('UPDATE chat_rooms SET last_hash = $2 WHERE id = $1', [roomId, hash]);
  s.publishRoom(roomId, { type: 'message', roomId, message: msg });
  return msg;
}

export async function postUserMessage(ctx: Ctx, roomId: string, user: { id: string; role: string; status: string }, body: string) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  return withScope(ctx, async (s) => {
    const room = await roomForParticipant(s.tx, roomId, user);
    const violations = detectOffPlatform(body);
    const flags = violations.map((v) => `offplatform:${v}`);
    const msg = await appendMessage(s, roomId, user.id, 'text', body, flags, ctx.keyring);

    if (violations.length && user.role === 'user') {
      // Into the staff queue (Admin → Moderation) to confirm or dismiss.
      await s.tx.query(`INSERT INTO chat_flags (room_id, seq, user_id, reasons) VALUES ($1, $2, $3, $4) ON CONFLICT (room_id, seq) DO NOTHING`, [roomId, msg.seq, user.id, violations]);
      const { offplatform_strikes } = await one<{ offplatform_strikes: number }>(
        s.tx,
        'UPDATE users SET offplatform_strikes = offplatform_strikes + 1 WHERE id = $1 RETURNING offplatform_strikes',
        [user.id],
      );
      const limit = ctx.cfg.OFFPLATFORM_SUSPEND_STRIKES;
      if (offplatform_strikes >= limit) {
        await s.tx.query(`UPDATE users SET status = 'suspended', suspension_reason = 'off_platform_contact' WHERE id = $1`, [user.id]);
        await appendMessage(s, roomId, null, 'warning', 'This user has been suspended for repeatedly attempting to move the deal off-platform. Do not continue this trade outside the marketplace.');
      } else {
        await appendMessage(
          s,
          roomId,
          null,
          'warning',
          `Warning (${offplatform_strikes}/${limit}): sharing external contacts or payment methods is prohibited. ` +
            'Trades completed off-platform are not covered by escrow or the Trust Protocol.',
        );
      }
    }

    const counterpart = room.buyer_id === user.id ? room.seller_id : room.buyer_id;
    s.notifyUser(counterpart, 'chat.message', { roomId, seq: msg.seq });
    if (room.order_id && counterpart === room.seller_id) {
      await enqueueWebhook(s.tx, room.seller_id, 'chat.message', { room_id: roomId, order_id: room.order_id, seq: msg.seq, body: msg.body });
    }
    return msg;
  });
}

export async function listMessages(keyring: Keyring, q: Queryable, roomId: string, afterSeq = 0, limit = 200): Promise<ChatMessage[]> {
  const rows = await many<StoredMessage>(q, 'SELECT * FROM chat_messages WHERE room_id = $1 AND seq > $2 ORDER BY seq LIMIT $3', [roomId, afterSeq, Math.min(limit, 500)]);
  return openMessages(keyring, q, rows);
}

/**
 * Recompute the hash chain. Any edited, deleted, re-ordered or inserted message breaks it.
 * v2 messages chain over their stored digest. With the keyring, every readable message's text is
 * also checked against its digest (so a swapped ciphertext is caught); erased ones can't be.
 */
export async function verifyChain(q: Queryable, roomId: string, keyring?: Keyring) {
  const room = await maybeOne<{ purged_at: string | null; purged_messages: number | null; last_hash: string }>(q, 'SELECT purged_at, purged_messages, last_hash FROM chat_rooms WHERE id = $1', [roomId]);
  if (room?.purged_at) {
    // Messages were deleted at the end of the retention period; the final hash is kept.
    return { valid: true, messages: 0, brokenAtSeq: null, headHash: room.last_hash, purgedAt: room.purged_at, purgedMessages: room.purged_messages };
  }
  const msgs = await many<StoredMessage>(q, 'SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY seq', [roomId]);
  let prev = '0'.repeat(64);
  let erased = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const at = new Date(m.created_at).toISOString();
    let ok: boolean;
    if (m.hash_version === 2) {
      ok = !!m.body_mac && m.hash === messageHashV2(prev, m.seq, m.sender_id, m.kind, m.body_mac, at);
      if (ok && !m.sender_id) ok = systemMac(m.body ?? '') === m.body_mac;
      if (ok && m.sender_id && keyring) {
        const key = await userChatKey(keyring, q, m.sender_id);
        if (!key) erased++;
        else {
          try {
            ok = bodyMac(key, unseal(key, m.body_sealed ?? '', m.room_id, Number(m.seq))) === m.body_mac;
          } catch {
            ok = false; // ciphertext tampered with or moved
          }
        }
      }
    } else {
      ok = m.hash === messageHash(prev, m.seq, m.sender_id, m.kind, m.body ?? '', at);
    }
    if (m.seq !== i + 1 || m.prev_hash !== prev || !ok) {
      return { valid: false, messages: msgs.length, brokenAtSeq: m.seq, headHash: prev, erasedMessages: erased };
    }
    prev = m.hash;
  }
  return { valid: true, messages: msgs.length, brokenAtSeq: null, headHash: prev, erasedMessages: erased };
}
