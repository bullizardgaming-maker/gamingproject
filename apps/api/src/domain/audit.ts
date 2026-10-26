import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many } from '../db.js';

/**
 * Append-only record of every staff action (and staff reads of other people's
 * orders and chats). Rows can't be updated, deleted or truncated (DB triggers),
 * so an admin can't cover their own tracks.
 */
/** Round 23d: the same audit row without a request (WebSocket reads, jobs acting for a person). */
export async function auditAs(
  q: Queryable,
  actor: { id: string; role: string; staff_roles?: string[] | null },
  ip: string | null,
  action: string,
  target: { type: string; id?: string | null },
  details: Record<string, unknown> = {},
) {
  await q.query(
    `INSERT INTO admin_audit_log (actor_id, actor_role, action, target_type, target_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id, [actor.role, ...(actor.staff_roles ?? [])].filter((r) => r !== 'user').join(',') || actor.role, action, target.type, target.id ?? null, JSON.stringify(details), ip],
  );
}

export async function audit(
  q: Queryable,
  req: FastifyRequest,
  action: string,
  target: { type: string; id?: string | null },
  details: Record<string, unknown> = {},
) {
  const actor = req.user!;
  await q.query(
    `INSERT INTO admin_audit_log (actor_id, actor_role, action, target_type, target_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id, [actor.role, ...(actor.staff_roles ?? [])].filter((r) => r !== 'user').join(',') || actor.role, action, target.type, target.id ?? null, JSON.stringify(details), req.ip],
  );
}

/**
 * Round 23e (item 12): the same row at most once per actor, target and session within `minutes` — for reads that repeat
 * (a staff client polling a chat every few seconds). The first poll of each session and window is on the record.
 */
export const AUDIT_POLL_MINUTES = 15;
export async function auditOncePerSession(
  q: Queryable,
  req: FastifyRequest,
  action: string,
  target: { type: string; id: string },
  details: Record<string, unknown> = {},
  minutes = AUDIT_POLL_MINUTES,
) {
  const actor = req.user!;
  const session = actor.session_id ?? null;
  await q.query(
    `INSERT INTO admin_audit_log (actor_id, actor_role, action, target_type, target_id, details, ip)
     SELECT $1, $2, $3, $4, $5, $6, $7
      WHERE NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE actor_id = $1 AND action = $3 AND target_id = $5 AND details->>'poll' = 'true'
                          AND details->>'session' IS NOT DISTINCT FROM $8 AND created_at > now() - make_interval(mins => $9))`,
    [actor.id, [actor.role, ...(actor.staff_roles ?? [])].filter((r) => r !== 'user').join(',') || actor.role, action, target.type, target.id, JSON.stringify({ ...details, poll: true, session }), req.ip, session, minutes],
  );
}

export async function listAudit(ctx: Ctx, f: { actorId?: string; targetType?: string; targetId?: string; action?: string; before?: number; limit?: number }) {
  return many(
    ctx.db,
    `SELECT l.id, l.actor_id, u.display_name AS actor_name, l.actor_role, l.action, l.target_type, l.target_id, l.details, host(l.ip) AS ip, l.created_at
       FROM admin_audit_log l JOIN users u ON u.id = l.actor_id
      WHERE ($1::uuid IS NULL OR l.actor_id = $1) AND ($2::text IS NULL OR l.target_type = $2)
        AND ($3::text IS NULL OR l.target_id = $3) AND ($4::text IS NULL OR l.action = $4)
        AND ($5::bigint IS NULL OR l.id < $5)
      ORDER BY l.id DESC LIMIT $6`,
    [f.actorId ?? null, f.targetType ?? null, f.targetId ?? null, f.action ?? null, f.before ?? null, Math.min(f.limit ?? 100, 500)],
  );
}
