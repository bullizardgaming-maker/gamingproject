import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { hasPermission } from './permissions.js';
import { sha256, type Keyring } from '../lib/crypto.js';
import { bodyMac, seal, systemMac, unseal, userChatKey } from './chatkeys.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
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
  kind: 'text' | 'system' | 'delivery' | 'warning' | 'attachment' | 'system_order';
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
    `SELECT r.*, o.title AS offer_title, ord.status AS order_status, ord.ref AS order_ref,
            bu.display_name AS buyer_name, su.display_name AS seller_name,
            (SELECT row_to_json(m) FROM (SELECT id, room_id, seq, sender_id, kind, body, body_sealed, hash_version, created_at FROM chat_messages m
                                          WHERE m.room_id = r.id ORDER BY seq DESC LIMIT 1) m) AS last
       FROM chat_rooms r
       LEFT JOIN offers o ON o.id = r.offer_id
       LEFT JOIN orders ord ON ord.id = r.order_id
       LEFT JOIN users bu ON bu.id = r.buyer_id
       LEFT JOIN users su ON su.id = r.seller_id
      WHERE r.buyer_id = $1 OR r.seller_id = $1
      ORDER BY r.created_at DESC LIMIT 100`,
    [userId],
  );
  for (const r of rooms) {
    const last = r.last ? (await openMessages(keyring, q, [r.last]))[0]! : null;
    r.last_message = last ? (last.erased ? null : last.body) : null;
    r.last_kind = last?.kind ?? null;
    r.last_sender_id = last?.sender_id ?? null;
    r.last_at = new Date(r.last?.created_at ?? r.created_at).toISOString();
    delete r.last;
  }
  // Inbox order: most recent activity first.
  rooms.sort((a, b) => b.last_at.localeCompare(a.last_at));
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
  /** A blocked attempt: stored for staff (and the hash chain), never shown to the room or pushed. */
  opts: { hidden?: boolean } = {},
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
    `INSERT INTO chat_messages (room_id, seq, sender_id, kind, body, flags, prev_hash, hash, created_at, hash_version, body_mac, body_sealed, hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, $10, $11, $12) RETURNING *`,
    [roomId, seq, senderId, kind, sealed ? '' : body, flags, room.last_hash, hash, createdAt, mac, sealed, !!opts.hidden],
  );
  const msg: ChatMessage = { ...stored, body };
  await s.tx.query('UPDATE chat_rooms SET last_hash = $2 WHERE id = $1', [roomId, hash]);
  if (!opts.hidden) s.publishRoom(roomId, { type: 'message', roomId, message: msg });
  return msg;
}

/** Staff-set action per offence (1st, 2nd, …); the last entry repeats. OFFPLATFORM_SUSPEND_STRIKES seeds nothing: the table rules. */
export type OffplatformAction = 'warn' | 'suspend' | 'ban';
export const OFFPLATFORM_BLOCKED_TEXT = 'Not sent. Sharing outside contacts can get your account banned right away.';
export async function offplatformPolicy(q: Queryable): Promise<OffplatformAction[]> {
  const r = await maybeOne<{ offplatform_actions: string[] }>(q, 'SELECT offplatform_actions FROM moderation_settings');
  return (r?.offplatform_actions?.length ? r.offplatform_actions : ['warn', 'warn', 'ban']) as OffplatformAction[];
}
export async function setOffplatformPolicy(q: Queryable, actions: OffplatformAction[], staffId: string) {
  await q.query('UPDATE moderation_settings SET offplatform_actions = $1, updated_by = $2, updated_at = now()', [actions, staffId]);
  return offplatformPolicy(q);
}

export async function postUserMessage(ctx: Ctx, roomId: string, user: { id: string; role: string; status: string }, body: string) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  const room0 = await roomForParticipant(ctx.db, roomId, user);
  // Email addresses are part of an account handover (credentials live in the encrypted box); nowhere else.
  const accountOrder = room0.order_id
    ? !!(await maybeOne(ctx.db, `SELECT 1 FROM orders o JOIN offers f ON f.id = o.offer_id JOIN categories c ON c.slug = f.category_slug WHERE o.id = $1 AND c.kind = 'account'`, [room0.order_id]))
    : false;
  const violations = detectOffPlatform(body, { allowEmail: accountOrder });
  const flags = violations.map((v) => `offplatform:${v}`);

  if (violations.length && user.role === 'user') {
    // Not delivered: kept hidden for the staff queue (Admin → Moderation) with the context around it.
    // Recorded in its own transaction, then refused, so the offence stands even though nothing was sent.
    const action = await withScope(ctx, async (s) => {
      const msg = await appendMessage(s, roomId, user.id, 'text', body, ['blocked', ...flags], ctx.keyring, { hidden: true });
      await s.tx.query(`INSERT INTO chat_flags (room_id, seq, user_id, reasons) VALUES ($1, $2, $3, $4) ON CONFLICT (room_id, seq) DO NOTHING`, [roomId, msg.seq, user.id, violations]);
      const { offplatform_strikes } = await one<{ offplatform_strikes: number }>(
        s.tx,
        'UPDATE users SET offplatform_strikes = offplatform_strikes + 1 WHERE id = $1 RETURNING offplatform_strikes',
        [user.id],
      );
      const policy = await offplatformPolicy(s.tx);
      const act = policy[Math.min(offplatform_strikes, policy.length) - 1]!;
      if (act !== 'warn') {
        await s.tx.query(`UPDATE users SET status = 'suspended', suspension_reason = $2 WHERE id = $1`, [user.id, act === 'ban' ? 'off_platform_ban' : 'off_platform_contact']);
        await appendMessage(s, roomId, null, 'warning', act === 'ban'
          ? 'This account has been banned for trying to move the deal outside Bullizard. Do not continue this trade anywhere else; staff will review the case.'
          : 'This account has been suspended for trying to move the deal outside Bullizard. Do not continue this trade anywhere else; staff will review the case.');
      }
      return act;
    });
    throw new AppError(422, 'offplatform_blocked', OFFPLATFORM_BLOCKED_TEXT, { action });
  }
  return withScope(ctx, async (s) => {
    const room = await roomForParticipant(s.tx, roomId, user);
    const msg = await appendMessage(s, roomId, user.id, 'text', body, flags, ctx.keyring);

    const counterpart = room.buyer_id === user.id ? room.seller_id : room.buyer_id;
    s.notifyUser(counterpart, 'chat.message', { roomId, seq: msg.seq });
    if (room.order_id && counterpart === room.seller_id) {
      await enqueueWebhook(s.tx, room.seller_id, 'chat.message', { room_id: roomId, order_id: room.order_id, seq: msg.seq, body: msg.body });
    }
    return msg;
  });
}

export async function listMessages(keyring: Keyring, q: Queryable, roomId: string, afterSeq = 0, limit = 200, opts: { includeHidden?: boolean } = {}): Promise<ChatMessage[]> {
  const rows = await many<StoredMessage>(q, `SELECT * FROM chat_messages WHERE room_id = $1 AND seq > $2 ${opts.includeHidden ? '' : 'AND NOT hidden'} ORDER BY seq LIMIT $3`, [roomId, afterSeq, Math.min(limit, 500)]);
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
