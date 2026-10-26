import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { hmacSha256, randomToken, safeEqual } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Public status page. Each component's status is the worse of:
 *  - what the system measures itself: the database answers, realtime (Redis) answers, and the
 *    worker jobs behind each component have a recent heartbeat;
 *  - the impact of any open incident or in-progress maintenance staff posted for it.
 * Staff post incidents and planned maintenance with timestamped updates; confirmed email
 * subscribers get each one. Nothing here reveals internals beyond a component's state.
 */
export const COMPONENTS = {
  website: { name: 'Website and app', jobs: [] },
  checkout: { name: 'Card and crypto checkout', jobs: ['expire_unpaid'] },
  delivery: { name: 'Instant delivery and escrow release', jobs: ['auto_release', 'late_deliveries'] },
  chat: { name: 'Order chat and live updates', jobs: [] },
  payouts: { name: 'Seller payouts', jobs: [] },
  notifications: { name: 'Email and push notifications', jobs: ['emails', 'inbox'] },
} as const satisfies Record<string, { name: string; jobs: readonly string[] }>;
export type ComponentId = keyof typeof COMPONENTS;
export const COMPONENT_IDS = Object.keys(COMPONENTS) as ComponentId[];

export type ComponentStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
const RANK: Record<ComponentStatus, number> = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };
const IMPACT_STATUS: Record<string, ComponentStatus> = { none: 'operational', minor: 'degraded', major: 'partial_outage', critical: 'major_outage' };
const worse = (a: ComponentStatus, b: ComponentStatus) => (RANK[b] > RANK[a] ? b : a);

const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed'] as const;
const CLOSED = new Set(['resolved', 'completed']);

/** Live signals: a job heartbeat older than 5 minutes degrades its component; older than 15, an outage. */
async function measured(ctx: Ctx): Promise<Record<ComponentId, ComponentStatus>> {
  const out = Object.fromEntries(COMPONENT_IDS.map((c) => [c, 'operational'])) as Record<ComponentId, ComponentStatus>;
  const dbOk = await ctx.db.query('SELECT 1').then(() => true, () => false);
  if (!dbOk) {
    for (const c of COMPONENT_IDS) out[c] = 'major_outage';
    return out;
  }
  if (!(await ctx.pubsub.ping().catch(() => false))) out.chat = 'degraded';
  const beats = await many<{ job: string; age: number }>(ctx.db, `SELECT job, EXTRACT(EPOCH FROM now() - last_ok_at)::int AS age FROM worker_heartbeats`);
  const age = new Map(beats.map((b) => [b.job, Number(b.age)]));
  // Only judge jobs that have run at least once: a fresh deployment isn't an outage.
  for (const c of COMPONENT_IDS) {
    for (const job of COMPONENTS[c].jobs as readonly string[]) {
      const a = age.get(job);
      if (a === undefined) continue;
      if (a > 15 * 60) out[c] = worse(out[c], 'major_outage');
      else if (a > 5 * 60) out[c] = worse(out[c], 'degraded');
    }
  }
  const failedPayouts = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM withdrawals WHERE status = 'failed' AND created_at > now() - interval '1 hour'`);
  if (failedPayouts.n >= 5) out.payouts = worse(out.payouts, 'degraded');
  return out;
}

async function withUpdates(rows: any[]) {
  return rows.map((r) => ({ ...r, updates: r.updates ?? [] }));
}

const INCIDENT_SQL = `
  SELECT i.id, i.kind, i.title, i.impact, i.status, i.components, i.scheduled_start, i.scheduled_end, i.created_at, i.resolved_at,
         COALESCE((SELECT json_agg(json_build_object('status', u.status, 'body', u.body, 'at', u.created_at) ORDER BY u.created_at DESC)
                     FROM incident_updates u WHERE u.incident_id = i.id), '[]') AS updates
    FROM incidents i`;

let cache: { at: number; value: unknown } | null = null;
/** For tests and after staff changes: the next read recomputes. */
export const clearStatusCache = () => {
  cache = null;
};

export async function statusSummary(ctx: Ctx, fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.value;
  const live = await measured(ctx);
  const open = await withUpdates(await many(ctx.db, `${INCIDENT_SQL} WHERE i.resolved_at IS NULL ORDER BY i.created_at DESC`));
  const recent = await withUpdates(await many(ctx.db, `${INCIDENT_SQL} WHERE i.resolved_at > now() - interval '14 days' ORDER BY i.resolved_at DESC LIMIT 20`));

  const components = COMPONENT_IDS.map((id) => {
    let status = live[id];
    for (const i of open) {
      if (!i.components.includes(id)) continue;
      if (i.kind === 'maintenance') {
        if (i.status === 'in_progress') status = worse(status, 'maintenance');
      } else {
        status = worse(status, IMPACT_STATUS[i.impact] ?? 'degraded');
      }
    }
    return { id, name: COMPONENTS[id].name, status, measured: live[id] };
  });
  const top = components.reduce<ComponentStatus>((a, c) => worse(a, c.status), 'operational');
  const value = {
    status: top,
    description:
      top === 'operational' ? 'All systems operational' : top === 'maintenance' ? 'Scheduled maintenance in progress' : top === 'degraded' ? 'Some systems are slower than usual' : 'Some systems are having problems',
    components,
    incidents: open.filter((i) => i.kind === 'incident'),
    maintenance: open.filter((i) => i.kind === 'maintenance'),
    recent,
    updatedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}

export async function getIncident(ctx: Ctx, id: string) {
  const row = await maybeOne(ctx.db, `${INCIDENT_SQL} WHERE i.id = $1`, [id]);
  if (!row) throw notFound('Incident');
  return row;
}

function checkComponents(list: string[]) {
  const bad = list.filter((c) => !COMPONENT_IDS.includes(c as ComponentId));
  if (bad.length) throw badRequest('unknown_component', `Unknown component(s): ${bad.join(', ')}`);
}

export async function createIncident(
  ctx: Ctx,
  staffId: string,
  input: { kind: 'incident' | 'maintenance'; title: string; impact: string; components: string[]; body: string; scheduledStart?: string; scheduledEnd?: string; notify?: boolean },
) {
  checkComponents(input.components);
  const maintenance = input.kind === 'maintenance';
  if (maintenance && (!input.scheduledStart || !input.scheduledEnd || new Date(input.scheduledEnd) <= new Date(input.scheduledStart))) {
    throw badRequest('invalid_schedule', 'Maintenance needs a start and a later end');
  }
  const status = maintenance ? 'scheduled' : 'investigating';
  const incident = await withTx(ctx.db, async (tx) => {
    const i = await one(
      tx,
      `INSERT INTO incidents (kind, title, impact, status, components, scheduled_start, scheduled_end, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [input.kind, input.title, maintenance ? 'none' : input.impact, status, input.components, input.scheduledStart ?? null, input.scheduledEnd ?? null, staffId],
    );
    await tx.query(`INSERT INTO incident_updates (incident_id, status, body, author_id) VALUES ($1, $2, $3, $4)`, [i.id, status, input.body, staffId]);
    if (input.notify !== false) await queueSubscriberEmails(ctx, tx, i, status, input.body);
    return i;
  });
  cache = null;
  return getIncident(ctx, incident.id);
}

export async function updateIncident(ctx: Ctx, staffId: string, id: string, input: { status: string; body: string; impact?: string; notify?: boolean }) {
  await withTx(ctx.db, async (tx) => {
    const i = await maybeOne<any>(tx, `SELECT * FROM incidents WHERE id = $1 FOR UPDATE`, [id]);
    if (!i) throw notFound('Incident');
    if (i.resolved_at) throw badRequest('incident_closed', 'This incident is already closed');
    const allowed: readonly string[] = i.kind === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES;
    if (!allowed.includes(input.status)) throw badRequest('invalid_status', `Status must be one of ${allowed.join(', ')}`);
    await tx.query(
      `UPDATE incidents SET status = $2, impact = COALESCE($3, impact), resolved_at = CASE WHEN $4 THEN now() END WHERE id = $1`,
      [id, input.status, i.kind === 'maintenance' ? null : input.impact ?? null, CLOSED.has(input.status)],
    );
    await tx.query(`INSERT INTO incident_updates (incident_id, status, body, author_id) VALUES ($1, $2, $3, $4)`, [id, input.status, input.body, staffId]);
    if (input.notify !== false) await queueSubscriberEmails(ctx, tx, i, input.status, input.body);
  });
  cache = null;
  return getIncident(ctx, id);
}

export async function listIncidents(ctx: Ctx) {
  return many(ctx.db, `${INCIDENT_SQL} ORDER BY i.created_at DESC LIMIT 100`);
}

// ---------------------------------------------------------------------------
// Subscribers (double opt-in) and their emails
// ---------------------------------------------------------------------------
const hash = (ctx: Ctx, token: string) => hmacSha256(ctx.cfg.FINGERPRINT_KEY, `status:${token}`);
/** Stable per subscriber, derived rather than stored, so the link in every past email keeps working. */
const unsubscribeToken = (ctx: Ctx, subscriberId: string) => `${subscriberId}.${hmacSha256(ctx.cfg.FINGERPRINT_KEY, `status-unsub:${subscriberId}`).slice(0, 32)}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Same answer whether or not the address is already subscribed, so it can't be used to probe. */
export async function subscribe(ctx: Ctx, email: string) {
  const addr = email.trim().toLowerCase();
  if (!EMAIL_RE.test(addr) || addr.length > 254) throw badRequest('invalid_email', 'Enter a valid email address');
  const confirm = randomToken(24);
  const row = await maybeOne<{ id: string; confirmed_at: string | null }>(
    ctx.db,
    `INSERT INTO status_subscribers (email, confirm_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET confirm_hash = EXCLUDED.confirm_hash WHERE status_subscribers.confirmed_at IS NULL
     RETURNING id, confirmed_at`,
    [addr, hash(ctx, confirm)],
  );
  if (row) {
    const link = `${ctx.cfg.PUBLIC_WEB_URL}/status?confirm=${confirm}`;
    await ctx.messenger.send({
      channel: 'email',
      to: addr,
      subject: 'Confirm Bullizard status updates',
      body: `Confirm you want emails when Bullizard has an incident or planned maintenance:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`,
    });
  }
  return { ok: true };
}

export async function confirmSubscription(ctx: Ctx, token: string) {
  const { rowCount } = await ctx.db.query(
    `UPDATE status_subscribers SET confirmed_at = now(), confirm_hash = NULL WHERE confirm_hash = $1 AND confirmed_at IS NULL`,
    [hash(ctx, token)],
  );
  if (!rowCount) throw badRequest('invalid_token', 'This link has expired or was already used');
  return { confirmed: true };
}

export async function unsubscribe(ctx: Ctx, token: string) {
  const id = token.split('.')[0] ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id) || !safeEqual(unsubscribeToken(ctx, id), token)) throw badRequest('invalid_token', 'This unsubscribe link is not valid');
  await ctx.db.query(`DELETE FROM status_subscribers WHERE id = $1`, [id]);
  return { unsubscribed: true };
}

const LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  scheduled: 'Scheduled maintenance',
  in_progress: 'Maintenance in progress',
  completed: 'Maintenance completed',
};

async function queueSubscriberEmails(ctx: Ctx, tx: import('../db.js').Tx, incident: any, status: string, body: string) {
  const affected = (incident.components as string[]).map((c) => COMPONENTS[c as ComponentId]?.name ?? c).join(', ');
  const when =
    incident.kind === 'maintenance' && incident.scheduled_start
      ? `\nWindow: ${new Date(incident.scheduled_start).toUTCString()} to ${new Date(incident.scheduled_end).toUTCString()}`
      : '';
  await tx.query(
    `INSERT INTO status_emails (subscriber_id, subject, body)
     SELECT id, $1, $2 FROM status_subscribers WHERE confirmed_at IS NOT NULL`,
    [`[${LABEL[status] ?? status}] ${incident.title}`, `${body}\n\nAffected: ${affected || 'none listed'}${when}\n\n${ctx.cfg.PUBLIC_WEB_URL}/status`],
  );
}

/** Worker: send queued subscriber emails, each with its own unsubscribe link. */
export async function dispatchStatusEmails(ctx: Ctx, limit = 100) {
  const batch = await withTx(ctx.db, (tx) =>
    many<{ id: string; subject: string; body: string; email: string; subscriber_id: string; attempts: number }>(
      tx,
      `UPDATE status_emails e SET attempts = e.attempts + 1 FROM status_subscribers s
        WHERE s.id = e.subscriber_id AND e.id IN (SELECT id FROM status_emails WHERE status = 'pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING e.id, e.subject, e.body, e.attempts, s.email, s.id AS subscriber_id`,
      [limit],
    ),
  );
  for (const m of batch) {
    try {
      const unsub = `${ctx.cfg.PUBLIC_WEB_URL}/status?unsubscribe=${unsubscribeToken(ctx, m.subscriber_id)}`;
      await ctx.messenger.send({ channel: 'email', to: m.email, subject: m.subject, body: `${m.body}\n\nUnsubscribe: ${unsub}`, idempotencyKey: `status-email-${m.id}` });
      await ctx.db.query(`UPDATE status_emails SET status = 'sent', sent_at = now() WHERE id = $1`, [m.id]);
    } catch (err) {
      await ctx.db.query(`UPDATE status_emails SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id = $1`, [m.id]);
      ctx.log.warn({ err: (err as Error).message }, 'status email failed');
    }
  }
  return batch.length;
}
