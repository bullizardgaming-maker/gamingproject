import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { listMessages, postUserMessage, roomForParticipant } from '../domain/chat.js';
import { getUser, userFromToken, type User } from '../domain/users.js';
import { activeSession } from '../domain/sessions.js';
import { AppError } from '../lib/errors.js';
import { touchPresence } from '../domain/presence.js';

/**
 * WebSocket chat + notification gateway.
 *
 * Protocol (JSON frames):
 *   -> {type:'auth', token}                          first frame, within 5s
 *   -> {type:'subscribe', roomId, afterSeq?}         join a room; server replays history after afterSeq
 *   -> {type:'message', roomId, body, clientMsgId}   send; server assigns seq and acks
 *   -> {type:'sync', roomId, afterSeq}               fetch anything missed after a reconnect
 *   -> {type:'unsubscribe', roomId} | {type:'ping'}
 *   <- {type:'ready'} {type:'history'} {type:'message'} {type:'ack'} {type:'notification'} {type:'error'} {type:'pong'}
 *
 * Messages are ordered by the server-assigned `seq`, never by client clocks.
 * Horizontal scale: a message accepted on any node is published on pub/sub
 * (Redis) channel room:<id>; every node relays it to its local subscribers.
 */
const Frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string() }),
  z.object({ type: z.literal('subscribe'), roomId: z.string().uuid(), afterSeq: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('unsubscribe'), roomId: z.string().uuid() }),
  z.object({ type: z.literal('message'), roomId: z.string().uuid(), body: z.string().trim().min(1).max(4_000), clientMsgId: z.string().max(64).optional() }),
  z.object({ type: z.literal('sync'), roomId: z.string().uuid(), afterSeq: z.number().int().min(0) }),
  z.object({ type: z.literal('ping') }),
]);

export function registerGateway(app: FastifyInstance, ctx: Ctx) {
  const rooms = new Map<string, Set<WebSocket>>();
  const users = new Map<string, Set<WebSocket>>();

  const add = (map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(ws);
  };
  const remove = (map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket) => {
    const set = map.get(key);
    set?.delete(ws);
    if (set && !set.size) map.delete(key);
  };
  const send = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  };

  ctx.pubsub.onMessage((channel, payload) => {
    const [kind, id] = channel.split(':') as [string, string];
    const targets = kind === 'room' ? rooms.get(id) : kind === 'user' ? users.get(id) : undefined;
    targets?.forEach((ws) => send(ws, payload));
  });

  app.get('/ws', { websocket: true }, (ws: WebSocket) => {
    let user: User | null = null;
    const joined = new Set<string>();
    // Simple token bucket: 10 messages per 10 seconds.
    let tokens = 10;
    const refill = setInterval(() => (tokens = Math.min(10, tokens + 1)), 1_000);
    const authTimer = setTimeout(() => !user && ws.close(4401, 'auth timeout'), 5_000);

    ws.on('close', () => {
      clearInterval(refill);
      clearTimeout(authTimer);
      joined.forEach((r) => remove(rooms, r, ws));
      if (user) remove(users, user.id, ws);
    });

    ws.on('message', async (raw) => {
      let clientMsgId: string | undefined;
      try {
        const frame = Frame.parse(JSON.parse(raw.toString()));
        if (frame.type === 'message') clientMsgId = frame.clientMsgId;

        if (frame.type === 'auth') {
          try {
            user = await userFromToken(ctx, frame.token);
          } catch {
            return ws.close(4401, 'invalid session'); // client refreshes its access token and reconnects
          }
          add(users, user.id, ws);
          touchPresence(ctx, user.id);
          return send(ws, { type: 'ready', userId: user.id });
        }
        // An open tab pings, so a signed-in user with the site open shows as online.
        if (user) touchPresence(ctx, user.id);
        if (frame.type === 'ping') return send(ws, { type: 'pong' });
        if (!user) throw new AppError(401, 'unauthorized', 'Authenticate first');

        switch (frame.type) {
          case 'subscribe': {
            await roomForParticipant(ctx.db, frame.roomId, user);
            joined.add(frame.roomId);
            add(rooms, frame.roomId, ws);
            const messages = await listMessages(ctx.keyring, ctx.db, frame.roomId, frame.afterSeq ?? 0, 500);
            return send(ws, { type: 'history', roomId: frame.roomId, messages });
          }
          case 'sync': {
            if (!joined.has(frame.roomId)) throw new AppError(403, 'not_subscribed', 'Subscribe to the room first');
            const messages = await listMessages(ctx.keyring, ctx.db, frame.roomId, frame.afterSeq, 500);
            return send(ws, { type: 'history', roomId: frame.roomId, messages });
          }
          case 'unsubscribe':
            joined.delete(frame.roomId);
            return remove(rooms, frame.roomId, ws);
          case 'message': {
            if (tokens <= 0) throw new AppError(429, 'rate_limited', 'Slow down');
            tokens--;
            // Re-read the user so a suspension applies to open sockets too.
            // Re-check the account and session so suspensions and sign-outs apply to open sockets too.
            const fresh = await getUser(ctx.db, user.id);
            if (!fresh || (user.session_id && !(await activeSession(ctx.db, user.session_id)))) return ws.close(4401, 'session ended');
            user = { ...fresh, session_id: user.session_id, session_family: user.session_family, session_mfa: user.session_mfa };
            const msg = await postUserMessage(ctx, frame.roomId, user, frame.body);
            return send(ws, { type: 'ack', roomId: frame.roomId, clientMsgId: frame.clientMsgId, seq: msg.seq, id: msg.id });
          }
        }
      } catch (err) {
        const e = err instanceof AppError ? err : err instanceof z.ZodError || err instanceof SyntaxError ? new AppError(400, 'bad_frame', 'Malformed frame') : null;
        if (!e) ctx.log.error({ err }, 'ws handler error');
        send(ws, { type: 'error', code: e?.code ?? 'internal', message: e?.message ?? 'Internal error', clientMsgId });
      }
    });
  });
}
