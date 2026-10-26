import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, withTx } from '../db.js';
import { hmacSha256, randomToken } from '../lib/crypto.js';
import { AppError, notFound, unauthorized } from '../lib/errors.js';
import { enqueueEmail } from './notifications.js';
import { assertMaySignIn } from './users.js';

/**
 * Sessions = short-lived access tokens + rotating refresh tokens.
 *
 *  - Access token: 15-minute JWT carrying the session id (`sid`). Every request
 *    checks the session is not revoked, so sign-out and "sign out everywhere"
 *    take effect immediately rather than when the JWT expires.
 *  - Refresh token: opaque, 30 days, stored only as an HMAC. Each use rotates it:
 *    the old row is marked rotated and a new row joins the same family.
 *  - Reuse detection: presenting an already-rotated token means it was copied.
 *    The whole family (that device's sign-in) is revoked and the user is emailed.
 *    A 10-second grace window absorbs two tabs refreshing at the same moment.
 */
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;
const REUSE_GRACE_SECONDS = 10;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
}

const hashToken = (ctx: Ctx, token: string) => hmacSha256(ctx.cfg.JWT_SECRET, `refresh:${token}`);

export async function issueAccessToken(ctx: Ctx, userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ purpose: 'session', sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(ctx.cfg.JWT_SECRET));
}

async function insertSession(ctx: Ctx, q: Queryable, userId: string, familyId: string, mfa: boolean, meta: SessionMeta): Promise<IssuedSession> {
  const refreshToken = `rt_${randomToken(32)}`;
  const { rows } = await q.query(
    `INSERT INTO sessions (user_id, family_id, token_hash, mfa, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id`,
    [userId, familyId, hashToken(ctx, refreshToken), mfa, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, REFRESH_TTL_DAYS],
  );
  const sessionId = rows[0].id as string;
  return { accessToken: await issueAccessToken(ctx, userId, sessionId), refreshToken, sessionId, expiresIn: ACCESS_TTL_SECONDS };
}

export async function createSession(ctx: Ctx, userId: string, opts: { mfa: boolean } & SessionMeta): Promise<IssuedSession> {
  return insertSession(ctx, ctx.db, userId, randomUUID(), opts.mfa, opts);
}

export async function refreshSession(ctx: Ctx, refreshToken: string, meta: SessionMeta): Promise<IssuedSession & { userId: string }> {
  const outcome = await withTx(ctx.db, async (tx) => {
    const s = await maybeOne(tx, 'SELECT * FROM sessions WHERE token_hash = $1 FOR UPDATE', [hashToken(ctx, refreshToken)]);
    if (!s || s.revoked_at || new Date(s.expires_at) <= new Date()) return { kind: 'invalid' as const };
    if (s.rotated_at) {
      if (Date.now() - new Date(s.rotated_at).getTime() < REUSE_GRACE_SECONDS * 1000) return { kind: 'race' as const };
      await tx.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh_token_reuse' WHERE family_id = $1 AND revoked_at IS NULL`, [s.family_id]);
      await enqueueEmail(tx, s.user_id, 'session_reuse_detected', { userAgent: s.user_agent, ip: s.ip });
      return { kind: 'reuse' as const };
    }
    await tx.query('UPDATE sessions SET rotated_at = now(), last_used_at = now() WHERE id = $1', [s.id]);
    const user = await maybeOne<{ status: string; suspended_until: string | null; role: string; staff_roles: string[] | null }>(tx, `SELECT status, suspended_until, role, staff_roles FROM users WHERE id = $1`, [s.user_id]);
    if (!user) return { kind: 'invalid' as const };
    try {
      assertMaySignIn(user); // Round 23d
    } catch {
      return { kind: 'invalid' as const };
    }
    const issued = await insertSession(ctx, tx, s.user_id, s.family_id, s.mfa, { userAgent: meta.userAgent ?? s.user_agent, ip: meta.ip });
    return { kind: 'ok' as const, issued: { ...issued, userId: s.user_id as string } };
  });
  if (outcome.kind === 'ok') return outcome.issued;
  if (outcome.kind === 'race') throw new AppError(409, 'refresh_superseded', 'This session was just refreshed elsewhere; retry with the newest token');
  if (outcome.kind === 'reuse') ctx.log.warn({}, 'refresh token reuse detected: session family revoked');
  throw unauthorized('Session expired. Sign in again.');
}

/** Resolve the session behind an access token. Returns null if revoked. */
export async function activeSession(q: Queryable, sessionId: string) {
  return maybeOne<{ id: string; family_id: string; mfa: boolean; user_id: string }>(
    q,
    'SELECT id, family_id, mfa, user_id FROM sessions WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}

export async function revokeFamily(ctx: Ctx, userId: string, familyId: string, reason: string) {
  const res = await ctx.db.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $3 WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
    [userId, familyId, reason],
  );
  return res.rowCount ?? 0;
}

export async function revokeByRefreshToken(ctx: Ctx, refreshToken: string) {
  await ctx.db.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = 'signed_out'
      WHERE family_id = (SELECT family_id FROM sessions WHERE token_hash = $1) AND revoked_at IS NULL`,
    [hashToken(ctx, refreshToken)],
  );
}

export async function revokeOtherSessions(q: Queryable, userId: string, keepFamilyId: string | null, reason: string) {
  const res = await q.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR family_id <> $2)`,
    [userId, keepFamilyId, reason],
  );
  return res.rowCount ?? 0;
}

/** "Chrome on Windows"-style label for the devices list. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os =
    /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 40);
}

/** One entry per signed-in device (the newest row of each live family). */
export async function listSessions(ctx: Ctx, userId: string, currentFamilyId?: string) {
  const rows = await many(
    ctx.db,
    `SELECT DISTINCT ON (family_id) family_id, user_agent, host(ip) AS ip, created_at, last_used_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()
      ORDER BY family_id, created_at DESC`,
    [userId],
  );
  return rows
    .map((r) => ({ id: r.family_id, device: describeUserAgent(r.user_agent), userAgent: r.user_agent, ip: r.ip, signedInAt: r.created_at, lastActiveAt: r.last_used_at, current: r.family_id === currentFamilyId }))
    .sort((a, b) => +new Date(b.lastActiveAt) - +new Date(a.lastActiveAt));
}

export async function revokeSessionById(ctx: Ctx, userId: string, familyId: string) {
  if ((await revokeFamily(ctx, userId, familyId, 'revoked_by_user')) === 0) throw notFound('Session');
}
