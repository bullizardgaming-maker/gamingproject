import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';

/** Game suggestions: anyone signed in suggests or votes; staff mark what is planned or added. */
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const SUGGESTIONS_PER_DAY = 3;

export async function listSuggestions(q: Queryable, viewerId?: string, status?: string) {
  return many(
    q,
    `SELECT s.id, s.name, s.votes, s.status, s.staff_note, s.created_at,
            ${viewerId ? `EXISTS (SELECT 1 FROM game_votes v WHERE v.suggestion_id = s.id AND v.user_id = $1)` : 'false'} AS voted
       FROM game_suggestions s ${status ? `WHERE s.status = ${viewerId ? '$2' : '$1'}` : ''}
      ORDER BY CASE s.status WHEN 'planned' THEN 0 WHEN 'open' THEN 1 WHEN 'added' THEN 2 ELSE 3 END, s.votes DESC, s.created_at LIMIT 200`,
    [...(viewerId ? [viewerId] : []), ...(status ? [status] : [])],
  );
}

export async function suggestGame(ctx: Ctx, user: { id: string; status: string }, name: string) {
  if (user.status !== 'active') throw new AppError(403, 'suspended', 'Account suspended');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80) throw badRequest('invalid_name', 'Give the game’s name (2 to 80 characters)');
  const live = await maybeOne(ctx.db, `SELECT 1 FROM offers WHERE lower(game) = $1 AND status = 'active' LIMIT 1`, [clean.toLowerCase()]);
  if (live) throw badRequest('already_listed', `${clean} is already on the market`);
  const today = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM game_suggestions WHERE suggested_by = $1 AND created_at > now() - interval '1 day'`, [user.id]);
  if (today.n >= SUGGESTIONS_PER_DAY) throw new AppError(429, 'too_many_suggestions', 'You can suggest three games a day');
  const existing = await maybeOne<{ id: string }>(ctx.db, 'SELECT id FROM game_suggestions WHERE name_key = $1', [nameKey(clean)]);
  const id = existing?.id ?? (await one<{ id: string }>(ctx.db, 'INSERT INTO game_suggestions (name, name_key, suggested_by) VALUES ($1, $2, $3) RETURNING id', [clean, nameKey(clean), user.id])).id;
  await vote(ctx, user.id, id, true);
  return (await listSuggestions(ctx.db, user.id)).find((s: any) => s.id === id);
}

/** Toggle a vote; the counter is kept on the row so the board sorts cheaply. */
export async function vote(ctx: Ctx, userId: string, suggestionId: string, on: boolean) {
  const s = await maybeOne<{ status: string }>(ctx.db, 'SELECT status FROM game_suggestions WHERE id = $1', [suggestionId]);
  if (!s) throw notFound('Suggestion');
  if (on) {
    const r = await ctx.db.query('INSERT INTO game_votes (suggestion_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [suggestionId, userId]);
    if (r.rowCount) await ctx.db.query('UPDATE game_suggestions SET votes = votes + 1, updated_at = now() WHERE id = $1', [suggestionId]);
  } else {
    const r = await ctx.db.query('DELETE FROM game_votes WHERE suggestion_id = $1 AND user_id = $2', [suggestionId, userId]);
    if (r.rowCount) await ctx.db.query('UPDATE game_suggestions SET votes = greatest(votes - 1, 0), updated_at = now() WHERE id = $1', [suggestionId]);
  }
  return one(ctx.db, 'SELECT id, name, votes, status FROM game_suggestions WHERE id = $1', [suggestionId]);
}

export async function setSuggestionStatus(ctx: Ctx, id: string, status: 'open' | 'planned' | 'added' | 'declined', note = '') {
  const row = await maybeOne(ctx.db, 'UPDATE game_suggestions SET status = $2, staff_note = $3, updated_at = now() WHERE id = $1 RETURNING id, name, votes, status, staff_note', [id, status, note]);
  if (!row) throw notFound('Suggestion');
  return row;
}
