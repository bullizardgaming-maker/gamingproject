/**
 * Game-specific listing fields (server, region, platform, rank…), the way G2G and FunPay split
 * each game's market. Kept free of imports so the web demo can serve the same definitions.
 *
 * A listing's fields come from the game's set for its category when there is one, otherwise from
 * the category default. Values are stored on offers.attributes as {key: value}.
 */
export interface AttributeDef {
  key: string;
  label: string;
  type: 'select' | 'text';
  options?: readonly string[];
  required?: boolean;
}

const REGIONS = ['Global', 'North America', 'Europe', 'UK', 'Latin America', 'Asia', 'Oceania', 'Middle East'] as const;
const PLATFORMS = ['PC', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Mobile'] as const;
const STORES = ['Steam', 'Epic Games', 'GOG', 'EA app', 'Ubisoft Connect', 'Rockstar', 'Battle.net', 'Xbox', 'PlayStation', 'Nintendo eShop'] as const;

const region = (options: readonly string[] = REGIONS, required = false): AttributeDef => ({ key: 'region', label: 'Region', type: 'select', options, required });
const platform = (options: readonly string[] = PLATFORMS, required = false): AttributeDef => ({ key: 'platform', label: 'Platform', type: 'select', options, required });
const rank = (key: string, label: string, options: readonly string[], required = false): AttributeDef => ({ key, label, type: 'select', options, required });

export const CATEGORY_DEFAULTS: Record<string, AttributeDef[]> = {
  accounts: [platform(), region()],
  currency: [platform(), region()],
  items: [platform()],
  keys: [platform(STORES), region()],
  boosting: [platform(), region()],
  'gift-cards': [region(['Global', 'United States', 'Europe', 'United Kingdom', 'Canada', 'Australia', 'Turkey', 'Saudi Arabia', 'UAE', 'Egypt', 'Brazil', 'India'])],
  'top-ups': [region()],
  'video-games': [platform(STORES), region()],
};

const LOL_SERVERS = ['EUW', 'EUNE', 'NA', 'KR', 'BR', 'LAN', 'LAS', 'OCE', 'TR', 'RU', 'JP', 'ME'] as const;
const LOL_RANKS = ['Unranked', 'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Master', 'Grandmaster', 'Challenger'] as const;
const VAL_REGIONS = ['Europe', 'North America', 'Asia Pacific', 'Korea', 'Latin America', 'Brazil'] as const;
const VAL_RANKS = ['Unranked', 'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant'] as const;
const APEX_RANKS = ['Rookie', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Predator'] as const;
const HOYO_SERVERS = ['America', 'Europe', 'Asia', 'TW/HK/MO'] as const;
const WEAR = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'] as const;
const WOW_REGIONS = ['US', 'EU'] as const;
const FACTIONS = ['Alliance', 'Horde'] as const;
const yesNo = ['Yes', 'No'] as const;

const hoyo = { server: { key: 'server', label: 'Server', type: 'select', options: HOYO_SERVERS, required: true } as AttributeDef };

/** Per game (lower-case name), per category. A category missing here falls back to the default. */
export const GAME_SETS: Record<string, Record<string, AttributeDef[]>> = {
  'league of legends': {
    accounts: [{ key: 'server', label: 'Server', type: 'select', options: LOL_SERVERS, required: true }, rank('rank', 'Rank', LOL_RANKS)],
    currency: [{ key: 'server', label: 'Server', type: 'select', options: LOL_SERVERS, required: true }],
    boosting: [
      { key: 'server', label: 'Server', type: 'select', options: LOL_SERVERS, required: true },
      rank('rank_from', 'Current rank', LOL_RANKS),
      rank('rank_to', 'Target rank', LOL_RANKS),
    ],
  },
  valorant: {
    accounts: [{ ...region(VAL_REGIONS, true) }, rank('rank', 'Rank', VAL_RANKS)],
    'top-ups': [{ ...region(VAL_REGIONS, true) }],
    boosting: [{ ...region(VAL_REGIONS, true) }, rank('rank_from', 'Current rank', VAL_RANKS), rank('rank_to', 'Target rank', VAL_RANKS)],
  },
  'world of warcraft': {
    currency: [
      { ...region(WOW_REGIONS, true) },
      { key: 'server', label: 'Realm', type: 'text', required: true },
      { key: 'faction', label: 'Faction', type: 'select', options: FACTIONS, required: true },
    ],
    accounts: [{ ...region(WOW_REGIONS, true) }, { key: 'faction', label: 'Faction', type: 'select', options: FACTIONS }],
    boosting: [{ ...region(WOW_REGIONS, true) }, { key: 'faction', label: 'Faction', type: 'select', options: FACTIONS }],
  },
  'counter-strike 2': {
    items: [{ key: 'exterior', label: 'Exterior', type: 'select', options: WEAR }, { key: 'stattrak', label: 'StatTrak™', type: 'select', options: yesNo }],
    accounts: [{ key: 'prime', label: 'Prime status', type: 'select', options: yesNo }, region()],
    boosting: [region()],
  },
  'genshin impact': { accounts: [hoyo.server], 'top-ups': [hoyo.server], boosting: [hoyo.server] },
  'honkai: star rail': { accounts: [hoyo.server], 'top-ups': [hoyo.server], boosting: [hoyo.server] },
  'apex legends': {
    accounts: [platform(PLATFORMS.slice(0, 4), true), rank('rank', 'Rank', APEX_RANKS)],
    boosting: [platform(PLATFORMS.slice(0, 4), true), rank('rank_from', 'Current rank', APEX_RANKS), rank('rank_to', 'Target rank', APEX_RANKS)],
  },
  'ea sports fc 25': {
    currency: [
      platform(['PlayStation', 'Xbox', 'PC'], true),
      { key: 'method', label: 'Transfer method', type: 'select', options: ['Comfort trade', 'Player auction'], required: true },
    ],
  },
  'diablo iv': {
    currency: [{ key: 'mode', label: 'Mode', type: 'select', options: ['Softcore', 'Hardcore'], required: true }, platform()],
    items: [{ key: 'mode', label: 'Mode', type: 'select', options: ['Softcore', 'Hardcore'], required: true }, platform()],
    boosting: [{ key: 'mode', label: 'Mode', type: 'select', options: ['Softcore', 'Hardcore'] }, platform()],
  },
  'path of exile 2': {
    currency: [{ key: 'league', label: 'League', type: 'select', options: ['Standard', 'Hardcore', 'Challenge', 'Challenge Hardcore'], required: true }],
    items: [{ key: 'league', label: 'League', type: 'select', options: ['Standard', 'Hardcore', 'Challenge', 'Challenge Hardcore'], required: true }],
  },
  'old school runescape': {
    currency: [{ key: 'method', label: 'Delivery method', type: 'select', options: ['Trade', 'Grand Exchange', 'Drop party'] }],
    accounts: [{ key: 'type', label: 'Account type', type: 'select', options: ['Main', 'Pure', 'Ironman', 'Hardcore Ironman', 'Skiller'] }],
  },
  fortnite: { accounts: [platform()], currency: [platform()] },
  'mobile legends': { 'top-ups': [region()] },
  'pubg mobile': { 'top-ups': [region()] },
};

export function attributesFor(game: string, category: string): AttributeDef[] {
  return GAME_SETS[game.trim().toLowerCase()]?.[category] ?? CATEGORY_DEFAULTS[category] ?? [];
}

export const ATTR_KEY = /^[a-z][a-z_]{0,29}$/;
export const ATTR_VALUE_MAX = 60;

/**
 * Validate and normalise a listing's fields against its game and category. Returns the cleaned
 * object, or a message describing the first problem. Select values are matched without case and
 * stored in their canonical spelling; empty values are dropped.
 */
/** `partial` skips required fields (buyer requests may leave a field open). */
export function cleanAttributes(game: string, category: string, input: Record<string, unknown> | undefined, opts: { partial?: boolean } = {}): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const defs = attributesFor(game, category);
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(input ?? {})) {
    const def = defs.find((d) => d.key === k);
    if (!def) return { ok: false, error: `“${k}” isn’t a field for ${game} ${category}` };
    if (raw == null || raw === '') continue;
    if (typeof raw !== 'string') return { ok: false, error: `${def.label} must be text` };
    const v = raw.trim();
    if (!v) continue;
    if (v.length > ATTR_VALUE_MAX) return { ok: false, error: `${def.label} is too long` };
    if (def.type === 'select') {
      const match = def.options!.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!match) return { ok: false, error: `${def.label} must be one of: ${def.options!.join(', ')}` };
      out[k] = match;
    } else out[k] = v;
  }
  const missing = !opts.partial && defs.find((d) => d.required && !out[d.key]);
  if (missing) return { ok: false, error: `${missing.label} is required for ${game} listings` };
  return { ok: true, value: out };
}
