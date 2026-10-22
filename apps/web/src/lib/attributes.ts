/**
 * Game-specific listing fields. The definitions are the API's own module, bundled here so the
 * sell form and game-page filters render without a round trip and can't drift from validation.
 */
export { attributesFor, type AttributeDef } from '../../../api/src/domain/attributeSets';
import { useEffect, useState } from 'react';
import { attributesFor, LEAGUES, setLeagues } from '../../../api/src/domain/attributeSets';
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
