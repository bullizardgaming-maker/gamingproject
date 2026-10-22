import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { LEAGUES, PERMANENT_LEAGUES, setLeagues } from './attributeSets.js';
import { notify } from './notifications.js';

/**
 * Challenge leagues (Path of Exile 1 & 2). Staff open a league when it is announced and close it
 * when it ends. An open league is a choice on the sell form at once; once it has ended, listings
 * in it belonging to sellers who have gone quiet expire, so a new league starts with a live board.
 */
export const LEAGUE_GAMES = ['path of exile', 'path of exile 2'] as const;
/** A seller counts as inactive after this long without a sign-in once the league has ended. */
export const INACTIVE_SELLER_DAYS = 14;

export interface League {
  id: string;
  game: string;
  name: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listLeagues(q: Queryable): Promise<League[]> {
  return many<League>(q, 'SELECT id, game, name, starts_at, ends_at, created_at, updated_at FROM game_leagues ORDER BY game, created_at');
}

/** Loads the open leagues into the attribute sets (called at boot and after every change). */
export async function loadLeagues(q: Queryable) {
  const rows = await many<{ game: string; name: string }>(q, 'SELECT game, name FROM game_leagues WHERE ends_at IS NULL OR ends_at > now() ORDER BY created_at');
  for (const game of LEAGUE_GAMES) setLeagues(game, rows.filter((r) => r.game === game).map((r) => r.name));
  return LEAGUES;
}

export async function createLeague(ctx: Ctx, staffId: string, input: { game: string; name: string; startsAt?: string | null; endsAt?: string | null }) {
  const game = input.game.trim().toLowerCase();
  if (!(LEAGUE_GAMES as readonly string[]).includes(game)) throw badRequest('invalid_game', `Leagues exist for ${LEAGUE_GAMES.join(' and ')}`);
  const name = input.name.trim();
  if ((PERMANENT_LEAGUES as readonly string[]).some((p) => p.toLowerCase() === name.toLowerCase())) throw badRequest('invalid_league', `${name} is a permanent league`);
  if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) throw badRequest('invalid_league', 'A league ends after it starts');
  const exists = await maybeOne(ctx.db, 'SELECT 1 FROM game_leagues WHERE game = $1 AND lower(name) = lower($2)', [game, name]);
  if (exists) throw conflict('league_exists', 'That league is already listed');
  const row = await one<League>(
    ctx.db,
    `INSERT INTO game_leagues (game, name, starts_at, ends_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, game, name, starts_at, ends_at, created_at, updated_at`,
    [game, name, input.startsAt ?? null, input.endsAt ?? null, staffId],
  );
  await loadLeagues(ctx.db);
  return row;
}

/** Sets or clears the end date; ending a league (now or at a date) is what triggers expiry. */
export async function updateLeague(ctx: Ctx, id: string, patch: { endsAt?: string | null; startsAt?: string | null }) {
  const row = await maybeOne<League>(
    ctx.db,
    `UPDATE game_leagues SET ends_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE ends_at END,
                             starts_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE starts_at END, updated_at = now()
      WHERE id = $1 RETURNING id, game, name, starts_at, ends_at, created_at, updated_at`,
    [id, patch.endsAt !== undefined, patch.endsAt ?? null, patch.startsAt !== undefined, patch.startsAt ?? null],
  );
  if (!row) throw notFound('League');
  await loadLeagues(ctx.db);
  return row;
}

/**
 * Worker: once a league has ended, expire its listings for sellers not seen for INACTIVE_SELLER_DAYS.
 * Active sellers keep theirs (they may move stock to Standard or relist), and are told the league
 * is over. Runs every call; each listing is handled once because its status changes.
 */
export async function expireEndedLeagueListings(ctx: Ctx) {
  const ended = await many<{ game: string; name: string }>(ctx.db, 'SELECT game, name FROM game_leagues WHERE ends_at IS NOT NULL AND ends_at <= now()');
  let expired = 0;
  for (const l of ended) {
    const rows = await many<{ id: string; seller_id: string; title: string }>(
      ctx.db,
      `UPDATE offers f SET status = 'expired', expired_reason = $3, version = version + 1, updated_at = now()
         FROM users u
        WHERE u.id = f.seller_id AND f.status = 'active' AND lower(f.game) = $1 AND f.attributes->>'league' = $2
          AND COALESCE(u.last_seen_at, u.created_at) < now() - make_interval(days => $4)
        RETURNING f.id, f.seller_id, f.title`,
      [l.game, l.name, `league_ended:${l.name}`, INACTIVE_SELLER_DAYS],
    );
    for (const r of rows) {
      await notify(ctx.db, r.seller_id, 'listing_expired_league', { offer_id: r.id, title: r.title, league: l.name, game: l.game }, `listing:${r.id}:league_expired`);
      expired++;
    }
  }
  return expired;
}

/** A seller brings an expired listing back by moving it to an open league. */
export async function relistExpired(ctx: Ctx, sellerId: string, offerId: string, league: string) {
  const cur = await maybeOne<{ game: string; attributes: Record<string, string> }>(ctx.db, `SELECT game, attributes FROM offers WHERE id = $1 AND seller_id = $2 AND status = 'expired'`, [offerId, sellerId]);
  if (!cur) throw notFound('Offer');
  const open = LEAGUES[cur.game.toLowerCase()] ?? [];
  const match = open.find((o) => o.toLowerCase() === league.trim().toLowerCase());
  if (!match) throw badRequest('invalid_league', `Pick an open league: ${open.join(', ')}`);
  await ctx.db.query(
    `UPDATE offers SET status = 'active', expired_reason = NULL, attributes = attributes || jsonb_build_object('league', $3::text), version = version + 1, updated_at = now() WHERE id = $1 AND seller_id = $2`,
    [offerId, sellerId, match],
  );
}
