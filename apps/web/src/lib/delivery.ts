import { Envelope, Handshake, IdentificationCard, Storefront, type Icon } from '@phosphor-icons/react';
import { handoverFieldFor } from '../../../api/src/domain/attributeSets';
import {
  DELIVERY_METHODS,
  allowedMethods,
  levelFromOrders as levelOf,
  methodsForGame as gameMethods,
  offeredMethods,
  type DeliveryFieldDef,
  type DeliveryFieldKey,
  type DeliveryMethod,
} from '../../../api/src/domain/delivery';
import { intlLocale, t } from '../i18n';

/**
 * Delivery methods: a fixed list per game. The seller ticks the ones they offer on each listing;
 * the buyer picks one at checkout and gives only what that method needs.
 * One source of truth: the table lives in apps/api/src/domain/delivery.ts (the API checks orders against it);
 * this file adds the icons and labels.
 */
export type MethodKey = DeliveryMethod;
export type FieldKey = DeliveryFieldKey;
export type DeliveryField = DeliveryFieldDef;

const ICONS: Record<MethodKey, Icon> = { f2f: Handshake, mail: Envelope, market: Storefront, uid: IdentificationCard };

export const METHODS: Record<MethodKey, { icon: Icon; fields: readonly DeliveryField[] }> = Object.fromEntries(
  (Object.keys(DELIVERY_METHODS) as MethodKey[]).map((m) => [m, { icon: ICONS[m], fields: DELIVERY_METHODS[m].fields }]),
) as Record<MethodKey, { icon: Icon; fields: readonly DeliveryField[] }>;

/** Methods a game lists of its own (empty: none). */
export const methodsForGame = (game: string): MethodKey[] => gameMethods(game);

/** Every method a new listing of this game and category may offer (empty: not delivered in-game). */
export const methodsForListing = (game: string, categorySlug: string): MethodKey[] => allowedMethods(game, handoverFieldFor(game, categorySlug)?.key ?? null);

/**
 * The methods this listing offers: what the seller ticked, else every method of the game. Other games
 * that deliver in-game get one method: face to face (character name) or top-up by UID.
 */
export function methodsOf(offer: { game: string; category_slug?: string; delivery_methods?: string[] | null }): MethodKey[] {
  const handover = offer.category_slug ? handoverFieldFor(offer.game, offer.category_slug) : null;
  return offeredMethods(offer.game, handover?.key ?? null, offer.delivery_methods);
}

export const methodLabel = (m: MethodKey) => t(`dm.${m}`);
export const fieldLabel = (f: FieldKey) => t(`df.${f}`);

/** 5100 → "5.1k", 1200000 → "1.2M" (locale-aware). */
export const compact = (n: number) => {
  const out = new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return intlLocale().startsWith('en') ? out.replace(/K$/, 'k') : out;
};

/** Seller level from completed orders: 1 + ⌊2·√orders⌋ (1 order → 3, 100 → 21, 3,000 → 110). */
export const levelFromOrders = levelOf;
