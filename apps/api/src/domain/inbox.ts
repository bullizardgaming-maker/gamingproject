import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isAllowedPushEndpoint } from '../providers/push.js';
import { EMAIL_CATEGORIES, type EmailCategory } from './notifications.js';

/**
 * In-app notification centre (the bell) and Web Push delivery.
 * Items are written by notify() in the business transaction; the worker then pushes them
 * live to open tabs over the WebSocket and to the user's subscribed devices.
 */
export async function listInbox(ctx: Ctx, userId: string, opts: { unreadOnly?: boolean; before?: string; limit?: number }) {
  const items = await many(
    ctx.db,
    `SELECT id, template, category, title, body, link, read_at, created_at FROM inbox_items
      WHERE user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL) AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at DESC LIMIT $4`,
    [userId, opts.unreadOnly ?? false, opts.before ?? null, Math.min(opts.limit ?? 30, 100)],
  );
  return { items, unread: await unreadCount(ctx, userId), nextBefore: items.length ? items[items.length - 1].created_at : null };
}

export async function unreadCount(ctx: Ctx, userId: string) {
  return (await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM inbox_items WHERE user_id = $1 AND read_at IS NULL', [userId])).n;
}

export async function markRead(ctx: Ctx, userId: string, id: string) {
  const row = await maybeOne(ctx.db, 'UPDATE inbox_items SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (!row) throw notFound('Notification');
  return { unread: await unreadCount(ctx, userId) };
}

export async function markAllRead(ctx: Ctx, userId: string) {
  await ctx.db.query('UPDATE inbox_items SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return { unread: 0 };
}

// ---------------------------------------------------------------------------
// Push subscriptions & preferences
// ---------------------------------------------------------------------------
export async function subscribePush(ctx: Ctx, userId: string, sub: { endpoint: string; p256dh: string; auth: string }, userAgent?: string) {
  if (!ctx.push.enabled) throw badRequest('push_disabled', 'Push notifications are not enabled on this server');
  const allowed = ctx.cfg.PUSH_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
  if (!isAllowedPushEndpoint(sub.endpoint, allowed)) throw badRequest('invalid_endpoint', 'That is not a known browser push service');
  // An endpoint belongs to one browser profile: re-subscribing moves it to whoever is signed in now.
  const row = await one(
    ctx.db,
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, failures = 0
     RETURNING id, created_at`,
    [userId, sub.endpoint, sub.p256dh, sub.auth, userAgent?.slice(0, 300) ?? null],
  );
  return row;
}

export async function unsubscribePush(ctx: Ctx, userId: string, endpoint: string) {
  await ctx.db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

export async function listPushSubscriptions(ctx: Ctx, userId: string) {
  return many(ctx.db, 'SELECT id, user_agent, created_at, last_success_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
}

export async function removePushSubscription(ctx: Ctx, userId: string, id: string) {
  await ctx.db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND id = $2', [userId, id]);
}

/** Push is opt-out per category (no category is forced: the inbox and email already cover mandatory ones). */
export async function getPushPreferences(ctx: Ctx, userId: string, isStaff: boolean) {
  const { push_preferences: prefs } = await one<{ push_preferences: Record<string, boolean> }>(ctx.db, 'SELECT push_preferences FROM users WHERE id = $1', [userId]);
  return (Object.keys(EMAIL_CATEGORIES) as EmailCategory[])
    .filter((c) => isStaff || !EMAIL_CATEGORIES[c].staffOnly)
    .map((c) => ({ category: c, label: EMAIL_CATEGORIES[c].label, enabled: prefs[c] !== false }));
}

export async function setPushPreferences(ctx: Ctx, userId: string, isStaff: boolean, changes: Record<string, boolean>) {
  for (const c of Object.keys(changes)) if (!EMAIL_CATEGORIES[c as EmailCategory]) throw badRequest('unknown_category', `Unknown category ${c}`);
  await ctx.db.query(`UPDATE users SET push_preferences = push_preferences || $2::jsonb WHERE id = $1`, [userId, JSON.stringify(changes)]);
  return getPushPreferences(ctx, userId, isStaff);
}

// ---------------------------------------------------------------------------
// Worker: live update + push
// ---------------------------------------------------------------------------
const MAX_PUSH_FAILURES = 10;

export async function dispatchInbox(ctx: Ctx, limit = 100): Promise<number> {
  const items = await withTx(ctx.db, (tx) =>
    many(
      tx,
      `UPDATE inbox_items i SET dispatched_at = now()
        WHERE i.id IN (SELECT id FROM inbox_items WHERE dispatched_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING i.id, i.user_id, i.template, i.category, i.title, i.body, i.link, i.created_at`,
      [limit],
    ),
  );
  for (const it of items) {
    // Open tabs update the bell immediately.
    await ctx.pubsub
      .publish(`user:${it.user_id}`, {
        type: 'notification',
        event: 'inbox.new',
        data: { id: it.id, template: it.template, category: it.category, title: it.title, body: it.body, link: it.link, created_at: it.created_at },
      })
      .catch((err) => ctx.log.error({ err }, 'inbox publish failed'));
    await ctx.db.query('UPDATE inbox_items SET push_status = $2 WHERE id = $1', [it.id, await pushItem(ctx, it)]);
  }
  return items.length;
}

async function pushItem(ctx: Ctx, it: { id: string; user_id: string; template: string; category: string; title: string; body: string; link: string | null }) {
  if (!ctx.push.enabled) return 'skipped';
  const { push_preferences: prefs } = await one<{ push_preferences: Record<string, boolean> }>(ctx.db, 'SELECT push_preferences FROM users WHERE id = $1', [it.user_id]);
  if (prefs[it.category] === false) return 'skipped';
  const subs = await many(ctx.db, 'SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id = $1', [it.user_id]);
  if (!subs.length) return 'skipped';
  const msg = { id: it.id, title: it.title, body: it.body, url: it.link ? `${ctx.cfg.PUBLIC_WEB_URL}${it.link}` : null, tag: it.template };
  let delivered = false;
  for (const sub of subs) {
    const result = await ctx.push.send(sub, msg);
    if (result === 'ok') {
      delivered = true;
      await ctx.db.query('UPDATE push_subscriptions SET failures = 0, last_success_at = now() WHERE id = $1', [sub.id]);
    } else if (result === 'gone' || sub.failures + 1 >= MAX_PUSH_FAILURES) {
      await ctx.db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
    } else {
      await ctx.db.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [sub.id]);
    }
  }
  return delivered ? 'sent' : 'failed';
}
