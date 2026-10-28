import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { addInventory, parseBulkUpload } from './inventory.js';
import { getRate } from './fx.js';
import { GAME_SETS, attributesFor, cleanAttributes, handoverFieldFor } from './attributeSets.js';
import { cleanDeliveryMethods } from './delivery.js';
import { checkTiers, type PriceTier } from './priceTiers.js';
import { DELIVERY_TIMES, centsForMicros, checkVolumeDiscounts, type DeliveryTime, type VolumeDiscount } from './unitPrice.js';
import { allowedMethods } from './delivery.js';
import { listingStatusFor } from './moderation.js';
import { notify } from './notifications.js';
import { ONLINE_SQL } from './presence.js';
import { EFFECTIVE_MICROS_SQL, EFFECTIVE_PRICE_SQL } from './discounts.js';
import { checkAttach } from './linkedAccounts.js';
import { GROSS_SQL, markSellerSince } from './commission.js';
export { unitPriceFor, type PriceTier } from './priceTiers.js';

export interface OfferInput {
  categorySlug: string;
  game: string;
  title: string;
  description?: string;
  /** Required except for currency listings (unitPriceMicros). */
  priceCents?: number;
  currency?: string;
  deliveryMode: 'auto' | 'manual';
  stock?: number;
  lowStockThreshold?: number;
  deliveryHours?: number;
  /** Account listings only: warranty after release, in days (0, 7, 14, 30, 60 or 90). */
  warrantyDays?: number;
  /** Account listings: a Steam/Riot account the seller linked by signing in (linkedAccounts.ts); null detaches. */
  linkedAccountId?: string | null;
  /** Game-specific fields (server, region, rank…); see attributeSets.ts. */
  attributes?: Record<string, string>;
  /** Cheaper unit prices for larger orders. */
  priceTiers?: PriceTier[];
  /** A bundle of the seller's own instant-delivery listings sold together at this price. */
  bundle?: Array<{ offerId: string; quantity: number }>;
  /** Currency sold by amount: what one unit of `quantity` is ("M" of silver, `unitSize` 1,000,000) and the smallest order, in units. */
  unitLabel?: string | null;
  unitSize?: number | null;
  minQty?: number;
  /** Round 24: the delivery methods this listing offers, from the game's fixed list (domain/delivery.ts). Null/absent: all of them. */
  deliveryMethods?: string[] | null;
  /** Round 25, currency listings: the unit price in micro-units of the listing currency (123 = 0.000123 per unit). */
  unitPriceMicros?: number;
  /** Round 25, currency listings: up to four volume discounts (min quantity → % off). */
  volumeDiscounts?: VolumeDiscount[];
  /** Round 25: the promised delivery time from the fixed list (15m … 24h); replaces deliveryHours. */
  deliveryTime?: DeliveryTime;
}

/** Round 24: a 400 unless the methods are a non-empty subset of what this game and category allow. */
export function checkDeliveryMethods(game: string, categorySlug: string, input: string[] | null | undefined) {
  const r = cleanDeliveryMethods(game, handoverFieldFor(game, categorySlug)?.key ?? null, input);
  if (!r.ok) throw badRequest('invalid_delivery_method', r.error);
  return r.value;
}

export const MAX_BUNDLE_PARTS = 10;

/**
 * Currency sold by amount (Albion silver, kinah, orbs): the listing says what one unit of
 * `quantity` is and the smallest order. Other categories sell whole items: one unit, min 1.
 */
export function cleanUnit(input: Pick<OfferInput, 'unitLabel' | 'unitSize' | 'minQty'>, categoryKind: string, stock: number) {
  const label = input.unitLabel?.trim() || null;
  const size = input.unitSize ?? null;
  const minQty = input.minQty ?? 1;
  if ((label || size) && categoryKind !== 'currency') throw badRequest('invalid_unit', 'Only currency listings are sold by amount');
  if (label && label.length > 12) throw badRequest('invalid_unit', 'Keep the unit label short (e.g. "M", "k", "orbs")');
  if (size != null && !(Number.isInteger(size) && size >= 1)) throw badRequest('invalid_unit', 'unitSize is a whole number of game currency per unit');
  if (!Number.isInteger(minQty) || minQty < 1) throw badRequest('invalid_unit', 'minQty is at least 1');
  if (stock > 0 && minQty > stock) throw badRequest('invalid_unit', 'The minimum order can’t be more than the stock');
  return { label, size, minQty };
}

/** Check a bundle's parts: 2–10 of the seller's own active instant listings, none of them a bundle. */
async function checkBundle(q: Queryable, sellerId: string, parts: Array<{ offerId: string; quantity: number }>) {
  if (parts.length < 2 || parts.length > MAX_BUNDLE_PARTS) throw badRequest('invalid_bundle', `A bundle has 2 to ${MAX_BUNDLE_PARTS} listings`);
  if (new Set(parts.map((p) => p.offerId)).size !== parts.length) throw badRequest('invalid_bundle', 'Each listing can appear once in a bundle; set its quantity instead');
  const rows = await many<{ id: string; seller_id: string; delivery_mode: string; status: string; is_bundle: boolean; reserved_for: string | null }>(
    q,
    'SELECT id, seller_id, delivery_mode, status, is_bundle, reserved_for FROM offers WHERE id = ANY($1)',
    [parts.map((p) => p.offerId)],
  );
  for (const p of parts) {
    const r = rows.find((x) => x.id === p.offerId);
    if (!r || r.seller_id !== sellerId || r.status !== 'active' || r.reserved_for) throw badRequest('invalid_bundle', 'A bundle can only include your own active listings');
    if (r.delivery_mode !== 'auto' || r.is_bundle) throw badRequest('invalid_bundle', 'Bundles combine instant-delivery listings (not other bundles)');
  }
}

/** A bundle's parts as buyers see them: what's inside and what it would cost separately. */
export async function bundleParts(q: Queryable, offerId: string) {
  return many(
    q,
    `SELECT b.component_offer_id AS offer_id, b.quantity, f.title, f.game, f.currency, ${EFFECTIVE_PRICE_SQL} AS price_cents
       FROM bundle_items b JOIN offers f ON f.id = b.component_offer_id WHERE b.bundle_offer_id = $1 ORDER BY b.position`,
    [offerId],
  );
}

/** Validates tiers, as a 400 error. */
export function cleanTiers(basePriceCents: number, tiers: PriceTier[] | undefined, kind: string): PriceTier[] {
  const r = checkTiers(basePriceCents, tiers, kind);
  if (!r.ok) throw badRequest('invalid_tiers', r.error);
  return r.value;
}

/** Round 25: the listing's delivery time as its key on the fixed list (null for instant delivery, and above 24 hours: older non-currency listings). */
export const DELIVERY_TIME_SQL = `(CASE WHEN f.delivery_mode = 'auto' THEN NULL WHEN f.delivery_minutes <= 15 THEN '15m' WHEN f.delivery_minutes <= 60 THEN '1h' WHEN f.delivery_minutes <= 180 THEN '3h'
  WHEN f.delivery_minutes <= 360 THEN '6h' WHEN f.delivery_minutes <= 720 THEN '12h' WHEN f.delivery_minutes <= 1440 THEN '24h' END)`;

/**
 * Prices in this view are what the BUYER pays: the seller's price grossed up by the seller's
 * current commission rate (commission.ts). `seller_price_cents` is what the seller entered and
 * receives; sellers' own screens show that one.
 */
export const OFFER_LIST_SQL = `
  SELECT f.id, f.seller_id, f.category_slug, f.game, f.title, f.description, ${GROSS_SQL(EFFECTIVE_PRICE_SQL)} AS price_cents, ${GROSS_SQL('f.price_cents')} AS regular_price_cents,
         ${EFFECTIVE_PRICE_SQL} AS seller_price_cents, u.commission_rate_bps AS seller_rate_bps,
         CASE WHEN ${EFFECTIVE_PRICE_SQL} < f.price_cents THEN f.sale_ends_at END AS sale_ends_at, f.currency, ${GROSS_SQL('f.price_settlement_cents')} AS price_settlement_cents, f.delivery_mode,
         f.status, f.owner_proof_status, f.version, f.attributes,
         COALESCE((SELECT jsonb_agg(jsonb_set(t, '{priceCents}', to_jsonb(${GROSS_SQL("(t->>'priceCents')::numeric")})) ORDER BY (t->>'minQty')::int) FROM jsonb_array_elements(f.price_tiers) t), '[]'::jsonb) AS price_tiers,
         f.price_tiers AS seller_price_tiers, f.reserved_for, f.request_id, f.warranty_days, la.provider AS linked_platform, la.account_created_at AS linked_account_created_at, f.review_reasons, f.review_note, f.created_at, f.updated_at, f.low_stock_threshold,
         c.kind AS category_kind, c.risk_class, category_open(c.slug) AS category_open, u.display_name AS seller_name, f.delivery_hours,
         u.founding AS seller_founding, u.seller_rank, f.featured_until,
         (u.shop_paused AND (u.shop_paused_until IS NULL OR u.shop_paused_until > now())) AS shop_paused,
         u.shop_paused_until, u.shop_pause_message, ${ONLINE_SQL} AS seller_online, u.response_minutes AS seller_response_minutes, u.trust_level AS seller_trust_level,
         f.available AS stock, f.is_bundle,
         f.unit_label, f.unit_size, f.min_qty, ${GROSS_SQL(EFFECTIVE_PRICE_SQL)} AS price_per_unit_cents, f.available AS stock_qty,
         u.badges AS seller_badges, CASE WHEN u.show_online THEN u.last_seen_at END AS seller_last_seen_at,
         (c.kind = 'account' AND f.owner_proof_status <> 'verified') AS high_risk_secondary,
         u.completed_orders AS seller_completed_orders, u.rating_avg AS seller_rating, u.review_count AS seller_review_count,
         (1 + floor(2 * sqrt(GREATEST(u.completed_orders, 0))))::int AS seller_level,
         CASE WHEN u.review_count > 0 THEN round(100.0 * u.positive_review_count / u.review_count, 1)::float8 END AS seller_positive_pct,
         f.sold_count, f.public_id, f.delivery_methods,
         CASE WHEN f.unit_price_micros IS NOT NULL THEN ${GROSS_SQL(EFFECTIVE_MICROS_SQL)} END AS unit_price_micros,
         f.unit_price_micros AS seller_unit_price_micros, f.volume_discounts, ${GROSS_SQL('f.price_settlement_micros')} AS price_settlement_micros,
         f.delivery_minutes, ${DELIVERY_TIME_SQL} AS delivery_time
    FROM offers f JOIN categories c ON c.slug = f.category_slug JOIN users u ON u.id = f.seller_id
    LEFT JOIN linked_accounts la ON la.id = f.linked_account_id AND la.unlinked_at IS NULL`;

/**
 * Who may list and sell: Tier 1 (a verified email; no phone, Round 24) plus a passed rules test; identity verification
 * (Tier 2) is due within 30 days of the first listing (domain/onboarding.ts), after which selling
 * is restricted until it is done.
 */
/** Days an unverified seller may sell and withdraw after their first listing (rules_settings.id_due_days; 30 at launch). */
export const ID_DUE_DAYS_DEFAULT = 30;
/** The 30-day rule, computed inline from seller_since (not only from the worker's flag, Round 20). */
export const idDeadlinePassed = (user: { kyc_tier: number; seller_since?: string | null; selling_restricted_at?: string | null }, idDueDays = ID_DUE_DAYS_DEFAULT) =>
  user.kyc_tier < 2 && (!!user.selling_restricted_at || (!!user.seller_since && Date.now() - new Date(user.seller_since).getTime() > idDueDays * 86_400_000));

export function requireSeller(user: { kyc_tier: number; status: string; rules_passed_at?: string | null; selling_restricted_at?: string | null; listing_banned_at?: string | null; seller_since?: string | null }, idDueDays = ID_DUE_DAYS_DEFAULT) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  if (user.listing_banned_at) throw forbidden('listing_banned', 'Your account can’t list offers right now. Open an appeal from the help centre.');
  if (user.kyc_tier < 1) throw forbidden('tier1_required', 'Verify your email first.');
  if (!user.rules_passed_at) throw forbidden('rules_test_required', 'Pass the seller rules test before your first listing');
  if (idDeadlinePassed(user, idDueDays)) throw forbidden('kyc_overdue', 'Verify your identity to keep selling: the 30-day deadline has passed');
}

/** Round 25: the delivery time in minutes: one of the fixed list, or (older clients) a whole number of hours that is on it. */
export function deliveryMinutesFrom(input: { deliveryTime?: DeliveryTime; deliveryHours?: number }, required: boolean): number | null {
  if (input.deliveryTime) {
    if (!(input.deliveryTime in DELIVERY_TIMES)) throw badRequest('invalid_delivery_time', `Pick a delivery time: ${Object.keys(DELIVERY_TIMES).join(', ')}`);
    return DELIVERY_TIMES[input.deliveryTime];
  }
  if (input.deliveryHours != null) {
    const minutes = input.deliveryHours * 60;
    if (required && !Object.values(DELIVERY_TIMES).includes(minutes as never)) throw badRequest('invalid_delivery_time', `Pick a delivery time: ${Object.keys(DELIVERY_TIMES).join(', ')}`);
    return minutes;
  }
  if (required) throw badRequest('delivery_time_required', `Pick a delivery time: ${Object.keys(DELIVERY_TIMES).join(', ')}`);
  return null;
}

/** Round 25: a currency listing's unit price (micro-units) and volume discounts, checked. `priceCents` from older clients is a unit price of that many cents. */
export function currencyPricing(input: { unitPriceMicros?: number; priceCents?: number; volumeDiscounts?: VolumeDiscount[] }, minQty: number) {
  const micros = input.unitPriceMicros ?? (input.priceCents != null ? input.priceCents * 10_000 : undefined);
  if (micros == null) throw badRequest('unit_price_required', 'Give the price of one unit (up to 6 decimals)');
  if (!Number.isSafeInteger(micros) || micros < 1) throw badRequest('invalid_unit_price', 'The unit price is at least 0.000001');
  const vd = checkVolumeDiscounts(input.volumeDiscounts, minQty);
  if (!vd.ok) throw badRequest('invalid_volume_discounts', vd.error);
  return { micros, priceCents: centsForMicros(micros), discounts: vd.value };
}

/** Round 25: the field a currency buyer picks first (server, region or league): the game's first listing field, required. */
function requireServer(game: string, categorySlug: string, attrs: Record<string, string>) {
  // Only games with their own fields for the category (Albion's server, a PoE league, a WoW region…); a game on the
  // generic defaults has no server list to pick from.
  if (!GAME_SETS[game.trim().toLowerCase()]?.[categorySlug]) return;
  const def = attributesFor(game, categorySlug)[0];
  if (def && !attrs[def.key]) throw badRequest('server_required', `${def.label} is required for ${game} currency listings`, { field: def.key });
}

export async function createOffer(ctx: Ctx, seller: { id: string; kyc_tier: number; status: string }, input: OfferInput) {
  requireSeller(seller);
  // Loads (or refreshes) the listing currency's rate so the settlement price used by search is right.
  await getRate(ctx, ctx.db, (input.currency ?? ctx.cfg.SETTLEMENT_CURRENCY).toUpperCase());
  const cat = await maybeOne(ctx.db, 'SELECT *, category_open(slug) AS open FROM categories WHERE slug = $1', [input.categorySlug]);
  if (!cat) throw badRequest('unknown_category', 'Unknown category');
  if (!cat.open) throw badRequest('category_not_open', `${cat.name} opens in a later launch phase`);
  if (!(await one<{ ok: boolean }>(ctx.db, 'SELECT game_allowed($1) AS ok', [input.game])).ok) {
    throw badRequest('game_not_open', `${input.game} isn’t on Bullizard yet; suggest it on the game vote`);
  }
  if (cat.kind === 'account' && input.deliveryMode === 'auto' && (input.stock ?? 0) > 0) {
    throw badRequest('invalid_stock', 'Account listings with auto-delivery take stock from uploaded inventory');
  }
  if (input.warrantyDays && cat.kind !== 'account') throw badRequest('invalid_warranty', 'Only account listings can carry a warranty');
  if (input.linkedAccountId) await checkAttach(ctx.db, seller.id, input.linkedAccountId, input.game, cat.kind);
  if (input.bundle) {
    if (cat.kind === 'account') throw badRequest('invalid_bundle', 'Accounts are sold one at a time and can’t be bundled');
    if (input.deliveryMode !== 'auto') throw badRequest('invalid_bundle', 'A bundle is delivered instantly from its parts’ stock');
    await checkBundle(ctx.db, seller.id, input.bundle);
  }
  const attrs = cleanAttributes(input.game, input.categorySlug, input.attributes);
  if (!attrs.ok) throw badRequest('invalid_attributes', attrs.error);
  const currency = cat.kind === 'currency';
  // Round 25 (B3): a currency listing in the Round 25 form (a unit price in micro-units) must give game, server/region,
  // stock, delivery methods and a delivery time. An older client's body (priceCents only) keeps working with the old
  // defaults (24 hours, every method of the game).
  const strict = currency && input.unitPriceMicros != null;
  if (currency) {
    if (strict) requireServer(input.game, input.categorySlug, attrs.value);
    if (strict && input.deliveryMode === 'manual' && !(input.stock && input.stock > 0)) throw badRequest('stock_required', 'Give the amount you have in stock');
    if (strict && input.priceTiers?.length) throw badRequest('invalid_tiers', 'Currency listings use volume discounts (volumeDiscounts) instead of quantity prices');
  } else if (input.unitPriceMicros != null || input.volumeDiscounts?.length) {
    throw badRequest('invalid_unit', 'Only currency listings have a unit price in micro-units and volume discounts');
  }
  const stock = input.deliveryMode === 'manual' ? (cat.kind === 'account' ? 1 : input.stock ?? 1) : 0;
  const unit = cleanUnit(input, cat.kind, stock);
  const pricing = currency ? currencyPricing(input, unit.minQty) : null;
  if (!pricing && input.priceCents == null) throw badRequest('validation_error', 'priceCents is required');
  const priceCents = pricing ? pricing.priceCents : input.priceCents!;
  const tiers = cleanTiers(priceCents, input.priceTiers, cat.kind);
  const minutes = deliveryMinutesFrom(input, strict && input.deliveryMode === 'manual') ?? 1440;
  const handover = handoverFieldFor(input.game, input.categorySlug)?.key ?? null;
  // Round 25: in-game listings store the methods they offer (all of the game's when none are given); currency listings must pick.
  if (strict && allowedMethods(input.game, handover).length && !input.deliveryMethods?.length) {
    throw badRequest('invalid_delivery_method', `Pick at least one delivery method: ${allowedMethods(input.game, handover).join(', ')}`);
  }
  const deliveryMethods = checkDeliveryMethods(input.game, input.categorySlug, input.deliveryMethods) ?? (allowedMethods(input.game, handover).length ? allowedMethods(input.game, handover) : null);
  const screen = await listingStatusFor(ctx.db, input.title, input.description ?? '');
  const offer = await one(
    ctx.db,
    `INSERT INTO offers (seller_id, category_slug, game, title, description, price_cents, currency, delivery_mode, stock, low_stock_threshold, delivery_hours, attributes, price_tiers,
                         status, review_reasons, unit_label, unit_size, min_qty, delivery_methods, unit_price_micros, volume_discounts, delivery_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
    [seller.id, input.categorySlug, input.game, input.title, input.description ?? '', priceCents, (input.currency ?? ctx.cfg.SETTLEMENT_CURRENCY).toUpperCase(),
     input.deliveryMode, stock, input.lowStockThreshold ?? 5, Math.max(1, Math.ceil(minutes / 60)), JSON.stringify(attrs.value), JSON.stringify(tiers),
     screen.review ? 'review' : 'active', screen.reasons, unit.label, unit.size, unit.minQty, deliveryMethods,
     pricing?.micros ?? null, JSON.stringify(pricing?.discounts ?? []), minutes],
  );
  if (input.bundle) {
    await ctx.db.query('UPDATE offers SET is_bundle = true WHERE id = $1', [offer.id]);
    for (const [i, p] of input.bundle.entries()) {
      await ctx.db.query('INSERT INTO bundle_items (bundle_offer_id, component_offer_id, quantity, position) VALUES ($1, $2, $3, $4)', [offer.id, p.offerId, p.quantity, i]);
    }
  }
  if (input.warrantyDays) await ctx.db.query('UPDATE offers SET warranty_days = $2 WHERE id = $1', [offer.id, input.warrantyDays]);
  if (input.linkedAccountId) await ctx.db.query('UPDATE offers SET linked_account_id = $2 WHERE id = $1', [offer.id, input.linkedAccountId]);
  await markSellerSince(ctx.db, seller.id); // first listing starts the launch-promo clock
  if (screen.review) await notify(ctx.db, seller.id, 'listing_review', { offer_id: offer.id, title: input.title }, `listing:${offer.id}:review:${Date.now()}`);
  return getOffer(ctx.db, offer.id);
}

export async function getOffer(q: Queryable, id: string) {
  const offer = await maybeOne(q, `${OFFER_LIST_SQL} WHERE f.id = $1`, [id]);
  if (!offer) throw notFound('Offer');
  if (offer.is_bundle) offer.bundle = await bundleParts(q, id);
  return offer;
}

export type OfferPatch = Partial<Pick<OfferInput, 'title' | 'description' | 'priceCents' | 'stock' | 'lowStockThreshold' | 'deliveryHours' | 'attributes' | 'priceTiers' | 'warrantyDays' | 'linkedAccountId' | 'unitLabel' | 'unitSize' | 'minQty' | 'deliveryMethods' | 'unitPriceMicros' | 'volumeDiscounts' | 'deliveryTime'>> & { status?: 'active' | 'paused' | 'removed' };

/**
 * Update an offer with optimistic concurrency. Clients send the version they
 * read; a concurrent edit (or a purchase that moved manual stock) bumps the
 * version and the stale update is rejected with 409.
 *
 * Round 25 (L3): every check runs first and every column is written by the one versioned UPDATE, so a 409 changes
 * nothing (delivery methods, units, linked account included).
 */
export async function updateOffer(ctx: Ctx, sellerId: string, offerId: string, version: number, patch: OfferPatch) {
  const cur = await maybeOne(
    ctx.db,
    `SELECT f.seller_id, f.game, f.category_slug, f.stock, f.unit_label, f.unit_size, f.min_qty, f.price_cents, f.unit_price_micros, f.volume_discounts,
            f.reserved_for, f.title, f.description, f.delivery_mode, c.kind
       FROM offers f JOIN categories c ON c.slug = f.category_slug WHERE f.id = $1`,
    [offerId],
  );
  if (!cur || cur.seller_id !== sellerId) throw notFound('Offer');
  const currency = cur.kind === 'currency';
  if (patch.priceCents != null || patch.attributes || patch.title || patch.stock != null || patch.priceTiers || patch.warrantyDays != null || patch.unitPriceMicros != null || patch.volumeDiscounts) {
    // The terms of an accepted buyer request are fixed; the seller can only pause or remove it.
    if (cur.reserved_for) throw conflict('reserved_offer', 'This listing was agreed with a buyer and its terms can’t be changed');
  }
  let unit: { label: string | null; size: number | null; minQty: number } | null = null;
  if (patch.unitLabel !== undefined || patch.unitSize !== undefined || patch.minQty !== undefined) {
    unit = cleanUnit(
      { unitLabel: patch.unitLabel === undefined ? cur.unit_label : patch.unitLabel, unitSize: patch.unitSize === undefined ? cur.unit_size : patch.unitSize, minQty: patch.minQty ?? cur.min_qty },
      cur.kind,
      patch.stock ?? Number(cur.stock),
    );
  }
  if (patch.linkedAccountId) await checkAttach(ctx.db, sellerId, patch.linkedAccountId, cur.game, cur.kind, offerId);
  if (patch.warrantyDays && cur.kind !== 'account') throw badRequest('invalid_warranty', 'Only account listings can carry a warranty');
  // Round 24: a list must be a non-empty subset of the game's methods. Round 25: null stores all of them.
  let methods: string[] | null | undefined;
  if (patch.deliveryMethods !== undefined) {
    const handover = handoverFieldFor(cur.game, cur.category_slug)?.key ?? null;
    methods = patch.deliveryMethods === null ? (allowedMethods(cur.game, handover).length ? allowedMethods(cur.game, handover) : null) : checkDeliveryMethods(cur.game, cur.category_slug, patch.deliveryMethods);
  }
  // Currency listings: unit price in micro-units (priceCents from older clients means that many cents) and volume discounts.
  let micros: number | null = null;
  let priceCents = patch.priceCents ?? null;
  let discounts: string | null = null;
  if (currency) {
    if (patch.priceTiers?.length && (patch.unitPriceMicros != null || patch.volumeDiscounts?.length || (cur.volume_discounts ?? []).length)) {
      throw badRequest('invalid_tiers', 'Currency listings use volume discounts (volumeDiscounts) instead of quantity prices');
    }
    if (patch.unitPriceMicros != null || patch.priceCents != null || patch.volumeDiscounts) {
      const p = currencyPricing(
        { unitPriceMicros: patch.unitPriceMicros ?? (patch.priceCents == null ? Number(cur.unit_price_micros ?? Number(cur.price_cents) * 10_000) : undefined), priceCents: patch.priceCents, volumeDiscounts: patch.volumeDiscounts ?? cur.volume_discounts },
        unit?.minQty ?? cur.min_qty,
      );
      micros = p.micros;
      priceCents = p.priceCents;
      discounts = JSON.stringify(p.discounts);
    }
  } else if (patch.unitPriceMicros != null || patch.volumeDiscounts?.length) {
    throw badRequest('invalid_unit', 'Only currency listings have a unit price in micro-units and volume discounts');
  }
  const minutes = patch.deliveryTime !== undefined || patch.deliveryHours !== undefined ? deliveryMinutesFrom(patch, currency) : null;
  let tiers: string | null = null;
  if (patch.priceTiers) tiers = JSON.stringify(cleanTiers(priceCents ?? Number(cur.price_cents), patch.priceTiers, cur.kind));
  // Edited text is screened again; a listing in review can only be removed until staff decide.
  let screen: { review: boolean; reasons: string[] } = { review: false, reasons: [] };
  if (patch.title != null || patch.description != null) screen = await listingStatusFor(ctx.db, patch.title ?? cur.title, patch.description ?? cur.description);
  let attributes: string | null = null;
  if (patch.attributes) {
    const attrs = cleanAttributes(cur.game, cur.category_slug, patch.attributes);
    if (!attrs.ok) throw badRequest('invalid_attributes', attrs.error);
    if (currency && patch.unitPriceMicros != null) requireServer(cur.game, cur.category_slug, attrs.value);
    attributes = JSON.stringify(attrs.value);
  }
  const res = await ctx.db.query(
    `UPDATE offers SET
        title = COALESCE($4, title), description = COALESCE($5, description), price_cents = COALESCE($6, price_cents),
        stock = CASE WHEN delivery_mode = 'manual' THEN COALESCE($7, stock) ELSE stock END,
        low_stock_threshold = COALESCE($8, low_stock_threshold),
        status = CASE WHEN $13::boolean THEN 'review' WHEN status = 'review' AND $9 IS DISTINCT FROM 'removed' THEN 'review' ELSE COALESCE($9, status) END,
        review_reasons = CASE WHEN $13::boolean THEN $14::text[] ELSE review_reasons END,
        delivery_hours = COALESCE($10, delivery_hours), attributes = COALESCE($11::jsonb, attributes), price_tiers = COALESCE($12::jsonb, price_tiers),
        warranty_days = COALESCE($15, warranty_days),
        unit_label = CASE WHEN $16::boolean THEN $17 ELSE unit_label END, unit_size = CASE WHEN $16::boolean THEN $18::bigint ELSE unit_size END,
        min_qty = CASE WHEN $16::boolean THEN $19::int ELSE min_qty END,
        linked_account_id = CASE WHEN $20::boolean THEN $21::uuid ELSE linked_account_id END,
        delivery_methods = CASE WHEN $22::boolean THEN $23::text[] ELSE delivery_methods END,
        unit_price_micros = COALESCE($24::bigint, unit_price_micros), volume_discounts = COALESCE($25::jsonb, volume_discounts),
        delivery_minutes = COALESCE($26::int, delivery_minutes),
        version = version + 1, updated_at = now()
      WHERE id = $1 AND seller_id = $2 AND version = $3 RETURNING id`,
    [offerId, sellerId, version, patch.title, patch.description, priceCents, patch.stock, patch.lowStockThreshold, patch.status,
     minutes != null ? Math.max(1, Math.ceil(minutes / 60)) : null, attributes, tiers, screen.review, screen.reasons, patch.warrantyDays ?? null,
     !!unit, unit?.label ?? null, unit?.size ?? null, unit?.minQty ?? null,
     patch.linkedAccountId !== undefined, patch.linkedAccountId ?? null,
     methods !== undefined, methods ?? null,
     micros, discounts, minutes],
  );
  if (res.rowCount === 0) {
    const now = await maybeOne(ctx.db, 'SELECT seller_id, version FROM offers WHERE id = $1', [offerId]);
    if (!now || now.seller_id !== sellerId) throw notFound('Offer');
    throw conflict('version_conflict', `Offer was modified concurrently (current version ${now.version})`);
  }
  if (screen.review) await notify(ctx.db, sellerId, 'listing_review', { offer_id: offerId, title: patch.title ?? '' }, `listing:${offerId}:review:${Date.now()}`);
  return getOffer(ctx.db, offerId);
}

export async function uploadInventory(ctx: Ctx, sellerId: string, offerId: string, format: 'txt' | 'json', content: string) {
  const offer = await maybeOne(ctx.db, 'SELECT seller_id, delivery_mode, is_bundle FROM offers WHERE id = $1', [offerId]);
  if (!offer || offer.seller_id !== sellerId) throw notFound('Offer');
  if (offer.delivery_mode !== 'auto') throw badRequest('not_auto_delivery', 'Inventory uploads are only for auto-delivery offers');
  if (offer.is_bundle) throw badRequest('bundle_inventory', 'A bundle uses its parts’ stock; add stock to those listings instead');
  const items = parseBulkUpload(format, content);
  return withTx(ctx.db, (tx) => addInventory(ctx, tx, sellerId, offerId, items));
}

// ---------------------------------------------------------------------------
// Original Owner Proof (account listings)
// ---------------------------------------------------------------------------
export async function submitOwnerProof(
  ctx: Ctx,
  sellerId: string,
  offerId: string,
  input: { registrationEmail: string; registrationDate: string; billingName?: string; evidence: Record<string, unknown> },
) {
  return withTx(ctx.db, async (tx) => {
    const offer = await maybeOne(tx, `SELECT f.seller_id, c.kind FROM offers f JOIN categories c ON c.slug = f.category_slug WHERE f.id = $1`, [offerId]);
    if (!offer || offer.seller_id !== sellerId) throw notFound('Offer');
    if (offer.kind !== 'account') throw badRequest('not_account', 'Owner proof applies to account listings only');
    // Legacy security answers etc. are sensitive: encrypt the evidence blob.
    const proof = await one(
      tx,
      `INSERT INTO owner_proofs (offer_id, seller_id, registration_email, registration_date, billing_name, evidence)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, status, created_at`,
      [offerId, sellerId, input.registrationEmail, input.registrationDate, input.billingName ?? null,
       JSON.stringify({ sealed: ctx.keyring.encrypt(JSON.stringify(input.evidence), `owner_proof:${offerId}`) })],
    );
    await tx.query(`UPDATE offers SET owner_proof_status = 'pending', version = version + 1 WHERE id = $1`, [offerId]);
    return proof;
  });
}

export async function reviewOwnerProof(ctx: Ctx, proofId: string, reviewerId: string, approve: boolean, note?: string) {
  return withTx(ctx.db, async (tx) => {
    const proof = await maybeOne(
      tx,
      `SELECT p.*, u.legal_name FROM owner_proofs p JOIN users u ON u.id = p.seller_id WHERE p.id = $1 FOR UPDATE OF p`,
      [proofId],
    );
    if (!proof) throw notFound('Owner proof');
    // Billing history must match the seller's eKYC identity.
    const nameMatches = !proof.billing_name || !proof.legal_name || proof.billing_name.trim().toLowerCase() === proof.legal_name.trim().toLowerCase();
    const status = approve && nameMatches ? 'verified' : 'rejected';
    await tx.query('UPDATE owner_proofs SET status = $2, reviewed_by = $3, review_note = $4 WHERE id = $1', [
      proofId, status, reviewerId, note ?? (nameMatches ? null : 'Billing name does not match verified identity'),
    ]);
    await tx.query('UPDATE offers SET owner_proof_status = $2, version = version + 1 WHERE id = $1', [proof.offer_id, status]);
    return { id: proofId, status };
  });
}
