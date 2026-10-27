/**
 * Round 24: delivery methods. A fixed list per game; the seller ticks the ones a listing offers, the buyer picks one
 * at checkout and gives only what that method needs. Kept free of imports: the web app (lib/delivery.ts, the demo
 * mock) uses this same table, so the list lives in one place.
 *
 * A listing has methods only when its game delivers in-game for its category (a "handover" field in
 * attributeSets.ts: a character name or a UID). Games with their own list use it; any other handover game gets one
 * method: face to face (character) or top-up by UID.
 */
export const DELIVERY_METHOD_KEYS = ['f2f', 'mail', 'market', 'uid'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHOD_KEYS)[number];
export type DeliveryFieldKey = 'character' | 'city' | 'uid';
export interface DeliveryFieldDef {
  key: DeliveryFieldKey;
  options?: readonly string[];
}

export const ALBION_CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'] as const;

/** What each method needs from the buyer. Every field is required. */
export const DELIVERY_METHODS: Record<DeliveryMethod, { fields: readonly DeliveryFieldDef[] }> = {
  f2f: { fields: [{ key: 'character' }] },
  mail: { fields: [{ key: 'character' }] },
  market: { fields: [{ key: 'character' }, { key: 'city', options: ALBION_CITIES }] },
  uid: { fields: [{ key: 'uid' }] },
};

/** Games with their own list (lower-case name). */
export const GAME_DELIVERY_METHODS: Record<string, readonly DeliveryMethod[]> = {
  'albion online': ['f2f', 'market'],
  'path of exile': ['f2f'],
  'path of exile 2': ['f2f'],
  aion: ['f2f', 'mail'],
  'aion 2': ['f2f', 'mail'],
};

export const MAX_DELIVERY_FIELD = 60;

/** The methods a game lists (empty: no list of its own). */
export const methodsForGame = (game: string): DeliveryMethod[] => [...(GAME_DELIVERY_METHODS[game.trim().toLowerCase()] ?? [])];

/**
 * Every method a listing of this game may offer. `handover` is the listing's handover field key for its category
 * (attributeSets.handoverFieldFor(game, category)?.key); null means the listing is not delivered in-game.
 */
export function allowedMethods(game: string, handover: 'character' | 'uid' | null | undefined): DeliveryMethod[] {
  if (!handover) return [];
  const listed = methodsForGame(game);
  if (listed.length) return listed;
  return [handover === 'uid' ? 'uid' : 'f2f'];
}

/** The methods this listing offers: what the seller ticked (null: all of the game's), in the game's order. */
export function offeredMethods(game: string, handover: 'character' | 'uid' | null | undefined, picked: readonly string[] | null | undefined): DeliveryMethod[] {
  const all = allowedMethods(game, handover);
  const chosen = all.filter((m) => (picked ?? []).includes(m));
  return chosen.length ? chosen : all;
}

export const isDeliveryMethod = (m: unknown): m is DeliveryMethod => typeof m === 'string' && (DELIVERY_METHOD_KEYS as readonly string[]).includes(m);

/**
 * A seller's choice for a listing. Undefined: not given (keep what is stored). An empty list or a method the game
 * doesn't have is refused; a listing without in-game delivery takes no methods (stored as null).
 */
export function cleanDeliveryMethods(
  game: string,
  handover: 'character' | 'uid' | null | undefined,
  input: readonly string[] | null | undefined,
): { ok: true; value: DeliveryMethod[] | null } | { ok: false; error: string } {
  if (input == null) return { ok: true, value: null };
  const all = allowedMethods(game, handover);
  if (!all.length) return { ok: true, value: null };
  const unknown = input.filter((m) => !(all as string[]).includes(m));
  if (unknown.length) return { ok: false, error: `${game} delivers by ${all.join(', ')}; ${unknown.join(', ')} isn’t one of them` };
  const picked = all.filter((m) => input.includes(m));
  if (!picked.length) return { ok: false, error: 'Pick at least one delivery method' };
  return { ok: true, value: picked };
}

export type DeliveryInfo = Partial<Record<DeliveryFieldKey, string>>;

/**
 * The buyer's choice at checkout. `method` defaults to the listing's first method; `legacyCharacter` (the older
 * `characterName` field) fills the character or UID when `info` doesn't. Only the method's own fields are kept.
 */
export function cleanDeliveryChoice(
  offered: readonly DeliveryMethod[],
  method: string | null | undefined,
  info: Record<string, unknown> | null | undefined,
  legacyCharacter?: string | null,
): { ok: true; method: DeliveryMethod; info: DeliveryInfo } | { ok: false; code: 'invalid_delivery_method' | 'delivery_info_required' | 'delivery_info_invalid'; error: string; field?: DeliveryFieldKey } {
  const m = method ?? offered[0];
  if (!m || !isDeliveryMethod(m) || !offered.includes(m)) {
    return { ok: false, code: 'invalid_delivery_method', error: `Pick one of the seller’s delivery methods (${offered.join(', ')})` };
  }
  const out: DeliveryInfo = {};
  for (const f of DELIVERY_METHODS[m].fields) {
    const raw = info?.[f.key] ?? (f.key === 'character' || f.key === 'uid' ? legacyCharacter : undefined);
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return { ok: false, code: 'delivery_info_required', error: `${FIELD_LABEL[f.key]} is required for this delivery method`, field: f.key };
    if (v.length > MAX_DELIVERY_FIELD) return { ok: false, code: 'delivery_info_invalid', error: `${FIELD_LABEL[f.key]} is at most ${MAX_DELIVERY_FIELD} characters`, field: f.key };
    if (f.options && !f.options.includes(v)) return { ok: false, code: 'delivery_info_invalid', error: `Pick a ${FIELD_LABEL[f.key].toLowerCase()} from the list: ${f.options.join(', ')}`, field: f.key };
    out[f.key] = v;
  }
  return { ok: true, method: m, info: out };
}

const FIELD_LABEL: Record<DeliveryFieldKey, string> = { character: 'Character name', city: 'City', uid: 'UID' };

/** Seller level from completed orders: 1 + ⌊2·√orders⌋ (1 order → 3, 100 → 21, 3,000 → 110). */
export const levelFromOrders = (completed: number) => 1 + Math.floor(2 * Math.sqrt(Math.max(0, completed)));
