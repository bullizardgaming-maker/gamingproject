import type { Ctx } from '../context.js';
import { many, maybeOne } from '../db.js';
import { hmacSha256, randomToken, safeEqual } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { PUBLIC_USER_COLUMNS, type User } from './users.js';

export const API_SCOPES = ['orders:read', 'orders:write', 'inventory:write', 'offers:write', 'chat:write', 'webhooks:manage', 'reports:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Key format: mk_<prefix>_<secret>. Only an HMAC of the full key is stored. */
export async function createApiKey(ctx: Ctx, user: User, name: string, scopes: string[]) {
  if (user.kyc_tier < 2) throw badRequest('kyc_required', 'Tier 2 verification is required for API access');
  const bad = scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
  if (bad.length || !scopes.length) throw badRequest('invalid_scopes', `Valid scopes: ${API_SCOPES.join(', ')}`);
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  const key = `mk_${prefix}_${randomToken(32)}`;
  const { rows } = await ctx.db.query(
    'INSERT INTO api_keys (user_id, name, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, prefix, scopes, created_at',
    [user.id, name, prefix, hmacSha256(ctx.cfg.FINGERPRINT_KEY, key), scopes],
  );
  return { ...rows[0], key }; // shown once
}

export async function listApiKeys(ctx: Ctx, userId: string) {
  return many(ctx.db, 'SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
}

export async function revokeApiKey(ctx: Ctx, userId: string, id: string) {
  await ctx.db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
}

export async function authenticateApiKey(ctx: Ctx, key: string): Promise<{ user: User; scopes: string[] }> {
  const m = /^mk_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(key);
  if (!m) throw unauthorized('Malformed API key');
  const row = await maybeOne(ctx.db, 'SELECT * FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL', [m[1]]);
  if (!row || !safeEqual(row.key_hash, hmacSha256(ctx.cfg.FINGERPRINT_KEY, key))) throw unauthorized('Invalid API key');
  const user = await maybeOne<User>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [row.user_id]);
  if (!user || user.status !== 'active') throw unauthorized('Account suspended');
  ctx.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  return { user, scopes: row.scopes };
}
