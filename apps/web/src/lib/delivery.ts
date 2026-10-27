import { Envelope, Handshake, IdentificationCard, Storefront, type Icon } from '@phosphor-icons/react';
import { handoverFieldFor } from '../../../api/src/domain/attributeSets';
import { intlLocale, t } from '../i18n';

/**
 * Delivery methods: a fixed list per game. The seller ticks the ones they offer on each listing;
 * the buyer picks one at checkout and gives only what that method needs.
 * (Front-end copy of the list; the API keeps the same table — see the back-end brief, Round 24.)
 */
export type MethodKey = 'f2f' | 'mail' | 'market' | 'uid';
export type FieldKey = 'character' | 'city' | 'uid';
export interface DeliveryField { key: FieldKey; options?: readonly string[] }

const ALBION_CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'] as const;

export const METHODS: Record<MethodKey, { icon: Icon; fields: DeliveryField[] }> = {
  f2f: { icon: Handshake, fields: [{ key: 'character' }] },
  mail: { icon: Envelope, fields: [{ key: 'character' }] },
  market: { icon: Storefront, fields: [{ key: 'character' }, { key: 'city', options: ALBION_CITIES }] },
  uid: { icon: IdentificationCard, fields: [{ key: 'uid' }] },
};

const GAME_METHODS: Record<string, MethodKey[]> = {
  'albion online': ['f2f', 'market'],
  'path of exile': ['f2f'],
  'path of exile 2': ['f2f'],
  aion: ['f2f', 'mail'],
  'aion 2': ['f2f', 'mail'],
};

/** Methods a game allows (empty: the game needs no in-game handover). */
export const methodsForGame = (game: string): MethodKey[] => GAME_METHODS[game.trim().toLowerCase()] ?? [];

/**
 * The methods this listing offers: what the seller ticked, else every method of the game. Other games
 * that deliver in-game get one method: face to face (character name) or top-up by UID.
 */
export function methodsOf(offer: { game: string; category_slug?: string; delivery_methods?: string[] | null }): MethodKey[] {
  const listed = methodsForGame(offer.game);
  const handover = offer.category_slug ? handoverFieldFor(offer.game, offer.category_slug) : null;
  const all: MethodKey[] = listed.length ? listed : handover ? [handover.key === 'uid' ? 'uid' : 'f2f'] : [];
  const picked = (offer.delivery_methods ?? []).filter((m): m is MethodKey => (all as string[]).includes(m));
  return picked.length ? picked : all;
}

export const methodLabel = (m: MethodKey) => t(`dm.${m}`);
export const fieldLabel = (f: FieldKey) => t(`df.${f}`);

/** 5100 → "5.1k", 1200000 → "1.2M" (locale-aware). */
export const compact = (n: number) => {
  const out = new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return intlLocale().startsWith('en') ? out.replace(/K$/, 'k') : out;
};

/** Seller level from completed orders: 1 + ⌊2·√orders⌋ (1 order → 3, 100 → 21, 3,000 → 110). */
export const levelFromOrders = (completed: number) => 1 + Math.floor(2 * Math.sqrt(Math.max(0, completed)));
