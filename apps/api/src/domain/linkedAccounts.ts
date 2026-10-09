import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { Platform } from '../providers/platformAccounts.js';
import { platformForGame } from './platforms.js';

/**
 * Linked game accounts (migration 048). Signing in to Steam or Riot proves the seller controls
 * that account now; attached to an account listing it shows buyers a verified badge (the
 * platform and the account's age, never its name). A platform account can be linked to one
 * Bullizard user at a time: a second user trying to link it is refused and flagged for review,
 * which catches the same account being sold twice or listed by someone who doesn't hold it.
 */
const STATE_MINUTES = 10;
const COLS = 'id, provider, display_name, profile_url, account_created_at, linked_at';

export const callbackUrl = (ctx: Ctx, p: Platform) => `${ctx.apiBaseUrl}/v1/linked-accounts/${p}/callback`;

export async function listLinked(q: Queryable, userId: string) {
  return many(q, `SELECT ${COLS} FROM linked_accounts WHERE user_id = $1 AND unlinked_at IS NULL ORDER BY linked_at DESC`, [userId]);
}

export async function startLink(ctx: Ctx, userId: string, p: Platform, opts: { mockAccount?: string } = {}) {
  if (!ctx.platformAccounts.enabled(p)) throw badRequest('platform_unavailable', `Linking ${p === 'steam' ? 'Steam' : 'Riot'} accounts isn’t available yet`);
  const nonce = randomBytes(24).toString('hex');
  await ctx.db.query(`DELETE FROM link_states WHERE expires_at < now()`);
  await ctx.db.query(`INSERT INTO link_states (nonce, user_id, provider, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [nonce, userId, p, STATE_MINUTES]);
  return { url: ctx.platformAccounts.authorizeUrl(p, nonce, callbackUrl(ctx, p), ctx.platformAccounts.name === 'mock' ? opts : {}) };
}

/** The browser's return trip from the platform. The state is single-use and names the user. */
export async function completeLink(ctx: Ctx, p: Platform, query: Record<string, string>) {
  const st = await maybeOne<{ user_id: string }>(ctx.db, `DELETE FROM link_states WHERE nonce = $1 AND provider = $2 AND expires_at > now() RETURNING user_id`, [query.state ?? '', p]);
  if (!st) throw badRequest('link_expired', 'This sign-in link has expired; start again from your seller hub');
  let who;
  try {
    who = await ctx.platformAccounts.complete(p, query, callbackUrl(ctx, p));
  } catch (err) {
    ctx.log.warn({ err, provider: p }, 'platform sign-in not verified');
    throw badRequest('link_failed', (err as Error).message);
  }
  const holder = await maybeOne<{ id: string; user_id: string }>(ctx.db, `SELECT id, user_id FROM linked_accounts WHERE provider = $1 AND external_id = $2 AND unlinked_at IS NULL`, [p, who.externalId]);
  if (holder && holder.user_id !== st.user_id) {
    // Someone else holds it on Bullizard: refuse, and let the fraud team look at both sides.
    await ctx.db.query(`INSERT INTO risk_flags (user_id, score, reasons) VALUES ($1, 0.5, $2)`, [
      st.user_id,
      JSON.stringify([{ code: 'platform_account_linked_elsewhere', weight: 0.5, detail: { provider: p, holderUserId: holder.user_id } }]),
    ]);
    throw conflict('linked_elsewhere', 'This account is linked to another Bullizard user. If you bought it here, ask the seller to complete the order first.');
  }
  const account = holder
    ? await one(ctx.db, `UPDATE linked_accounts SET display_name = $2, profile_url = $3, account_created_at = COALESCE($4, account_created_at) WHERE id = $1 RETURNING ${COLS}`, [holder.id, who.displayName, who.profileUrl, who.accountCreatedAt])
    : await one(
        ctx.db,
        `INSERT INTO linked_accounts (user_id, provider, external_id, display_name, profile_url, account_created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
        [st.user_id, p, who.externalId, who.displayName, who.profileUrl, who.accountCreatedAt],
      );
  return { userId: st.user_id, account };
}

export async function unlink(ctx: Ctx, userId: string, id: string) {
  const res = await ctx.db.query(`UPDATE linked_accounts SET unlinked_at = now(), unlink_reason = 'user' WHERE id = $1 AND user_id = $2 AND unlinked_at IS NULL`, [id, userId]);
  if (!res.rowCount) throw notFound('Linked account');
  await ctx.db.query(`UPDATE offers SET linked_account_id = NULL WHERE linked_account_id = $1`, [id]);
}

/** Checks a listing may claim this linked account: the seller's own, live, and the game's platform. */
export async function checkAttach(q: Queryable, sellerId: string, linkedAccountId: string, game: string, categoryKind: string, exceptOfferId?: string) {
  if (categoryKind !== 'account') throw badRequest('invalid_linked_account', 'Only account listings can show a linked game account');
  const la = await maybeOne<{ provider: Platform }>(q, `SELECT provider FROM linked_accounts WHERE id = $1 AND user_id = $2 AND unlinked_at IS NULL`, [linkedAccountId, sellerId]);
  if (!la) throw badRequest('invalid_linked_account', 'Link the account from your seller hub first');
  const want = platformForGame(game);
  if (want !== la.provider) throw badRequest('invalid_linked_account', want ? `${game} accounts are verified with ${want === 'steam' ? 'Steam' : 'Riot'}` : `${game} accounts can’t be verified by sign-in yet`);
  const taken = await maybeOne(q, `SELECT 1 FROM offers WHERE linked_account_id = $1 AND status IN ('active', 'paused', 'review') AND id IS DISTINCT FROM $2`, [linkedAccountId, exceptOfferId ?? null]);
  if (taken) throw conflict('linked_account_in_use', 'Another of your listings already shows this account');
}

