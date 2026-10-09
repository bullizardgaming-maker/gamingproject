/**
 * Game-specific listing fields. The definitions are the API's own module, bundled here so the
 * sell form and game-page filters render without a round trip and can't drift from validation.
 */
export { attributesFor, type AttributeDef } from '../../../api/src/domain/attributeSets';
import { attributesFor } from '../../../api/src/domain/attributeSets';

/** Short display pairs for a listing, in definition order: [["Server", "EUW"], ["Rank", "Gold → Platinum"]]. */
export function attributePairs(game: string, category: string, values: Record<string, string> | undefined): Array<[string, string]> {
  if (!values) return [];
  const defs = attributesFor(game, category);
  const out: Array<[string, string]> = [];
  for (const d of defs) {
    const v = values[d.key];
    if (!v) continue;
    // Boosting ranges read as one pair.
    if (d.key === 'rank_from' && values.rank_to) out.push(['Rank', `${v} → ${values.rank_to}`]);
    else if (d.key === 'rank_to' && values.rank_from) continue;
    else out.push([d.label, v]);
  }
  return out;
}
