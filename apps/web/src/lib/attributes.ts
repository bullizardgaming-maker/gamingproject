/**
 * Game-specific listing fields. The definitions are the API's own module, bundled here so the
 * sell form and game-page filters render without a round trip and can't drift from validation.
 */
export type { AttributeDef } from '../../../api/src/domain/attributeSets';
import { useEffect, useState } from 'react';
import { attributesFor as baseAttributesFor, cleanAttributes as baseCleanAttributes, LEAGUES, setLeagues, type AttributeDef } from '../../../api/src/domain/attributeSets';

/**
 * Round 26 (B5): Aion and Aion 2 have servers and factions, so their listings carry a required Faction
 * (Elyos / Asmodian) right after the server. Albion (servers only) and Path of Exile (leagues) don't. When the
 * API's own definitions add the field, theirs is used and nothing is added here.
 */
export const FACTION_GAMES = new Set(['aion', 'aion 2']);
export const FACTION: AttributeDef = { key: 'faction', label: 'Faction', type: 'select', options: ['Elyos', 'Asmodian'], required: true };
export function attributesFor(game: string, category: string): AttributeDef[] {
  const defs = baseAttributesFor(game, category);
  if (!FACTION_GAMES.has(game.trim().toLowerCase()) || defs.some((d) => d.key === 'faction')) return defs;
  const at = defs.findIndex((d) => d.key === 'server');
  if (at < 0) return defs;
  return [...defs.slice(0, at + 1), FACTION, ...defs.slice(at + 1)];
}
/** The API's attribute check, plus the faction above (used by the demo mock until the API has it). */
export function cleanAttributes(game: string, category: string, input: Record<string, unknown> | undefined, opts: { partial?: boolean } = {}) {
  const needs = attributesFor(game, category).some((d) => d === FACTION);
  if (!needs) return baseCleanAttributes(game, category, input, opts);
  const { faction, ...rest } = input ?? {};
  const r = baseCleanAttributes(game, category, rest, opts);
  if (!r.ok) return r;
  const v = typeof faction === 'string' ? FACTION.options!.find((o) => o.toLowerCase() === faction.trim().toLowerCase()) : undefined;
  if (faction != null && faction !== '' && !v) return { ok: false as const, error: `Faction must be one of: ${FACTION.options!.join(', ')}` };
  if (!v && !opts.partial) return { ok: false as const, error: `Faction is required for ${game} listings` };
  return { ok: true as const, value: v ? { ...r.value, faction: v } : r.value };
}
import { api } from '../api';
import { t, type MessageKey } from '../i18n';

/**
 * Challenge leagues (Path of Exile) are opened and closed by staff, so the bundled definitions are
 * refreshed from GET /leagues once per page load; the league field reads them live.
 */
let leaguesLoaded: Promise<void> | null = null;
export function loadLeagues() {
  leaguesLoaded ??= api<{ open: Record<string, string[]> }>('/leagues')
    .then((r) => {
      for (const [game, names] of Object.entries(r.open)) setLeagues(game, names.filter((n) => n !== 'Standard' && n !== 'Hardcore'));
    })
    .catch(() => {
      leaguesLoaded = null;
    });
  return leaguesLoaded;
}
/** The open leagues for a game (empty for games without leagues); re-renders once the table loads. */
export function useLeagues(game: string): string[] {
  const key = game.trim().toLowerCase();
  const [, bump] = useState(0);
  useEffect(() => {
    loadLeagues().then(() => bump((n) => n + 1));
  }, []);
  return LEAGUES[key] ?? [];
}

/** A field's label in the interface language (definitions are written in English). */
export const attrLabel = (label: string) => t(`attrLabel.${label}` as MessageKey);

/** Short display pairs for a listing, in definition order: [["Server", "EUW"], ["Rank", "Gold → Platinum"]]. */
export function attributePairs(game: string, category: string, values: Record<string, string> | undefined): Array<[string, string]> {
  if (!values) return [];
  const defs = attributesFor(game, category);
  const out: Array<[string, string]> = [];
  for (const d of defs) {
    const v = values[d.key];
    if (!v) continue;
    // Boosting ranges read as one pair.
    if (d.key === 'rank_from' && values.rank_to) out.push([attrLabel('Rank'), `${v} → ${values.rank_to}`]);
    else if (d.key === 'rank_to' && values.rank_from) continue;
    else out.push([attrLabel(d.label), v]);
  }
  return out;
}
