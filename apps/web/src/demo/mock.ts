/**
 * In-browser stand-in for the API, used when the app is built with VITE_DEMO=true (e.g. Vercel
 * previews, which have no backend). It implements the endpoints the web app calls with the same
 * request and response shapes, keeps state in localStorage, and simulates the parts that happen
 * elsewhere in production: the hosted card checkout, auto-delivery, the seller replying in chat,
 * and identity verification. Nothing here talks to a server.
 */
import { levelFromOrders, methodsOf } from '@/lib/delivery';
import { cleanDeliveryChoice, cleanDeliveryMethods } from '../../../api/src/domain/delivery';
import { CATEGORIES, DEMO_CODE, DEMO_FULL, seed, type DemoState, type DemoUser } from './seed';
import { CATEGORY_DEFAULTS, GAME_SETS, LEAGUES, PERMANENT_LEAGUES, handoverFieldFor, handoverKey, setLeagues } from '../../../api/src/domain/attributeSets';
import { attributesFor, cleanAttributes } from '@/lib/attributes';
import { checkTiers, effectivePrice, unitPriceFor } from '../../../api/src/domain/priceTiers';
import { classify, detectOffPlatform, matchTerms } from '../../../api/src/domain/safety';
import { parseCsv } from '../../../api/src/domain/csv';
import { platformForGame } from '../../../api/src/domain/platforms';
import { DELIVERY_TIMES, MIN_CURRENCY_ORDER_USD_CENTS, centsForMicros, checkVolumeDiscounts, deliveryTimeFor, formatUnitPrice, grossMicros, isDeliveryTime, parseUnitPrice, totalCentsFor, unitMicrosFor, volumePercentFor } from '../../../api/src/domain/unitPrice';
import { slugify } from '@/lib/catalog';
import { LAUNCH_GAMES, isLaunchGame } from '../lib/launch';

/** Which games sellers may list (staff-set; the launch games by default, every game in the full demo). */
const gameAllowed = (game: string) => {
  const list: string[] | null | undefined = state.launch.allowedGames;
  if (list === null) return true;
  if (list === undefined) return DEMO_FULL || isLaunchGame(game);
  return list.some((g) => g.toLowerCase() === game.trim().toLowerCase());
};

const KEY = DEMO_FULL ? 'bz.demo.v29' : 'bz.demo.launch.v5';
const day = 86_400_000;
const now = () => new Date().toISOString();
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));

let state: DemoState = load();

function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    // Keys added since the state was saved (e.g. controls) come from a fresh seed.
    if (raw) return { ...seed(), ...JSON.parse(raw) };
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return seed();
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}
export function resetDemo() {
  state = seed();
  save();
}

// ---------------------------------------------------------------------------
// Realtime bridge: the mock pushes frames (chat replies, order updates) to the app's socket layer.
// ---------------------------------------------------------------------------
type Frame = Record<string, unknown>;
let push: (frame: Frame) => void = () => {};
export function onDemoFrame(fn: (frame: Frame) => void) {
  push = fn;
}

let viewer: string | null = null; // the signed-in demo user, so only their notifications are pushed live
function notify(userId: string, category: string, template: string, title: string, body: string, link: string | null) {
  const item = { id: rid(), user_id: userId, template, category, title, body, link, read_at: null, created_at: now() };
  state.inbox.unshift(item);
  if (userId === viewer) setTimeout(() => push({ type: 'notification', event: 'inbox.new', data: item }), 0);
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string, details?: unknown): never => {
  throw new HttpError(status, code, message, details);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Seller ranks (staff-editable in the real API): the commission rate by 30-day sales. */
const RANKS = [
  { position: 1, name: 'Hatchling', minMonthlySalesCents: 0, rateBps: 1399, perks: [] as string[] },
  { position: 2, name: 'Scale', minMonthlySalesCents: 500_00, rateBps: 1299, perks: [] as string[] },
  { position: 3, name: 'Fang', minMonthlySalesCents: 2_000_00, rateBps: 1199, perks: [] as string[] },
  { position: 4, name: 'Basilisk', minMonthlySalesCents: 5_000_00, rateBps: 1099, perks: [] as string[] },
  { position: 5, name: 'Dragon', minMonthlySalesCents: 15_000_00, rateBps: 999, perks: [] as string[] },
];
const PROMO = { promoRateBps: 500, promoDays: 60 };
const asTier = (r: (typeof RANKS)[number]) => ({ ...r, accountRateBps: r.rateBps, otherRateBps: r.rateBps });

function tierOf(sellerId: string) {
  const sales = state.monthlySales[sellerId] ?? 0;
  let i = 0;
  RANKS.forEach((t, k) => sales >= t.minMonthlySalesCents && (i = k));
  const rank = RANKS[i]!;
  const next = RANKS[i + 1] ?? null;
  const since = userById(sellerId)?.seller_since;
  const promoEnds = since ? Date.parse(since) + PROMO.promoDays * day : null;
  const promo = !!promoEnds && promoEnds > Date.now();
  const rateBps = promo ? Math.min(PROMO.promoRateBps, rank.rateBps) : rank.rateBps;
  return { tier: asTier(rank), rank, rateBps, promo: promo ? { rateBps: PROMO.promoRateBps, endsAt: new Date(promoEnds!).toISOString() } : null, next: next ? { tier: asTier(next), rank: next, remainingCents: next.minMonthlySalesCents - sales } : null, sales };
}
/** Buyer price: the seller's price with their commission grossed up on top (ceil, so the seller never gets less). */
const grossUp = (cents: number, rateBps: number) => Math.ceil((cents * 10_000) / (10_000 - rateBps));
const gross = (sellerId: string, cents: number) => grossUp(cents, tierOf(sellerId).rateBps);
function rateFor(offer: any) {
  return tierOf(offer.seller_id).rateBps;
}

const userById = (id: string) => state.users.find((u) => u.id === id);
const publicUser = (u: DemoUser) => {
  const { password: _p, legal_name: _l, ...rest } = u;
  return rest;
};

/** Legal documents: interim English text, same version as migration 067's seed. */
export const TOS_VERSION = '2026-10-24';
const LEGAL_DOCS = ['terms', 'privacy', 'seller-agreement', 'refunds', 'restricted-countries'] as const;
const LEGAL_TITLES: Record<string, string> = { terms: 'Terms of Service', privacy: 'Privacy Policy', 'seller-agreement': 'Seller Agreement', refunds: 'Refund & Dispute Policy', 'restricted-countries': 'Restricted Countries' };
function legalDoc(doc: string) {
  if (!(LEGAL_DOCS as readonly string[]).includes(doc)) fail(400, 'validation_error', 'Unknown document');
  const content_md = LEGAL_BODIES[doc] ?? `# ${LEGAL_TITLES[doc]}\n\nInterim text. Legal's approved wording replaces it.`;
  return { doc, locale: 'en', version: TOS_VERSION, effective_at: '2026-10-24T00:00:00.000Z', title: LEGAL_TITLES[doc], content_md, sha256: hash('legal', content_md).padEnd(64, '0').slice(0, 64), material: false };
}
const LEGAL_BODIES: Record<string, string> = {
  terms: `# Terms of Service\n\n_Interim version. Bullizard is a marketplace where players buy and sell in-game goods from each other; we hold the payment until the buyer confirms delivery._\n\n1. **Who can use Bullizard.** You must be 18 or older and not in a restricted country.\n2. **Orders.** By buying you agree to these Terms. The character name you confirm at checkout is the one the seller delivers to.\n3. **Payment and release.** Payments stay in escrow until you confirm delivery, or until staff release them after a review (never before 24 hours).\n4. **Disputes.** Open a dispute from the order within the protection window; staff decide within 72 hours. Refunds go to your Bullizard balance.\n5. **Conduct.** Keep every message in the order chat. Sharing outside contacts or payment details can get your account banned.\n6. **Fees.** The buyer price includes the seller's rank commission. Withdrawals cost 6% (minimum $1.50).\n7. **Changes.** We announce material changes 14 days before they take effect.`,
  privacy: `# Privacy Policy\n\n_Interim version._\n\nWe keep your account details, orders, chat records and identity documents to run the marketplace, resolve disputes and meet legal duties. Chat records are kept for dispute evidence. You can ask for a copy or deletion of your data from your account settings.`,
  'seller-agreement': `# Seller Agreement\n\n_Interim version._\n\n1. Pass the rules test before your first listing; verify your identity within 30 days.\n2. Upload proof (photo or video) of every delivery before marking it delivered.\n3. Deliver only to the character name on the order.\n4. Your price is what you receive; the commission is added on top for the buyer.\n5. Off-platform contact, misdescribed items and bot-farmed currency lead to listing bans or account bans.`,
  refunds: `# Refund & Dispute Policy\n\n_Interim version._\n\nNo order is cancelled or refunded automatically. Open a dispute from the order; both sides have 48 hours for evidence and staff decide within 72 hours, with one appeal. Refunds (full or partial) land in your Bullizard balance; withdrawing them costs the standard fee.`,
  'restricted-countries': `# Restricted Countries\n\n_Interim version._\n\nBullizard is not available where sanctions or local law prohibit it. The list is kept current here and in the help centre.`,
};

function sellerStats(sellerId: string) {
  const reviews = state.reviews.filter((r) => r.seller_id === sellerId);
  const before = state.reviewsBefore[sellerId] ?? { count: 0, sum: 0 };
  const completed = (state.completedBefore[sellerId] ?? 0) + state.orders.filter((o) => o.seller_id === sellerId && o.status === 'completed').length;
  const count = before.count + reviews.length;
  const rating = count ? Math.round(((before.sum + reviews.reduce((s, r) => s + r.rating, 0)) / count) * 100) / 100 : null;
  return { completed, rating, count };
}

/** A demo seller shows online if seeded so, or if it's the account you're signed in as (and they show it). */
function presenceOf(id: string) {
  const p = state.presence[id];
  const shown = state.showOnline[id] ?? true;
  return { online: shown && (id === viewer || !!p?.online), last_seen_at: shown ? (id === viewer ? now() : p?.last_seen_at ?? null) : null, response_minutes: p?.response_minutes ?? null };
}
/** The (up to) two badges a seller chose to show; until they choose: their rank, then Founding Seller or their trust level. */
function badgesOf(id: string): string[] {
  const chosen = (state as any).sellerBadges?.[id] as string[] | undefined;
  if (chosen) return chosen.slice(0, 2);
  const u = userById(id);
  const earned = earnedBadgesOf(id).map((b) => b.key);
  return earned.slice(0, 2);
}
/** Same rule as the API: rank always; Founding Seller, ID verified (KYC tier 2) and Top seller when held. */
function earnedBadgesOf(id: string): Array<{ key: string; label: string }> {
  const u = userById(id);
  const rank = tierOf(id).rank.name;
  return [
    { key: `rank:${rank.toLowerCase()}`, label: rank },
    ...(u?.founding ? [{ key: 'founding', label: 'Founding Seller' }] : []),
    ...((u?.kyc_tier ?? 0) >= 2 ? [{ key: 'id_verified', label: 'ID verified' }] : []),
    ...(state.trust[id] === 'top' ? [{ key: 'top_seller', label: 'Top seller' }] : []),
  ];
}
/** Units buyable now: manual stock, instant inventory, or a bundle's complete sets (0 if a part isn't active). */
function availableOf(o: any): number {
  if (o.bundle?.length) {
    const parts = o.bundle.map((b: any) => ({ b, f: state.offers.find((x) => x.id === b.offer_id) }));
    if (parts.some((p: any) => !p.f || p.f.status !== 'active')) return 0;
    return Math.min(...parts.map((p: any) => Math.floor(p.f.inventory.length / p.b.quantity)));
  }
  return o.delivery_mode === 'auto' ? o.inventory.length : o.stock;
}
/** Public face of a linked account on a listing: platform and age only, never the name. */
function linkedView(o: any) {
  const la = o.linked_account_id ? state.linkedAccounts.find((a) => a.id === o.linked_account_id && !a.unlinked_at) : null;
  return { linked_platform: la?.provider ?? null, linked_account_created_at: la?.account_created_at ?? null };
}
function checkAttach(u: any, id: string, game: string, kind: string, exceptOfferId?: string) {
  if (kind !== 'account') fail(400, 'invalid_linked_account', 'Only account listings can show a linked game account');
  const la = state.linkedAccounts.find((a) => a.id === id && a.user_id === u.id && !a.unlinked_at) ?? fail(400, 'invalid_linked_account', 'Link the account from your seller hub first');
  const want = platformForGame(game);
  if (want !== la.provider) fail(400, 'invalid_linked_account', want ? `${game} accounts are verified with ${want === 'steam' ? 'Steam' : 'Riot'}` : `${game} accounts can’t be verified by sign-in yet`);
  if (state.offers.some((f) => f.linked_account_id === id && f.id !== exceptOfferId && ['active', 'paused', 'review'].includes(f.status))) fail(409, 'linked_account_in_use', 'Another of your listings already shows this account');
}
const linkedOf = (userId: string) => state.linkedAccounts.filter((a) => a.user_id === userId && !a.unlinked_at).map(({ user_id: _u, unlinked_at: _x, ...a }) => a).sort((a, b) => b.linked_at.localeCompare(a.linked_at));

function offerView(o: any) {
  const s = sellerStats(o.seller_id);
  const pr = presenceOf(o.seller_id);
  const price = effectivePrice(o);
  const rate = tierOf(o.seller_id).rateBps;
  return {
    ...o,
    price_cents: grossUp(price, rate),
    regular_price_cents: grossUp(o.price_cents, rate),
    seller_price_cents: price,
    seller_rate_bps: rate,
    price_tiers: (o.price_tiers ?? []).map((t: any) => ({ ...t, priceCents: grossUp(t.priceCents, rate) })),
    seller_price_tiers: o.price_tiers ?? [],
    seller_founding: !!userById(o.seller_id)?.founding,
    seller_rank: tierOf(o.seller_id).rank.name,
    sale_ends_at: price < o.price_cents ? o.sale_ends_at : null,
    seller_online: pr.online,
    seller_last_seen_at: pr.last_seen_at,
    seller_badges: badgesOf(o.seller_id),
    seller_trust_level: state.trust[o.seller_id] ?? 'new',
    seller_response_minutes: pr.response_minutes,
    inventory: undefined,
    stock: availableOf(o),
    // API names for currency sold by amount (the app reads both).
    price_per_unit_cents: grossUp(price, rate),
    stock_qty: availableOf(o),
    unit_size: o.unit_size ?? null,
    min_qty: o.min_qty ?? 1,
    unit_label: o.unit_label ?? null,
    is_bundle: !!o.bundle?.length,
    bundle: o.bundle?.map((b: any) => {
      const f = state.offers.find((x) => x.id === b.offer_id);
      return { offer_id: b.offer_id, quantity: b.quantity, title: f?.title, game: f?.game, currency: f?.currency, price_cents: f ? gross(f.seller_id, effectivePrice(f)) : 0 };
    }),
    seller_name: userById(o.seller_id)?.display_name ?? 'Seller',
    high_risk_secondary: o.category_kind === 'account' && o.owner_proof_status !== 'verified',
    linked_account_id: undefined,
    ...linkedView(o),
    seller_completed_orders: s.completed,
    seller_rating: s.rating,
    seller_review_count: s.count,
    // Round 24: level from completed orders, positive share, sales on this listing, public ID, delivery methods.
    seller_level: levelFromOrders(s.completed),
    seller_positive_pct: s.count ? Math.round(((s.rating ?? 0) / 5) * 1000) / 10 : null,
    sold_count: soldBefore(o.id) + state.orders.filter((x) => x.offer_id === o.id && x.status === 'completed').length,
    public_id: `BZO${hash('', o.id).slice(0, 12).toUpperCase()}`,
    delivery_methods: o.delivery_methods ?? null,
    // Round 25: currency listings priced per unit in micro-units, volume discounts, delivery time from a fixed list.
    ...unitView(o, rate),
    // Featured is only shown on the seller's own shop (GET /offers?seller=); no listing gate on buyer reputation.
    featured: undefined,
    featured_until: undefined,
    min_buyer_reputation: undefined,
  };
}
/** Seller's unit price in micro-units for a currency listing (older listings: the per-unit cents × 10,000). */
const sellerMicrosOf = (o: any): number | null => (o.category_slug === 'currency' ? o.unit_price_micros ?? effectivePrice(o) * 10_000 : null);
const deliveryMinutesOf = (o: any): number => (o.delivery_mode === 'auto' ? 0 : o.delivery_minutes ?? Math.round(Number(o.delivery_hours ?? 24) * 60));
function unitView(o: any, rate: number) {
  const sm = sellerMicrosOf(o);
  const buyer = sm == null ? null : grossMicros(sm, rate);
  const dm = deliveryMinutesOf(o);
  return {
    unit_price_micros: buyer,
    seller_unit_price_micros: sm,
    price_settlement_micros: buyer,
    volume_discounts: o.category_slug === 'currency' ? o.volume_discounts ?? [] : [],
    delivery_minutes: dm,
    delivery_time: dm === 0 || dm > 1440 ? null : deliveryTimeFor(dm),
  };
}
/** What an order of `quantity` costs: currency listings by unit price (rounded up to the cent), others by tiers. */
function orderPrice(offer: any, quantity: number) {
  const sm = sellerMicrosOf(offer);
  if (sm == null) return { sellerCents: unitPriceFor({ price_cents: effectivePrice(offer), price_tiers: offer.price_tiers }, quantity) * quantity, unitMicros: null, listingUnitMicros: null, pct: 0 };
  const tiers = offer.volume_discounts ?? [];
  const unit = unitMicrosFor(sm, tiers, quantity);
  return { sellerCents: totalCentsFor(unit, quantity), unitMicros: grossMicros(unit, rateFor(offer)), listingUnitMicros: grossMicros(sm, rateFor(offer)), pct: volumePercentFor(tiers, quantity) };
}
/** Seeded sales per listing (stable per id), so demo listings show a sold count. */
function soldBefore(id: string) {
  return parseInt(hash('sold', id).slice(0, 6), 16) % 3_400 + 12;
}

function hash(prev: string, body: string) {
  let h = 2166136261;
  for (const c of prev + body) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

function appendMessage(roomId: string, senderId: string | null, kind: string, body: string, flags: string[] = [], ev?: { code: string; params?: Record<string, unknown> }) {
  const room = state.rooms.find((r) => r.id === roomId)!;
  const prev = state.messages.filter((m) => m.room_id === roomId).at(-1);
  const m = { id: rid(), room_id: roomId, seq: (prev?.seq ?? 0) + 1, sender_id: senderId, kind, body, flags, code: ev?.code ?? null, params: ev?.params ?? null, hash: hash(prev?.hash ?? '0', body), created_at: now() };
  state.messages.push(m);
  room.last_seq = m.seq;
  return m;
}
const live = (m: any) => setTimeout(() => push({ type: 'message', roomId: m.room_id, message: m }), 0);
const notifyOrder = (orderId: string) => setTimeout(() => push({ type: 'notification', event: 'order.updated', data: { orderId } }), 0);

/** The other side of a demo conversation answers after a moment, so the chat feels alive. */
function scheduleReply(roomId: string, fromId: string) {
  const replies = [
    'Thanks! I’m on it — you’ll see the update right here in the order chat.',
    'Got it. Everything stays on the platform so escrow protects us both.',
    'Sure thing. Let me know if anything isn’t working and I’ll sort it out.',
  ];
  setTimeout(() => {
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const m = appendMessage(roomId, fromId, 'text', replies[Math.floor(Math.random() * replies.length)]!);
    save();
    live(m);
  }, 1600);
}


const CHECKLIST = [
  ['password', 'Changed the account password'],
  ['email', 'Replaced the recovery email with mine'],
  ['phone', 'Removed the old phone number'],
  ['twofa', 'Set up my own two-factor login'],
  ['sessions', 'Signed out all other sessions'],
  ['security_q', 'Changed security questions / recovery codes'],
] as const;

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newOrderRef = () => 'order#' + Array.from({ length: 7 }, () => REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)]).join('');
/** The official order message (server-only kind): posted at creation and on each status change. */
function postOrderCard(o: any, status: string) {
  live(appendMessage(o.room_id, null, 'system_order', JSON.stringify({ order_id: o.id, ref: o.ref, title: o.offer_title, quantity: o.quantity, character_name: o.character_name ?? null, status })));
}
function transition(o: any, to: string, reason: string) {
  o.events.push({ from_status: o.status, to_status: to, reason, created_at: now() });
  o.status = to;
  postOrderCard(o, to);
}

function deliverOrder(o: any, payload?: string) {
  const offer = state.offers.find((f) => f.id === o.offer_id)!;
  if (offer.bundle?.length) o.items = offer.bundle.flatMap((b: any) => state.offers.find((x) => x.id === b.offer_id)!.inventory.splice(0, o.quantity * b.quantity));
  else if (offer.delivery_mode === 'auto') o.items = offer.inventory.splice(0, o.quantity);
  else if (payload) o.items = [payload];
  o.delivered_at = now();
  // Accounts keep the 14-day window; everything else is held until the buyer confirms (no deadline).
  o.protection_ends_at = o.protection === 'insurance_14d' ? new Date(Date.now() + 14 * day).toISOString() : null;
  // Handover check: a listing that showed a linked Steam/Riot account gets a step the buyer ticks by signing in.
  const la = offer.linked_account_id ? state.linkedAccounts.find((a) => a.id === offer.linked_account_id && !a.unlinked_at) : null;
  if (o.checklist && la) {
    o.checklist.handover_platform = la.provider;
    o.checklist.items.push({ key: 'account_linked', label: 'Sign in to the account from Bullizard to confirm it is yours now', done: false, auto: true });
  }
  transition(o, 'delivered', offer.delivery_mode === 'auto' ? 'auto_delivery' : 'manual_delivery');
  notify(o.buyer_id, 'orders', 'order.delivered', 'Your order was delivered', `${o.offer_title}: check it within your protection window.`, `/orders/${o.id}`);
  live(appendMessage(o.room_id, null, 'delivery', offer.delivery_mode === 'auto' ? 'Delivered automatically. Your codes are on this order page.' : 'The seller marked this order as delivered.', [], { code: 'delivered' }));
}

function releaseOrder(o: any, reason: string) {
  transition(o, 'completed', reason);
  o.completed_at = now();
  if (o.warranty_days) o.warranty_ends_at = new Date(Date.now() + o.warranty_days * day).toISOString();
  // A sold account leaves the seller: their link is released so the buyer can link it.
  const sold = state.offers.find((f) => f.id === o.offer_id);
  if (sold?.linked_account_id) {
    const la = state.linkedAccounts.find((a) => a.id === sold.linked_account_id);
    if (la) la.unlinked_at = now();
    sold.linked_account_id = null;
  }
  state.balances[o.seller_id] = (state.balances[o.seller_id] ?? 0) + o.seller_net_cents;
  state.monthlySales[o.seller_id] = (state.monthlySales[o.seller_id] ?? 0) + o.seller_net_cents;
  state.platform.escrow -= o.amount_cents;
  state.platform.treasury += o.amount_cents - o.seller_net_cents;
  // A creator's share of the commission, when the buyer came through their code.
  const aff = state.affiliateOf[o.buyer_id] ? state.affiliates.find((a) => a.id === state.affiliateOf[o.buyer_id] && a.status === 'active') : null;
  if (aff && !state.affiliateEarnings.some((e) => e.order_id === o.id)) {
    const earned = Math.floor(((o.amount_cents - o.seller_net_cents) * aff.rate_bps) / 10_000);
    if (earned > 0) {
      state.affiliateEarnings.push({ id: rid(), affiliate_id: aff.id, order_id: o.id, commission_cents: o.amount_cents - o.seller_net_cents, earned_cents: earned, currency: 'USD', created_at: now() });
      state.balances[aff.user_id] = (state.balances[aff.user_id] ?? 0) + earned;
      state.platform.treasury -= earned;
    }
  }
  notify(o.seller_id, 'selling', 'order.released', 'Payment released', `$${(o.seller_net_cents / 100).toFixed(2)} from “${o.offer_title}” was added to your balance.`, '/sell/money');
  live(appendMessage(o.room_id, null, 'system', 'Order completed. Funds released to the seller.', [], { code: reason === 'buyer_confirmed_early' ? 'confirmed_early' : 'completed', params: { reason } }));
}

/** Demo stand-in for the hosted card checkout: pays the order and runs what the PSP webhook triggers. */
export function payDemoOrder(orderId: string) {
  const o = state.orders.find((x) => x.id === orderId);
  if (!o || o.status !== 'awaiting_payment') return o;
  transition(o, 'paid', 'payment_captured');
  o.paid_at = now();
  if (o.credit_cents) state.credit[o.buyer_id] = Math.max(0, (state.credit[o.buyer_id] ?? 0) - o.credit_cents);
  state.platform.escrow += o.amount_cents;
  notify(o.seller_id, 'selling', 'order.paid', 'New order', `${o.offer_title}: the buyer has paid. Deliver from the order page.`, `/orders/${o.id}`);
  live(appendMessage(o.room_id, null, 'system', `Payment received${o.character_name ? ` — deliver to ${o.character_name}` : ''}. It stays in escrow until the buyer confirms delivery.`, [], { code: 'paid', params: { character: o.character_name ?? null } }));
  const offer = state.offers.find((f) => f.id === o.offer_id)!;
  if (offer.delivery_mode === 'auto') deliverOrder(o);
  else scheduleReply(o.room_id, o.seller_id);
  save();
  return o;
}

function orderSummary(o: any, as: 'buyer' | 'seller') {
  return {
    id: o.id, ref: o.ref, offer_id: o.offer_id, offer_title: o.offer_title, game: o.game, amount_cents: o.amount_cents, seller_net_cents: o.seller_net_cents, currency: o.currency, status: o.status, created_at: o.created_at,
    counterparty: userById(as === 'buyer' ? o.seller_id : o.buyer_id)?.display_name,
  };
}

const GOOD_BUYER_TAGS = ['clear_communication', 'quick_confirmation', 'patient'];
function buyerRepOf(buyerId: string) {
  const u = userById(buyerId);
  const mine = state.orders.filter((o) => o.buyer_id === buyerId);
  const ratings = state.buyerRatings.filter((r) => r.buyer_id === buyerId);
  const positive = ratings.filter((r) => r.positive).length;
  const negative = ratings.length - positive;
  const opened = mine.filter((o) => o.dispute?.opened_by === buyerId);
  const disputesLost = opened.filter((o) => o.dispute.status === 'resolved_seller').length;
  const chargebacks = mine.filter((o) => o.status === 'charged_back').length;
  const completed = (state.buyerCompletedBefore[buyerId] ?? 0) + mine.filter((o) => o.status === 'completed').length;
  const counts = new Map<string, number>();
  for (const r of ratings) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const topTags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([tag, count]) => ({ tag, count }));
  const caution = chargebacks > 0 || disputesLost >= 2 || (ratings.length >= 3 && negative / ratings.length > 0.25);
  return {
    level: caution ? 'caution' : completed < 3 ? 'new' : 'good', memberSince: u?.created_at ?? now(), completedOrders: completed,
    positive, negative, disputesOpened: opened.length, disputesLost, chargebacks, topTags,
  };
}

function orderDetail(o: any, viewer?: DemoUser) {
  const review = state.reviews.find((r) => r.order_id === o.id);
  const sellerView = !!viewer && (viewer.id === o.seller_id || viewer.role !== 'user');
  const rating = state.buyerRatings.find((r) => r.order_id === o.id);
  return {
    ...o,
    items: undefined,
    buyer_name: userById(o.buyer_id)?.display_name,
    seller_name: userById(o.seller_id)?.display_name,
    review: review ? { rating: review.rating, comment: review.comment, seller_reply: review.seller_reply } : null,
    warranty_claims: state.warrantyClaims.filter((c) => c.order_id === o.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    progress: state.progress.filter((p) => p.order_id === o.id),
    crypto_refund: refundOf(o.id),
    delivery_proof: o.delivery_proof_id ? (() => { const a = state.attachments.find((x) => x.id === o.delivery_proof_id); return a ? { id: a.id, mime: a.mime, original_name: a.original_name, created_at: a.created_at } : null; })() : null,
    handover_field: handoverFieldFor(o.game, state.offers.find((f) => f.id === o.offer_id)?.category_slug ?? ''),
    category_slug: state.offers.find((f) => f.id === o.offer_id)?.category_slug,
    attributes: state.offers.find((f) => f.id === o.offer_id)?.attributes ?? {},
    proof_required: PROOF_KINDS.has(o.category_kind) && o.delivery_mode === 'manual',
    buyer_reputation: sellerView ? buyerRepOf(o.buyer_id) : null,
    buyer_rating: sellerView && rating ? { positive: rating.positive, tags: rating.tags, created_at: rating.created_at } : null,
  };
}

function seedOrdersFor(buyer: DemoUser) {
  // Give the buyer a history the first time they sign in: one completed, one in its window.
  if (state.orders.some((o) => o.buyer_id === buyer.id)) return;
  // Round 26: an edited currency listing gets a new title (game · server), so fall back to any live listing.
  const pick = (title: string) => state.offers.find((f) => f.title.startsWith(title)) ?? state.offers.find((f) => f.status === 'active' && f.category_slug !== 'accounts' && availableOf(f) > 0)!;
  const make = (offer: any, ageMs: number) => {
    const o = createOrderRecord(buyer, offer, offer.min_qty ?? 1, 'fiat');
    o.created_at = new Date(Date.now() - ageMs).toISOString();
    payDemoOrder(o.id);
    return o;
  };
  if (!DEMO_FULL) {
    // Launch view: a short history in the launch games.
    const first = make(pick('10M silver — Europe'), 9 * day);
    first.character_name = 'Kaelthar';
    releaseOrder(first, 'buyer_confirmed');
    state.reviews.push({ id: rid(), order_id: first.id, seller_id: first.seller_id, rating: 5, comment: 'Fast trade at the Martlock bank.', seller_reply: null, created_at: now() });
    make(pick('200 Divine Orbs'), 4 * 3_600_000).character_name = 'Pat_Ranger';
    const kinah = make(pick('100M kinah — Siel'), 2 * day);
    kinah.character_name = 'Kaisinel_Pat';
    deliverOrder(kinah, 'Mailed in-game to Kaisinel_Pat, screenshot in the chat.');
    save();
    return;
  }
  const done = make(pick('Elden Ring'), 9 * day);
  releaseOrder(done, 'buyer_confirmed');
  state.reviews.push({ id: rid(), order_id: done.id, seller_id: done.seller_id, rating: 5, comment: 'Instant and worked first try.', seller_reply: null, created_at: now() });
  make(pick('Steam Wallet'), 4 * 3_600_000);
  // A boosting order from the demo seller, part-way through.
  const boost = make(pick('Gold IV → Platinum IV'), 2 * day);
  state.progress.push({ id: rid(), order_id: boost.id, percent: 35, note: 'Gold II now, 9 wins from 14 games', attachment_id: null, created_at: new Date(Date.now() - 20 * 3_600_000).toISOString() });
  appendMessage(boost.room_id, null, 'system', 'Progress: 35% · Gold II now, 9 wins from 14 games');
  const acct = make(pick('Lvl 80 Warrior'), day);
  deliverOrder(acct, 'Login: arthas-2009@example.com\nPassword: ••••••••• (change it now)\nOriginal registration email included.');
  // Delivered two days ago and never confirmed: the seller can ask support to release it.
  const stale = make(pick('100k Gold'), 3 * day);
  deliverOrder(stale, 'Traded in Stormwind, screenshot in the chat.');
  stale.delivered_at = new Date(Date.now() - 2 * day).toISOString();
  // A delivered account that showed a Riot sign-in badge: the handover check is waiting for the buyer.
  const hand = make(pick('Diamond 1 smurf'), 6 * 3_600_000);
  deliverOrder(hand, 'Riot ID: ArcaneSmurf#EUW\nPassword: ••••••••• (change it now)\nEmail is unlinked, add yours first.');
  save();
}

/** Games that deliver in-game need the buyer's character name (or UID), confirmed at checkout. */
/** Round 24, as the API: method from the listing's list, every field of it required (city from the list). */
function deliveryChoiceFor(offer: any, body: any) {
  const field = handoverFieldFor(offer.game, offer.category_slug);
  if (state.controls.pause_orders) fail(503, 'orders_paused', state.controls.pause_message || 'New orders are paused for a short while. Try again later.');
  if (!field) return null;
  const legacy = String(body.characterName ?? '').trim() || null;
  if (!body.deliveryMethod && !body.deliveryInfo && !legacy) fail(400, 'character_name_required', `${field.label} is required for ${offer.game}`);
  const c = cleanDeliveryChoice(methodsOf(offerView(offer)), body.deliveryMethod, body.deliveryInfo, legacy);
  if (!c.ok) return fail(400, c.code, c.error);
  return { method: c.method, info: c.info, name: c.info.character ?? c.info.uid ?? null };
}
function applyDeliveryChoice(u: DemoUser, offer: any, o: any, choice: ReturnType<typeof deliveryChoiceFor>, saveInfo: unknown) {
  if (!choice) return;
  Object.assign(o, { delivery_method: choice.method, delivery_info: choice.info, character_name: choice.name });
  if (saveInfo === true && choice.name) rememberCharacter(u, offer, o, choice.name);
}
function rememberCharacter(u: DemoUser, offer: any, o: any, name: string) {
  o.character_name = name;
  u.handover_names = { ...(u.handover_names ?? {}), [handoverKey(offer.game)]: name };
}
function createOrderRecord(buyer: DemoUser, offer: any, quantity: number, rail: 'fiat' | 'crypto', sellerDiscount = 0) {
  const priced = orderPrice(offer, quantity);
  const sellerAmount = priced.sellerCents - sellerDiscount;
  // (a cart sets checkout_id on the orders it creates)
  const bps = rateFor(offer);
  const amount = grossUp(sellerAmount, bps);
  if (priced.unitMicros != null && amount < MIN_CURRENCY_ORDER_USD_CENTS) fail(400, 'below_minimum_order', 'The smallest order is $1.00; add more units', { minCents: MIN_CURRENCY_ORDER_USD_CENTS, currency: 'USD' });
  const commission = amount - sellerAmount;
  const isAccount = offer.category_kind === 'account';
  const id = rid();
  const room = { id: rid(), order_id: id, offer_id: offer.id, buyer_id: buyer.id, seller_id: offer.seller_id, last_seq: 0 };
  state.rooms.push(room);
  const o: any = {
    id, ref: newOrderRef(), buyer_id: buyer.id, seller_id: offer.seller_id, offer_id: offer.id, offer_title: offer.title, game: offer.game,
    category_kind: offer.category_kind, delivery_mode: offer.delivery_mode, quantity, amount_cents: amount, credit_cents: 0, charged_cents: amount, currency: 'USD',
    commission_bps: bps, seller_net_cents: amount - commission, seller_tier: tierOf(offer.seller_id).tier.name, rail,
    status: 'awaiting_payment', protection: isAccount ? 'insurance_14d' : 'until_confirmed', protection_ends_at: null, delivered_at: null,
    payment_provider: rail === 'fiat' ? 'nowpayments' : 'escrow_contract',
    escrow_frozen: false, seller_protected: !isAccount || offer.owner_proof_status === 'verified', room_id: room.id,
    checklist: isAccount ? { items: CHECKLIST.map(([key, label]) => ({ key, label, done: false })), completed_at: null, handover_platform: null, handover_at: null } : null,
    dispute: null, events: [{ from_status: null, to_status: 'awaiting_payment', reason: 'order_created', created_at: now() }],
    tos_version: TOS_VERSION, tos_accepted_at: now(), lead_review: amount > 200_00,
    created_at: now(), items: [],
    warranty_days: rail === 'fiat' ? offer.warranty_days ?? 0 : 0, warranty_ends_at: null,
    unit_price_micros: priced.unitMicros, listing_unit_price_micros: priced.listingUnitMicros, amount_usd_cents: amount,
    presentment_currency: null as string | null, presentment_amount_cents: null as number | null, fx_rate: null as number | null, fx_locked_at: null as string | null,
  };
  state.orders.push(o);
  postOrderCard(o, 'awaiting_payment');
  if (offer.delivery_mode === 'manual') offer.stock -= quantity;
  appendMessage(room.id, null, 'system', `Order placed for "${offer.title}". Keep every message about this trade here: it's the record an arbiter reads if anything goes wrong.`, [], { code: 'order_created', params: { title: offer.title, quantity } });
  return o;
}

/** Spends the buyer's balance on an unpaid order (balance already promised to other unpaid orders is left alone). */
function applyCredit(buyer: DemoUser, o: any) {
  const promised = state.orders.filter((x) => x.buyer_id === buyer.id && x.status === 'awaiting_payment' && x.id !== o.id).reduce((s, x) => s + (x.credit_cents ?? 0), 0);
  const credit = Math.min(Math.max(0, (state.credit[buyer.id] ?? 0) - promised), o.amount_cents);
  o.credit_cents = credit;
  o.charged_cents = o.amount_cents - credit;
  if (o.charged_cents === 0) {
    o.payment_provider = 'none';
    payDemoOrder(o.id);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
type Handler = (ctx: { me: DemoUser | null; body: any; query: URLSearchParams; params: string[] }) => unknown;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]);

/** Shown in search, game pages and shops: active and not reserved for one buyer. */
const listed = (o: any) => o.status === 'active' && !o.reserved_for;
const need = (me: DemoUser | null) => me ?? fail(401, 'unauthorized', 'Sign in first');
const needStaff = (me: DemoUser | null) => {
  const u = need(me);
  if (u.role === 'user') fail(403, 'insufficient_permission', 'Staff only');
  return u;
};
const orderFor = (me: DemoUser, id: string) => {
  const o = state.orders.find((x) => x.id === id);
  if (!o || (o.buyer_id !== me.id && o.seller_id !== me.id && me.role === 'user')) fail(404, 'not_found', 'Order not found');
  return o;
};

// --- Auth & account --------------------------------------------------------------------
/** Turnstile (Round 23a): on when a browser test sets a site key, like the API with TURNSTILE_SECRET. */
const demoCaptcha = (body: any) => {
  let on = false;
  try {
    on = !!localStorage.getItem('bz.demo.turnstile');
  } catch {
    /* storage blocked */
  }
  if (on && !body.captchaToken) fail(400, 'captcha_required', 'Please complete the bot check.');
};
route('POST', '/auth/login', ({ body }) => {
  demoCaptcha(body);
  const u = state.users.find((x) => x.email.toLowerCase() === String(body.email ?? '').toLowerCase());
  if (!u || u.password !== body.password) fail(401, 'invalid_credentials', 'Wrong email or password.');
  if (u!.totp_enabled) return { mfaRequired: true, mfaToken: `mfa:${u!.id}` };
  if (u!.email === 'buyer@demo.test') seedOrdersFor(u!); // a purchase history to look at
  return { token: `demo:${u!.id}`, user: publicUser(u!) };
});
route('POST', '/auth/mfa', ({ body }) => {
  const id = String(body.mfaToken ?? '').replace('mfa:', '');
  if (!/^\d{6}$/.test(String(body.code ?? '').trim())) fail(400, 'invalid_code', 'Enter the 6-digit code (any 6 digits work in the demo)');
  return { token: `demo:${id}`, user: publicUser(userById(id)!) };
});
route('POST', '/auth/register', ({ body }) => {
  demoCaptcha(body);
  if (!/^\S+@\S+\.\S+$/.test(body.email ?? '') || String(body.password ?? '').length < 10) fail(400, 'validation_error', 'Invalid request');
  if (state.users.some((x) => x.email === body.email)) fail(409, 'email_taken', 'An account with this email already exists');
  if (body.acceptTerms !== true) fail(400, 'validation_error', 'You must be 18 or older and accept the Terms and Privacy Policy');
  if (state.controls.pause_signups) fail(503, 'signups_paused', state.controls.pause_message || 'Sign-ups are paused for a short while. Try again later.');
  // One code per user, at sign-up only (CEO, Oct 24): a friend's invite code or a creator code.
  const codes = [body.code, body.referralCode, body.creatorCode].filter((c: unknown) => typeof c === 'string' && c.trim()).map((c: string) => c.trim().toUpperCase());
  if (new Set(codes).size > 1) fail(400, 'one_code_only', 'Enter one code: a friend’s invite code or a creator code, not both');
  const code: string | undefined = codes[0];
  const creator = code ? state.affiliates.find((a) => a.code === code && a.status === 'active') : null;
  const u: DemoUser = {
    id: rid(), email: body.email, password: body.password, display_name: body.displayName ?? 'New user', role: 'user', kyc_tier: 0, status: 'active',
    email_verified_at: null, phone_verified_at: null, withdrawals_frozen: false, totp_enabled: false, payouts_enabled: false, legal_name: null, created_at: now(),
    locale: ['ar', 'es', 'fr', 'de', 'pt'].includes(body.locale) ? body.locale : 'en',
    tos_version: TOS_VERSION, tos_accepted_at: now(),
    news_opt_in: body.newsOptIn === true, news_opt_in_at: body.newsOptIn === true ? now() : null,
  };
  state.users.push(u);
  let codeApplied: 'referral' | 'creator' | null = null;
  if (creator) { state.affiliateOf[u.id] = creator.id; codeApplied = 'creator'; }
  else if (code && /^BZ[A-Z0-9]{6}$/.test(code)) codeApplied = 'referral';
  return { token: `demo:${u.id}`, user: publicUser(u), codeApplied };
});
route('POST', '/auth/logout', () => undefined);
route('PUT', '/me/locale', ({ me, body }) => {
  const u = need(me);
  if (!['en', 'ar', 'es', 'fr', 'de', 'pt'].includes(body.locale)) fail(400, 'validation_error', 'Unknown language');
  u.locale = body.locale;
  return { locale: body.locale };
});
route('POST', '/auth/refresh', () => fail(401, 'session_expired', 'You were signed out. Sign in again.'));
route('POST', '/auth/password/forgot', ({ body }) => (demoCaptcha(body), { message: 'If an account uses this email, a reset link is on its way.' }));
route('POST', '/auth/password/reset', () => fail(400, 'invalid_reset_link', 'Reset links are emailed in the real app; this demo has no email.'));

route('GET', '/me', ({ me }) => {
  return { user: publicUser(need(me)) };
});
route('POST', '/verify/:channel/send', ({ me }) => (need(me), { sent: true, hint: `Demo code: ${DEMO_CODE}` }));
route('POST', '/verify/:channel/confirm', ({ me, params, body }) => {
  const u = need(me);
  if (body.code !== DEMO_CODE) fail(400, 'invalid_code', `Wrong code. In the demo the code is ${DEMO_CODE}.`);
  if (params[0] === 'email') u.email_verified_at = now();
  else u.phone_verified_at = now();
  if (u.email_verified_at) u.kyc_tier = Math.max(u.kyc_tier, 1); // Round 24: a verified email is level 1 (no phone)
  return { user: publicUser(u) };
});
route('POST', '/kyc/start', ({ me }) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email first.');
  // The identity partner approves the demo check a moment later.
  setTimeout(() => {
    u.kyc_tier = 2;
    u.legal_name = u.display_name;
    save();
    window.dispatchEvent(new Event('session'));
  }, 1500);
  return { externalId: `demo-kyc-${u.id.slice(0, 8)}` };
});
route('GET', '/me/sessions', ({ me }) => (need(me), [{ id: 's1', device: navigator.userAgent.includes('Mobile') ? 'Phone browser' : 'This browser', current: true, ip: '203.0.113.24', lastActiveAt: now() }]));
route('POST', '/me/sessions/revoke-others', () => ({ signedOutDevices: 0 }));
route('DELETE', '/me/sessions/:id', () => undefined);
route('POST', '/me/password', ({ me, body }) => {
  const u = need(me);
  if (body.currentPassword !== u.password) fail(403, 'wrong_current_password', "Your current password isn't right.");
  if (String(body.newPassword ?? '').length < 10) fail(400, 'validation_error', 'Invalid request');
  u.password = body.newPassword;
  return { signedOutDevices: 0 };
});
const PREF_CATS = [
  ['orders', 'Purchases: payment received, delivery, refunds', false],
  ['selling', 'Sales: new orders to deliver, payouts', false],
  ['disputes', 'Disputes and chargebacks', true],
  ['reminders', 'Reminders before your protection window ends', false],
  ['alerts', 'Price alerts and watchlist updates', false],
  ['support', 'Replies to your help requests', true],
  ['account', 'Verification and payout account updates', true],
  ['security', 'Security alerts', true],
] as const;
const prefsOf = (id: string) => PREF_CATS.map(([category, label, mandatory]) => ({ category, label, mandatory, enabled: mandatory || state.emailPrefs[id]?.[category] !== false }));
route('GET', '/me/email-preferences', ({ me }) => prefsOf(need(me).id));
route('PUT', '/me/newsletter', ({ me, body }) => {
  const u = need(me);
  if (typeof body.optIn !== 'boolean') fail(400, 'validation_error', 'Invalid request');
  // Round 23e: opting out keeps the consent time; the opt-out time is kept apart.
  if (!!u.news_opt_in !== body.optIn) { u.news_opt_in = body.optIn; if (body.optIn) u.news_opt_in_at = now(); else (u as any).news_opt_out_at = now(); }
  return { newsOptIn: !!u.news_opt_in, newsOptInAt: u.news_opt_in_at ?? null, newsOptOutAt: (u as any).news_opt_out_at ?? null };
});
route('PATCH', '/me/email-preferences', ({ me, body }) => {
  const u = need(me);
  state.emailPrefs[u.id] = { ...state.emailPrefs[u.id], ...body };
  return prefsOf(u.id);
});
route('POST', '/me/2fa/setup', ({ me }) => {
  const u = need(me);
  return { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: `otpauth://totp/Bullizard:${encodeURIComponent(u.email)}?secret=JBSWY3DPEHPK3PXP&issuer=Bullizard` };
});
route('POST', '/me/2fa/enable', ({ me, body }) => {
  const u = need(me);
  if (!/^\d{6}$/.test(body.code ?? '')) fail(400, 'invalid_code', 'Enter the 6-digit code (any 6 digits work in the demo)');
  u.totp_enabled = true;
  return { recoveryCodes: Array.from({ length: 10 }, (_, i) => `demo-${(i + 1) * 1379}-code`), token: `demo:${u.id}` };
});
route('POST', '/me/2fa/disable', ({ me }) => {
  const u = need(me);
  u.totp_enabled = false;
  return { token: `demo:${u.id}` };
});
route('GET', '/me/export', ({ me }) => {
  const u = need(me);
  return { user: publicUser(u), orders: state.orders.filter((o) => o.buyer_id === u.id || o.seller_id === u.id).map((o) => ({ ...o, items: undefined })) };
});
route('POST', '/me/delete', () => fail(409, 'demo', 'Demo accounts can’t be deleted. Use “Reset demo” in the banner instead.'));

// --- Catalog ---------------------------------------------------------------------------
// The demo previews every phase: all categories are open (production starts at phase 1).
const PHASE_OF: Record<string, number> = { accounts: 2, boosting: 2, keys: 3, 'gift-cards': 3, 'video-games': 3 };
route('GET', '/categories', () => {
  // Browser tests make the request fail with localStorage 'bz.demo.fail' = 'categories' (Round 22: no categories + a retry).
  try {
    if ((localStorage.getItem('bz.demo.fail') ?? '').split(',').includes('categories')) fail(503, 'unavailable', 'Categories are unavailable');
  } catch (e) {
    if ((e as any)?.status) throw e;
  }
  return CATEGORIES.map((c) => ({ ...c, phase: PHASE_OF[c.slug] ?? 1, open: (PHASE_OF[c.slug] ?? 1) <= state.launchPhase, current_phase: state.launchPhase }));
});
route('GET', '/admin/launch', ({ me }) => (needPerm(me, 'ranks.manage'), { phase: state.launchPhase, foundingUntil: state.launch.foundingUntil, foundingFeaturedSlots: state.launch.featuredSlots, featuredDays: state.launch.featuredDays, allowedGames: state.launch.allowedGames === undefined ? (DEMO_FULL ? null : [...LAUNCH_GAMES]) : state.launch.allowedGames, categories: CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, phase: PHASE_OF[c.slug] ?? 1 })) }));
route('PUT', '/admin/launch', ({ me, body }) => {
  needPerm(me, 'ranks.manage');
  if (body.phase != null) {
    const phase = Number(body.phase);
    if (!(phase >= 1 && phase <= 3)) fail(400, 'validation_error', 'phase is 1, 2 or 3');
    state.launchPhase = phase;
  }
  if (body.foundingUntil) state.launch.foundingUntil = body.foundingUntil;
  if (body.foundingFeaturedSlots != null) state.launch.featuredSlots = Number(body.foundingFeaturedSlots);
  if (body.featuredDays != null) state.launch.featuredDays = Number(body.featuredDays);
  if (body.allowedGames !== undefined) state.launch.allowedGames = body.allowedGames;
  save();
  return { phase: state.launchPhase, foundingUntil: state.launch.foundingUntil, foundingFeaturedSlots: state.launch.featuredSlots, featuredDays: state.launch.featuredDays };
});
const isFeatured = (o: any) => !!o.featured_until && Date.parse(o.featured_until) > Date.now();
/** A listing's unit price for filters and sorting: micro-units for currency, the per-unit price × 10,000 otherwise. */
const unitKey = (o: any) => (o.unit_price_micros != null ? Number(o.unit_price_micros) : o.price_cents * 10_000);
/** The game's server / region / league field for a category (its first listing field). */
const serverField = (game: string, category: string) => attributesFor(game, category || 'currency')[0];
/**
 * Market search (Round 25, B4): every filter the API takes. `skip` leaves one filter out, so a facet can
 * count its own options as if that filter were not set (as the API does).
 */
function marketItems(query: URLSearchParams, skip?: 'game' | 'server' | 'deliveryMethod' | 'category') {
  const q = (query.get('q') ?? '').toLowerCase().trim();
  let items = state.offers.filter(listed).map(offerView);
  if (q) items = items.filter((o) => `${o.title} ${o.game} ${o.description}`.toLowerCase().includes(q) || q.split(/\s+/).every((w) => `${o.title} ${o.game}`.toLowerCase().includes(w)));
  if (query.get('delivery') === 'instant') items = items.filter((o) => o.delivery_mode === 'auto');
  if (query.get('ownerVerified') === 'true') items = items.filter((o) => o.category_kind !== 'account' || o.owner_proof_status === 'verified');
  if (query.get('maxPrice')) items = items.filter((o) => o.price_cents <= Number(query.get('maxPrice')));
  if (query.get('minRating')) items = items.filter((o) => (o.seller_rating ?? 0) >= Number(query.get('minRating')));
  if (query.get('seller')) items = items.filter((o) => o.seller_id === query.get('seller'));
  if (query.get('game') && skip !== 'game') items = items.filter((o) => o.game.toLowerCase() === query.get('game')!.toLowerCase());
  if (query.get('inStock') !== 'false') items = items.filter((o) => o.stock > 0);
  if (query.get('category') && skip !== 'category') items = items.filter((o) => o.category_slug === query.get('category'));
  // Price range in the display currency, per unit.
  const rate = RATES[String(query.get('currency') ?? 'USD').toUpperCase()] ?? 1;
  const lo = parseUnitPrice(query.get('minUnitPrice') ?? '');
  const hi = parseUnitPrice(query.get('maxUnitPrice') ?? '');
  if (lo != null) items = items.filter((o) => Math.ceil(unitKey(o) * rate) >= lo);
  if (hi != null) items = items.filter((o) => Math.ceil(unitKey(o) * rate) <= hi);
  const dm = query.get('deliveryMethod');
  if (dm && skip !== 'deliveryMethod') items = items.filter((o) => methodsOf(o).includes(dm as never));
  const mt = query.get('maxDeliveryTime');
  if (mt && isDeliveryTime(mt)) items = items.filter((o) => o.delivery_minutes <= DELIVERY_TIMES[mt]);
  if (query.get('online') === 'true') items = items.filter((o) => o.seller_online);
  if (query.get('minLevel')) items = items.filter((o) => (o.seller_level ?? 0) >= Number(query.get('minLevel')));
  // Server / region / league: the game's first field (needs a game).
  const server = query.get('server');
  if (server && query.get('game') && skip !== 'server') {
    const f = serverField(query.get('game')!, query.get('category') ?? 'currency');
    if (f) items = items.filter((o) => String(o.attributes?.[f.key] ?? '').toLowerCase() === server.toLowerCase());
  }
  // Game-specific fields: attr.<key>=<value>, exact and case-insensitive.
  const attrs = [...query.entries()].filter(([k]) => k.startsWith('attr.')).map(([k, v]) => [k.slice(5), v.toLowerCase()] as const);
  return { items, attrs };
}
route('GET', '/offers', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase().trim();
  const { items: base, attrs } = marketItems(query, 'category');
  let items = base;
  const matches = (o: any, skip?: string) => attrs.every(([k, v]) => k === skip || String(o.attributes?.[k] ?? '').toLowerCase() === v);
  const counted = (xs: any[]) => {
    const m = new Map<string, number>();
    for (const o of xs) for (const [k, v] of Object.entries(o.attributes ?? {})) m.set(`${k}\u0000${v}`, (m.get(`${k}\u0000${v}`) ?? 0) + 1);
    return [...m.entries()].map(([kv, count]) => ({ key: kv.split('\u0000')[0]!, value: kv.split('\u0000')[1]!, count }));
  };
  // Each field's counts ignore that field's own filter, as the API does.
  const inCat = (o: any) => !query.get('category') || o.category_slug === query.get('category');
  const attributeFacets = query.get('game')
    ? [
        ...counted(items.filter((o) => inCat(o) && matches(o))).filter((f) => !attrs.some(([k]) => k === f.key)),
        ...attrs.flatMap(([k]) => counted(items.filter((o) => inCat(o) && matches(o, k))).filter((f) => f.key === k)),
      ].sort((a, b) => a.key.localeCompare(b.key) || b.count - a.count || a.value.localeCompare(b.value))
    : [];
  items = items.filter((o) => matches(o));
  // Facets ignore the category filter so every category tab can show its count.
  const facets = { categories: CATEGORIES.map((c) => ({ category_slug: c.slug, count: items.filter((o) => o.category_slug === c.slug).length })).filter((c) => c.count > 0), attributes: attributeFacets };
  if (query.get('category')) items = items.filter((o) => o.category_slug === query.get('category'));
  const sort = query.get('sort') ?? (q ? 'relevance' : 'newest');
  const by: Record<string, (a: any, b: any) => number> = {
    newest: (a, b) => b.created_at.localeCompare(a.created_at),
    recommended: (a, b) => (b.seller_rating ?? 0) * 100 - (a.seller_rating ?? 0) * 100 + (a.price_cents - b.price_cents) / 10,
    min_qty_asc: (a, b) => (a.min_qty ?? 1) - (b.min_qty ?? 1),
    delivery: (a, b) => (a.delivery_hours ?? 0) - (b.delivery_hours ?? 0),
    fastest_delivery: (a, b) => a.delivery_minutes - b.delivery_minutes,
    most_sold: (a, b) => (b.sold_count ?? 0) - (a.sold_count ?? 0),
    price_asc: (a, b) => unitKey(a) - unitKey(b),
    price_desc: (a, b) => unitKey(b) - unitKey(a),
    rating: (a, b) => (b.seller_rating ?? 0) - (a.seller_rating ?? 0),
    best_selling: (a, b) => b.seller_completed_orders - a.seller_completed_orders,
    trust: (a, b) => TRUST_ORDER.indexOf(a.seller_trust_level) - TRUST_ORDER.indexOf(b.seller_trust_level) || (b.seller_rating ?? 0) - (a.seller_rating ?? 0),
  };
  // Featured (CEO, Round 25): only the seller's own shop shows it, pinned first. Nothing else boosts it.
  const shop = !!query.get('seller');
  if (shop) for (const o of items) o.featured = isFeatured(state.offers.find((x) => x.id === o.id));
  if (by[sort]) items.sort((a, b) => (shop ? Number(b.featured) - Number(a.featured) : 0) || by[sort]!(a, b));
  const cur = String(query.get('currency') ?? '').toUpperCase();
  if (RATES[cur]) for (const o of items) Object.assign(o, { display_currency: cur, display_price_cents: Math.round(o.price_cents * RATES[cur]!), display_unit_price_micros: o.unit_price_micros == null ? null : Math.ceil(o.unit_price_micros * RATES[cur]!) });
  const page = Math.max(1, Number(query.get('page') ?? 1));
  const pageSize = Number(query.get('pageSize') ?? 12);
  if (pageSize > 60) fail(400, 'validation_error', 'pageSize is at most 60');
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, hasMore: page * pageSize < items.length, facets };
});
// Round 25 (B4): counts per game, server and delivery method for the market's filter panel.
route('GET', '/offers/facets', ({ query }) => {
  const byGame = new Map<string, number>();
  for (const o of marketItems(query, 'game').items) byGame.set(o.game, (byGame.get(o.game) ?? 0) + 1);
  const game = query.get('game');
  let servers = null as null | { key: string; label: string; values: Array<{ name: string; count: number }> };
  if (game) {
    const f = serverField(game, query.get('category') ?? 'currency');
    if (f) {
      const list = marketItems(query, 'server').items;
      const counts = new Map<string, number>();
      for (const o of list) { const v = o.attributes?.[f.key]; if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
      const names = f.type === 'select' ? [...(f.options ?? [])] : [...counts.keys()].sort();
      servers = { key: f.key, label: f.label, values: names.map((name) => ({ name, count: counts.get(name) ?? 0 })) };
    }
  }
  const methods = new Map<string, number>();
  for (const o of marketItems(query, 'deliveryMethod').items) for (const m of methodsOf(o)) methods.set(m, (methods.get(m) ?? 0) + 1);
  return {
    games: [...byGame.entries()].map(([g, count]) => ({ game: g, count })).sort((a, b) => b.count - a.count || a.game.localeCompare(b.game)),
    servers,
    delivery_methods: [...methods.entries()].map(([method, count]) => ({ method, count })),
  };
});
// Round 25 (B1): every server of a game with its live offers, sellers, sales and lowest unit price. No paging.
route('GET', '/games/:slug/servers', ({ params, query }) => {
  const category = query.get('category') ?? 'currency';
  const games = [...new Set([...state.offers.map((o) => o.game), ...Object.keys(GAME_SETS)])];
  const found = games.find((g) => slugify(g) === params[0]);
  if (!found) return fail(404, 'not_found', 'Game not found');
  const game = state.offers.find((o) => o.game.toLowerCase() === found.toLowerCase())?.game ?? found;
  const f = serverField(game, category);
  if (!f) return [];
  const live = state.offers.filter((o) => listed(o) && o.game.toLowerCase() === game.toLowerCase() && o.category_slug === category && availableOf(o) > 0).map(offerView);
  const names = f.type === 'select' ? [...(f.options ?? [])] : [...new Set(live.map((o) => o.attributes?.[f.key]).filter(Boolean) as string[])].sort();
  return names.map((name) => {
    const list = live.filter((o) => o.attributes?.[f.key] === name);
    const bySeller = new Map<string, { id: string; name: string; avatar: null; sales: number }>();
    for (const o of list) {
      const cur = bySeller.get(o.seller_id) ?? { id: o.seller_id, name: o.seller_name, avatar: null, sales: o.seller_completed_orders };
      bySeller.set(o.seller_id, cur);
    }
    const sellers = [...bySeller.values()].sort((a, b) => b.sales - a.sales);
    const from = list.reduce<number | null>((m, o) => (o.unit_price_micros != null && (m == null || o.unit_price_micros < m) ? o.unit_price_micros : m), null);
    return {
      name, offers: list.length, sellers: sellers.slice(0, 4).map(({ sales: _s, ...x }) => x), sellers_count: sellers.length,
      sold: list.reduce((n, o) => n + (o.sold_count ?? 0), 0), from_unit_price: from == null ? null : formatUnitPrice(from), from_unit_price_micros: from,
    };
  });
});
/** Open challenge leagues become sell-form choices (the shared attribute sets read them live). */
function syncLeagues() {
  for (const game of ['path of exile', 'path of exile 2']) {
    setLeagues(game, state.leagues.filter((l) => l.game === game && (!l.ends_at || Date.parse(l.ends_at) > Date.now())).map((l) => l.name));
  }
}
syncLeagues();
route('GET', '/catalog/attributes', ({ query }) => {
  const game = query.get('game');
  const category = query.get('category');
  return game && category ? { game, category, fields: attributesFor(game, category), handover: handoverFieldFor(game, category) } : { defaults: CATEGORY_DEFAULTS, games: GAME_SETS, leagues: LEAGUES };
});
route('GET', '/leagues', () => (syncLeagues(), { open: LEAGUES, leagues: state.leagues }));
route('GET', '/texts/:key', ({ params }) => state.texts[params[0]!] ?? fail(404, 'not_found', 'Text not found'));
route('PUT', '/admin/texts/:key', ({ me, params, body }) => {
  needPerm(me, 'support.manage');
  const key = params[0]!;
  if (!state.texts[key]) fail(404, 'not_found', 'Text not found');
  const text = String(body.body ?? '').trim();
  if (text.length < 10) fail(400, 'validation_error', 'Write at least a sentence');
  if (body.linkHref && !String(body.linkHref).startsWith('/')) fail(400, 'validation_error', 'Links point inside Bullizard');
  Object.assign(state.texts[key]!, { body: text, link_label: body.linkLabel ?? '', link_href: body.linkHref ?? '', updated_at: now() });
  save();
  return state.texts[key];
});

// --- Founding Sellers: badge + free featured spots during the launch -----------------------------
const foundingOf = (u: DemoUser) => {
  const windowOpen = Date.parse(state.launch.foundingUntil) > Date.now();
  const used = state.offers.filter((o) => o.seller_id === u.id && o.featured_until && Date.parse(o.featured_until) > Date.now()).length;
  return { founding: !!u.founding, foundingUntil: state.launch.foundingUntil, windowOpen, featuredSlots: u.founding && windowOpen ? state.launch.featuredSlots : 0, featuredUsed: used, featuredDays: state.launch.featuredDays };
};
route('POST', '/offers/:id/feature', ({ me, params }) => {
  const u = needSeller(me);
  const st = foundingOf(u);
  if (!st.founding) fail(400, 'not_founding', 'Featured spots are free for Founding Sellers during the launch; paid spots come later');
  if (!st.windowOpen) fail(400, 'promo_over', 'The launch promo has ended, so free featured spots are closed');
  const o = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id && x.status === 'active') ?? fail(400, 'invalid_offer', 'Feature one of your active listings');
  const live = o.featured_until && Date.parse(o.featured_until) > Date.now();
  if (!live && st.featuredUsed >= st.featuredSlots) fail(400, 'no_slots', `You can feature ${st.featuredSlots} listings at a time; unfeature one first`);
  o.featured_until = new Date(Date.now() + st.featuredDays * day).toISOString();
  o.version++;
  save();
  return foundingOf(u);
});
route('DELETE', '/offers/:id/feature', ({ me, params }) => {
  const u = needSeller(me);
  const o = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id);
  if (o) (o.featured_until = null), o.version++;
  save();
  return foundingOf(u);
});

// --- Game voting -------------------------------------------------------------------------------
const voteView = (s: any, viewer?: string) => ({ id: s.id, name: s.name, votes: s.votes, status: s.status, staff_note: s.staff_note, created_at: s.created_at, voted: !!viewer && s.voters.includes(viewer) });
const voteOrder = (a: any, b: any) => ['planned', 'open', 'added', 'declined'].indexOf(a.status) - ['planned', 'open', 'added', 'declined'].indexOf(b.status) || b.votes - a.votes || a.created_at.localeCompare(b.created_at);
route('GET', '/games/votes', ({ me, query }) => state.gameVotes.filter((s) => !query.get('status') || s.status === query.get('status')).sort(voteOrder).map((s) => voteView(s, me?.id)));
route('POST', '/games/votes', ({ me, body }) => {
  const u = need(me);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) fail(400, 'invalid_name', 'Give the game’s name (2 to 80 characters)');
  if (state.offers.some((o) => listed(o) && o.game.toLowerCase() === name.toLowerCase())) fail(400, 'already_listed', `${name} is already on the market`);
  if (state.gameVotes.filter((s) => s.suggested_by === u.id && Date.parse(s.created_at) > Date.now() - day).length >= 3) fail(429, 'too_many_suggestions', 'You can suggest three games a day');
  let s = state.gameVotes.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) {
    s = { id: rid(), name, votes: 0, status: 'open', staff_note: '', suggested_by: u.id, voters: [] as string[], created_at: now() };
    state.gameVotes.push(s);
  }
  if (!s.voters.includes(u.id)) (s.voters.push(u.id), s.votes++);
  save();
  return voteView(s, u.id);
});
route('POST', '/games/votes/:id/vote', ({ me, params, body }) => {
  const u = need(me);
  const s = state.gameVotes.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Suggestion not found');
  const on = body.on !== false;
  if (on && !s.voters.includes(u.id)) (s.voters.push(u.id), s.votes++);
  if (!on && s.voters.includes(u.id)) (s.voters.splice(s.voters.indexOf(u.id), 1), s.votes--);
  save();
  return { id: s.id, name: s.name, votes: s.votes, status: s.status };
});
route('PATCH', '/admin/games/votes/:id', ({ me, params, body }) => {
  needPerm(me, 'moderation.manage');
  const s = state.gameVotes.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Suggestion not found');
  Object.assign(s, { status: body.status, staff_note: body.note ?? '' });
  save();
  return voteView(s);
});

// --- Creator affiliate codes -------------------------------------------------------------------
const affiliateView = (a: any) => {
  const earned = state.affiliateEarnings.filter((e) => e.affiliate_id === a.id);
  const u = userById(a.user_id);
  return { ...a, display_name: u?.display_name, email: u?.email, buyers: Object.values(state.affiliateOf).filter((id) => id === a.id).length, orders: earned.length, earned_cents: earned.reduce((s, e) => s + e.earned_cents, 0) };
};
route('GET', '/admin/affiliates', ({ me }) => (needPerm(me, 'promos.manage'), state.affiliates.map(affiliateView)));
route('POST', '/admin/affiliates', ({ me, body }) => {
  needPerm(me, 'promos.manage');
  const code = String(body.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,19}$/.test(code)) fail(400, 'invalid_code', 'Codes are 3 to 20 letters, digits, - or _');
  if (!userById(body.userId)) fail(404, 'not_found', 'User not found');
  if (state.affiliates.some((a) => a.code === code)) fail(409, 'code_taken', 'That code is already in use');
  if (state.affiliates.some((a) => a.user_id === body.userId)) fail(409, 'already_affiliate', 'This user already has a code');
  const a = { id: rid(), user_id: body.userId, code, rate_bps: Number(body.rateBps), status: 'active', note: String(body.note ?? ''), created_at: now() };
  state.affiliates.push(a);
  save();
  return affiliateView(a);
});
route('PATCH', '/admin/affiliates/:id', ({ me, params, body }) => {
  needPerm(me, 'promos.manage');
  const a = state.affiliates.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Affiliate not found');
  Object.assign(a, { rate_bps: body.rateBps ?? a.rate_bps, status: body.status ?? a.status, note: body.note ?? a.note });
  save();
  return affiliateView(a);
});
// Feature switches.
route('GET', '/features', () => ({
  sandbox: true, legal: { tosVersion: TOS_VERSION, notice: null },
  paused: { withdrawals: state.controls.pause_withdrawals, orders: state.controls.pause_orders, chat: state.controls.pause_chat, signups: state.controls.pause_signups, message: state.controls.pause_message },
  limits: { maxOrderCents: state.controls.max_order_cents, maxWithdrawalDayCents: state.controls.max_withdrawal_day_cents, newAccountDays: state.controls.new_account_days, newAccountMaxOrderCents: state.controls.new_account_max_order_cents },
}));
route('GET', '/admin/controls', ({ me }) => (needPerm(me, 'controls.manage'), { ...state.controls }));
route('PUT', '/admin/controls', ({ me, body }) => {
  const staff = needPerm(me, 'controls.manage');
  for (const k of Object.keys(state.controls)) if (k in body && k !== 'updated_at') (state.controls as any)[k] = body[k];
  state.controls.updated_at = now();
  save();
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: staff.display_name, actor_role: staff.role, ip: '203.0.113.7', action: 'controls.update', target_type: 'controls', target_id: 'platform', details: body });
  return { ...state.controls };
});

// --- Legal documents (versioned; Legal's approved text replaces the interim copy through Ops) ----
route('GET', '/legal/:doc', ({ params }) => legalDoc(params[0]!));
route('GET', '/legal/:doc/history', ({ params }) => [(({ content_md: _c, ...rest }) => rest)(legalDoc(params[0]!))]);
route('GET', '/legal/:doc/versions/:version', ({ params }) => {
  const d = legalDoc(params[0]!);
  if (d.version !== params[1]) fail(404, 'not_found', 'Document version not found');
  return d;
});
route('GET', '/me/legal', ({ me }) => {
  const u = need(me);
  return { tosVersion: u.tos_version ?? TOS_VERSION, acceptedAt: u.tos_accepted_at ?? u.created_at, currentVersion: TOS_VERSION, reacceptanceRequired: false };
});
route('POST', '/me/legal/accept', ({ me }) => {
  const u = need(me);
  u.tos_version = TOS_VERSION; u.tos_accepted_at = now(); save();
  return { tosVersion: TOS_VERSION, acceptedAt: u.tos_accepted_at };
});
route('GET', '/admin/legal', ({ me }) => (needStaff(me), LEGAL_DOCS.map((doc) => (({ content_md: _c, ...rest }) => rest)(legalDoc(doc)))));
route('PUT', '/admin/legal/:doc', ({ me }) => (needStaff(me), fail(409, 'demo_only', 'Legal documents are published through the real API')));
// Invite friends: 20% of our commission on every order of a referred user (demo: a sample friend with two paid orders).
route('GET', '/me/referral', ({ me }) => {
  const u = need(me);
  const code = `BZ${u.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  const rewards = u.role === 'user' && !u.founding
    ? [
        { order_id: 'ref-o2', amount_cents: 42, commission_cents: 2_11, rate_bps: 2000, currency: 'USD', status: 'granted', reason: null, created_at: new Date(Date.now() - 2 * day).toISOString(), friend: 'Rami_K' },
        { order_id: 'ref-o1', amount_cents: 26, commission_cents: 1_32, rate_bps: 2000, currency: 'USD', status: 'granted', reason: null, created_at: new Date(Date.now() - 9 * day).toISOString(), friend: 'Rami_K' },
      ]
    : [];
  const earned = rewards.reduce((s, r) => s + r.amount_cents, 0);
  return { code, link: `${location.origin}/login?ref=${code}`, rateBps: 2000, activeDays: 365, friendsSignedUp: rewards.length ? 1 : 0, friendsActive: rewards.length ? 1 : 0, earnedCents: earned, earnedMonthCents: earned, ordersPaid: rewards.length, rewards };
});
route('GET', '/me/affiliate', ({ me }) => {
  const u = need(me);
  const a = state.affiliates.find((x) => x.user_id === u.id);
  if (!a) return null;
  const earned = state.affiliateEarnings.filter((e) => e.affiliate_id === a.id);
  const month = new Date();
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  return { ...affiliateView(a), earned_month_cents: earned.filter((e) => Date.parse(e.created_at) >= month.getTime()).reduce((s, e) => s + e.earned_cents, 0), recent: earned.slice(-50).reverse() };
});
route('POST', '/me/affiliate', () => fail(410, 'code_at_signup_only', 'A friend’s invite code or a creator code is entered once, at sign-up'));
route('GET', '/admin/leagues', ({ me }) => (needPerm(me, 'leagues.manage'), { leagues: state.leagues, games: ['path of exile', 'path of exile 2'], inactiveSellerDays: 14 }));
route('POST', '/admin/leagues', ({ me, body }) => {
  needPerm(me, 'leagues.manage');
  const game = String(body.game ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  if (!['path of exile', 'path of exile 2'].includes(game)) fail(400, 'invalid_game', 'Leagues exist for path of exile and path of exile 2');
  if ((PERMANENT_LEAGUES as readonly string[]).some((p) => p.toLowerCase() === name.toLowerCase())) fail(400, 'invalid_league', `${name} is a permanent league`);
  if (state.leagues.some((l) => l.game === game && l.name.toLowerCase() === name.toLowerCase())) fail(409, 'league_exists', 'That league is already listed');
  const l = { id: rid(), game, name, starts_at: body.startsAt ?? now(), ends_at: body.endsAt ?? null, created_at: now(), updated_at: now() };
  state.leagues.push(l);
  syncLeagues();
  save();
  return l;
});
route('PATCH', '/admin/leagues/:id', ({ me, params, body }) => {
  needPerm(me, 'leagues.manage');
  const l = state.leagues.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'League not found');
  if ('endsAt' in body) l.ends_at = body.endsAt ?? null;
  if ('startsAt' in body) l.starts_at = body.startsAt ?? null;
  l.updated_at = now();
  syncLeagues();
  save();
  return l;
});
/** Listings in an ended league whose seller has not been seen for two weeks expire. */
function expireLeagueListings() {
  let n = 0;
  for (const l of state.leagues.filter((x) => x.ends_at && Date.parse(x.ends_at) <= Date.now())) {
    for (const o of state.offers.filter((f) => f.status === 'active' && f.game.toLowerCase() === l.game && f.attributes?.league === l.name)) {
      const seen = state.presence[o.seller_id]?.last_seen_at ? Date.parse(state.presence[o.seller_id]!.last_seen_at) : Date.parse(userById(o.seller_id)?.created_at ?? now());
      if (seen > Date.now() - 14 * day) continue;
      o.status = 'expired';
      o.expired_reason = `league_ended:${l.name}`;
      o.version++;
      notify(o.seller_id, 'selling', 'listing_expired_league', `${l.name} has ended: “${o.title}” is no longer listed`, 'Move it to an open league from your seller hub to list it again.', '/sell');
      n++;
    }
  }
  save();
  return n;
}
route('POST', '/admin/leagues/expire', ({ me }) => (needPerm(me, 'leagues.manage'), { expired: expireLeagueListings() }));
route('POST', '/offers/:id/relist', ({ me, params, body }) => {
  const u = needSeller(me);
  const o = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id && x.status === 'expired') ?? fail(404, 'not_found', 'Offer not found');
  syncLeagues();
  const open = LEAGUES[o.game.toLowerCase()] ?? [];
  const match = open.find((x) => x.toLowerCase() === String(body.league ?? '').trim().toLowerCase()) ?? fail(400, 'invalid_league', `Pick an open league: ${open.join(', ')}`);
  Object.assign(o, { status: 'active', expired_reason: null, attributes: { ...o.attributes, league: match } });
  o.version++;
  save();
  return offerView(o);
});
route('GET', '/catalog/games', () => {
  const live = state.offers.filter(listed).map(offerView).filter((o) => o.stock > 0);
  const games = new Map<string, any[]>();
  for (const o of live) games.set(o.game, [...(games.get(o.game) ?? []), o]);
  return [...games.entries()]
    .map(([game, xs]) => {
      const cats = new Map<string, number>();
      for (const o of xs) cats.set(o.category_slug, (cats.get(o.category_slug) ?? 0) + 1);
      return {
        game, offers: xs.length, sellers: new Set(xs.map((o) => o.seller_id)).size, min_price_cents: Math.min(...xs.map((o) => o.price_cents)),
        instant: xs.filter((o) => o.delivery_mode === 'auto').length,
        categories: [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([slug, count]) => ({ slug, count })),
      };
    })
    .sort((a, b) => a.game.localeCompare(b.game));
});
route('GET', '/games', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase();
  const counts = new Map<string, number>();
  for (const o of state.offers) if (listed(o) && o.game.toLowerCase().includes(q)) counts.set(o.game, (counts.get(o.game) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([game, offers]) => ({ game, offers }));
});
route('GET', '/sellers/:id', ({ params, query }) => {
  const u = userById(params[0]!) ?? fail(404, 'not_found', 'Seller not found');
  const s = sellerStats(u.id);
  const limit = Number(query.get('limit') ?? 20);
  const offset = Number(query.get('offset') ?? 0);
  const reviews = state.reviews
    .filter((r) => r.seller_id === u.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => {
      const o = state.orders.find((x) => x.id === r.order_id);
      // Round 23d: reviewers are shown by initial only ("M.") — the API does the same.
      const full = o ? userById(o.buyer_id)?.display_name : ['Mira_K', 'zed.plays', 'Hollowfang', 'nyx', 'BaguetteBandit', 'TomTheTank'][r.id.length % 6];
      return { ...r, buyer_name: `${(full ?? 'B').slice(0, 1)}.`, offer_title: o?.offer_title ?? r.game ?? null };
    });
  const before = state.reviewsBefore[u.id];
  return {
    id: u.id, display_name: u.display_name, member_since: u.created_at, identity_verified: u.kyc_tier >= 2, founding: !!u.founding, completed_orders: s.completed,
    active_listings: state.offers.filter((o) => o.seller_id === u.id && listed(o)).length,
    on_time_delivery_pct: before ? Math.min(100, 93 + (before.count % 7)) : null, shop_paused: false, shop_paused_until: null, shop_pause_message: null,
    ...presenceOf(u.id),
    trust_level: state.trust[u.id] ?? 'new',
    rating: { average: s.rating, count: s.count, positive_pct: s.count ? Math.round(((s.rating ?? 0) / 5) * 1000) / 10 : null },
    storefront: storefrontOf(u.id),
    reviews: reviews.slice(offset, offset + limit),
  };
});
function storefrontOf(sellerId: string) {
  const s = state.storefronts[sellerId] ?? { intro: '', accent: 'steel', banner: null, pinned: [] };
  return {
    intro: s.intro, accent: s.accent, banner_url: s.banner, languages: (s as any).languages ?? ['en'],
    pinned: s.pinned.map((id) => state.offers.find((o) => o.id === id && o.seller_id === sellerId && listed(o))).filter(Boolean).map(offerView),
  };
}
route('GET', '/seller/storefront', ({ me }) => storefrontOf(needSeller(me).id));
route('PUT', '/seller/storefront', ({ me, body }) => {
  const u = needSeller(me);
  const cur = state.storefronts[u.id] ?? { intro: '', accent: 'steel', banner: null, pinned: [] };
  if (body.intro != null) {
    const intro = String(body.intro).trim();
    if (intro.length > 600) fail(400, 'intro_too_long', 'Keep the intro under 600 characters');
    if (detectOffPlatform(intro).length) fail(400, 'contact_details', 'Contact details and outside payment methods aren’t allowed: buyers reach you through order chat');
    if (matchTerms(intro, state.modTerms).length) fail(400, 'intro_not_allowed', 'The intro mentions something our rules don’t allow on a shop page');
    cur.intro = intro;
  }
  if (body.accent) cur.accent = body.accent;
  if (body.languages) {
    const langs = [...new Set((body.languages as string[]).map((l) => String(l).trim()))];
    if (langs.length > 8 || langs.some((l) => !/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l))) fail(400, 'validation_error', 'Pick up to 8 languages');
    (cur as any).languages = langs;
  }
  if (body.pinned) {
    const ids = [...new Set(body.pinned as string[])];
    if (ids.length > 4) fail(400, 'too_many_pinned', 'Pin up to 4 listings');
    if (ids.some((id) => !state.offers.some((o) => o.id === id && o.seller_id === u.id && listed(o)))) fail(400, 'invalid_pinned', 'Pin your own active listings');
    cur.pinned = ids;
  }
  state.storefronts[u.id] = cur;
  return storefrontOf(u.id);
});
route('GET', '/seller/badges', ({ me }) => {
  const u = needSeller(me);
  return { badges: badgesOf(u.id), earned: earnedBadgesOf(u.id) };
});
route('PUT', '/seller/badges', ({ me, body }) => {
  const u = needSeller(me);
  const keys = [...new Set((body.badges ?? []) as string[])];
  if (keys.length > 2) fail(400, 'too_many_badges', 'Show up to 2 badges');
  const have = new Set(earnedBadgesOf(u.id).map((b) => b.key));
  if (keys.some((k) => !have.has(k))) fail(400, 'badge_not_earned', 'You can only show badges you have earned');
  ((state as any).sellerBadges ??= {})[u.id] = keys;
  save();
  return { badges: keys, earned: earnedBadgesOf(u.id) };
});
route('POST', '/seller/storefront/banner', ({ me, body }) => {
  const u = needSeller(me);
  if (!/^image\/(png|jpeg|webp)$/.test(body.type ?? '')) fail(400, 'unsupported_file', 'Use a PNG, JPEG or WebP image');
  // The demo keeps the image in this browser's storage, so it has to stay small.
  if (body.size > 600_000) fail(413, 'file_too_large', 'In the demo, banners can be up to 600 KB');
  const cur = state.storefronts[u.id] ?? { intro: '', accent: 'steel', banner: null, pinned: [] };
  state.storefronts[u.id] = { ...cur, banner: body.dataUrl };
  return storefrontOf(u.id);
});
route('DELETE', '/seller/storefront/banner', ({ me }) => {
  const u = needSeller(me);
  if (state.storefronts[u.id]) state.storefronts[u.id]!.banner = null;
  return storefrontOf(u.id);
});
route('GET', '/offers/:id', ({ me, params }) => {
  const o = state.offers.find((x) => x.id === params[0]);
  // A listing agreed on a buyer request is only for that buyer (and its seller and staff); one in review only for its seller and staff.
  if (o && o.status === 'review' && o.seller_id !== me?.id && (!me || (me.role === 'user' && !me.staff_roles?.length))) fail(404, 'not_found', 'Listing not found');
  if (!o || (o.reserved_for && ![o.reserved_for, o.seller_id].includes(me?.id ?? '') && (!me || (me.role === 'user' && !me.staff_roles?.length)))) fail(404, 'not_found', 'Listing not found');
  return offerView(o);
});

/** Repeatable pseudo-random numbers per listing, so the demo's price history is the same on every visit. */
function seeded(key: string) {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) % 10_000) / 10_000;
}
const DAY = 86_400_000;
route('GET', '/offers/:id/price-history', ({ me, params, query }) => {
  const o = state.offers.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Listing not found');
  if (o.reserved_for && ![o.reserved_for, o.seller_id].includes(me?.id ?? '')) fail(404, 'not_found', 'Listing not found');
  const days = Number(query.get('days') ?? 90);
  const rnd = seeded(o.id);
  const nowPrice = effectivePrice(o);
  // A few earlier prices, each within about 20% of today's, then today's.
  const changes = 1 + Math.floor(rnd() * 4);
  const points = Array.from({ length: changes }, (_, i) => ({
    at: new Date(Date.now() - (days - (i * days) / (changes + 1)) * DAY).toISOString(),
    price_cents: Math.round((nowPrice * (0.9 + rnd() * 0.3)) / 10) * 10,
  }));
  points.push({ at: new Date(Date.now() - Math.floor(rnd() * 10 + 1) * DAY).toISOString(), price_cents: nowPrice });
  return { currency: o.currency, points };
});
route('GET', '/offers/:id/also-bought', ({ params }) => {
  const o = state.offers.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Listing not found');
  const live = state.offers.filter(listed).map(offerView).filter((x) => x.stock > 0 && x.id !== o.id);
  const rnd = seeded(`also:${o.id}`);
  const others = live.filter((x) => x.game !== o.game).sort(() => rnd() - 0.5).slice(0, 3).map((x) => ({ ...x, reason: 'also_bought' }));
  const same = live.filter((x) => x.game === o.game).slice(0, 6 - others.length).map((x) => ({ ...x, reason: 'same_game' }));
  return { items: [...others, ...same] };
});
route('GET', '/catalog/price-history', ({ query }) => {
  const game = query.get('game') ?? '';
  const category = query.get('category') ?? '';
  const days = Number(query.get('days') ?? 90);
  const prices = state.offers.filter(listed).map(offerView).filter((x) => x.stock > 0 && x.game.toLowerCase() === game.toLowerCase() && x.category_slug === category).map((x) => x.price_cents).sort((a, b) => a - b);
  if (!prices.length) return { currency: 'USD', points: [] };
  const rnd = seeded(`market:${game}:${category}`);
  const low = prices[0]!;
  const median = prices[Math.floor(prices.length / 2)]!;
  let drift = 1.15;
  const points = Array.from({ length: days }, (_, i) => {
    drift = Math.max(0.95, drift - 0.0017 + (rnd() - 0.5) * 0.02); // prices ease down over the quarter
    const last = i === days - 1;
    const m = last ? median : Math.round(median * drift);
    return { day: new Date(Date.now() - (days - 1 - i) * DAY).toISOString().slice(0, 10), min_cents: last ? low : Math.min(m, Math.round(low * (drift + (rnd() - 0.5) * 0.04))), median_cents: m, listings: prices.length };
  });
  return { currency: 'USD', points };
});

// --- Orders ----------------------------------------------------------------------------
function assertTosVersion(v: unknown) {
  if (!v) fail(400, 'tos_version_required', 'Reload the page to see the current Terms, then try again');
  if (v !== TOS_VERSION) fail(409, 'terms_stale', 'The Terms were updated while you were on this page. Reload to see the current version');
}
route('POST', '/orders', ({ me, body }) => {
  const u = need(me);
  assertTosVersion(body.tosVersion); // Round 23e: the Terms version loaded with the page is required
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email first.');
  const offer = state.offers.find((x) => x.id === body.offerId && (!x.reserved_for || x.reserved_for === u.id)) ?? fail(404, 'not_found', 'Listing not found');
  if (offer.seller_id === u.id) fail(400, 'own_listing', 'You can’t buy your own listing');
  const qty = Number(body.quantity ?? 1);
  const unit = offer as { min_qty?: number; unit_label?: string };
  if (unit.min_qty && qty < unit.min_qty) fail(400, 'below_min_qty', `The minimum for this offer is ${unit.min_qty} ${unit.unit_label ?? ''}`.trim());
  if ((offer as any).max_qty && qty > (offer as any).max_qty) fail(400, 'above_max_qty', `The maximum per order for this offer is ${(offer as any).max_qty}`);
  const available = availableOf(offer);
  if (available < qty) fail(409, 'out_of_stock', 'Not enough stock for this order');
  const code = body.sellerCode ? sellerCodeQuote(offer, u, qty, body.sellerCode) : null;
  // Round 24: the buyer picks one of the listing's delivery methods and fills only its fields (as the API does).
  const choice = deliveryChoiceFor(offer, body);
  const o = createOrderRecord(u, offer, qty, body.rail ?? 'fiat', code?.discount ?? 0);
  applyDeliveryChoice(u, offer, o, choice, body.saveInfo);
  if (code) Object.assign(o, { seller_code_id: code.c.id, seller_discount_cents: code.discount });
  if (body.useCredit && o.rail === 'fiat') applyCredit(u, o);
  return { order: orderDetail(o), checkoutUrl: o.rail === 'fiat' && o.charged_cents > 0 ? `/orders/${o.id}?pay=crypto` : null };
});
// --- Crypto checkout (demo): coins, a fake address, and a payment that confirms itself ------------
const DEMO_COINS = [
  ['usdttrc20', 'Tether (TRC-20)', 1], ['usdtbsc', 'Tether (BEP-20)', 1], ['usdterc20', 'Tether (ERC-20)', 8], ['usdcmatic', 'USD Coin (Polygon)', 1],
  ['btc', 'Bitcoin', 6], ['eth', 'Ethereum', 10], ['ltc', 'Litecoin', 2],
  ['trx', 'TRON', 1], ['sol', 'Solana', 2], ['doge', 'Dogecoin', 3], ['xmr', 'Monero', 15], ['ton', 'Toncoin', 2],
] as const;
/** Network each coin travels on, and the network fee the buyer pays on top (estimates, USD cents). */
const DEMO_NETWORK: Record<string, [string, number]> = {
  usdttrc20: ['TRC-20', 100], usdtbsc: ['BEP-20', 30], usdterc20: ['ERC-20', 350], usdcmatic: ['Polygon', 10], btc: ['Bitcoin', 150], eth: ['Ethereum', 200],
  ltc: ['Litecoin', 5], trx: ['TRON', 30], sol: ['Solana', 2], doge: ['Dogecoin', 10], xmr: ['Monero', 5], ton: ['TON', 5],
};
const DEMO_RATE: Record<string, number> = { usdttrc20: 1, usdtbsc: 1, usdcmatic: 1, usdterc20: 1, btc: 97_000, eth: 3_400, ltc: 95, trx: 0.24, sol: 190, doge: 0.33, xmr: 160, ton: 5.4 };
const coinNameOf = (c: string) => DEMO_COINS.find((x) => x[0] === c)?.[1] ?? c.toUpperCase();
/** Round 25b: an order inside a cart is quoted and paid through its checkout only. */
const notInCart = (p: { kind: string; orders: any[] }) => {
  if (p.kind === 'orders' && p.orders[0]?.checkout_id) fail(409, 'use_checkout', 'This order is part of a cart; pay for it from the cart checkout', { checkoutId: p.orders[0].checkout_id });
};
function payableOf(u: DemoUser, kind: 'orders' | 'checkouts', id: string) {
  if (kind === 'orders') {
    const o = orderFor(u, id);
    return { kind, id, orders: [o], owed: o.charged_cents ?? o.amount_cents, status: o.status };
  }
  const c = state.checkouts.find((x) => x.id === id && x.buyer_id === u.id) ?? fail(404, 'not_found', 'Checkout not found');
  const orders = c.order_ids.map((oid: string) => state.orders.find((o) => o.id === oid)!);
  return { kind, id, orders, owed: orders.reduce((s: number, o: any) => s + (o.charged_cents ?? o.amount_cents), 0), status: orders.every((o: any) => o.status !== 'awaiting_payment') ? 'paid' : 'awaiting_payment' };
}
const paymentsOf = (kind: string, id: string) => state.cryptoPayments.filter((p) => p.ref_kind === kind && p.ref_id === id);
const paidSoFar = (kind: string, id: string) => paymentsOf(kind, id).reduce((s, p) => s + (['partially_paid', 'finished'].includes(p.status) ? Math.round(Number(p.actually_paid_usd) * 100) : 0), 0);
/** Orders a payment pays for. */
const ordersOfPayment = (p: any) => (p.ref_kind === 'orders' ? state.orders.filter((o) => o.id === p.ref_id) : state.orders.filter((o) => (state.checkouts.find((c) => c.id === p.ref_id)?.order_ids ?? []).includes(o.id)));
/**
 * Round 26 (A2): one clear state per payment for the buyer, plus the order's status. "finished" with the order not
 * funded yet is received_applying (the page keeps checking); held / credited come from staff or the provider.
 */
function paymentState(p: any): string {
  if (p.state_override) return p.state_override;
  const orders = ordersOfPayment(p);
  const funded = orders.length > 0 && orders.every((o) => o.status !== 'awaiting_payment');
  if (p.status === 'waiting' || p.status === 'confirming' || p.status === 'confirmed' || p.status === 'sending') return p.status === 'waiting' ? 'waiting' : 'confirming';
  if (p.status === 'partially_paid') return 'underpaid';
  if (p.status === 'finished') return funded ? 'paid' : 'received_applying';
  if (p.status === 'failed' || p.status === 'refunded') return 'failed';
  if (p.status === 'expired') return 'expired';
  return p.status;
}
const view = (p: any) => ({ ...p, state: paymentState(p), order_status: ordersOfPayment(p)[0]?.status ?? null, pay_currency_name: coinNameOf(p.pay_currency), ref_kind: undefined, ref_id: undefined, finish_at: undefined, apply_at: undefined, state_override: undefined });
/**
 * Demo switch for the payment outcome after "finished": localStorage bz.demo.cryptoOutcome =
 * "slow" (funded a few seconds later), "held" (held for review), "credited" (added to the balance),
 * "failed" or "expired". Unset: funded at once.
 */
const demoOutcome = () => {
  try {
    return localStorage.getItem('bz.demo.cryptoOutcome') ?? '';
  } catch {
    return '';
  }
};
/** Demo switch for testing the error path: localStorage bz.demo.cryptoDown = "1" makes the provider "down". */
const providerDown = () => {
  let down = false;
  try {
    down = localStorage.getItem('bz.demo.cryptoDown') === '1';
  } catch {
    /* storage blocked: the provider is up */
  }
  if (down) fail(503, 'payment_provider_unavailable', 'Crypto payments are unavailable right now. Try again in a few minutes.', { retryable: true });
};
/** Round 25 (B6): lock the price in `currency` for 15 minutes on the payable's orders; fresh = a new quote. */
function lockFx(p: ReturnType<typeof payableOf>, currency: string) {
  const first = p.orders[0];
  const live = first.presentment_currency === currency && first.fx_locked_at && Date.now() - Date.parse(first.fx_locked_at) < FX_TTL_MS;
  const rate = currency === 'USD' ? 1 : RATES[currency]!;
  if (!live) for (const o of p.orders) Object.assign(o, { presentment_currency: currency, fx_rate: rate, presentment_amount_cents: Math.round((o.charged_cents ?? o.amount_cents) * rate), fx_locked_at: now() });
  const amountCents = p.orders.reduce((s: number, o: any) => s + o.presentment_amount_cents, 0);
  save();
  return { currency, rate: rate.toFixed(8), amountCents, usdCents: p.owed, lockedUntil: new Date(Date.parse(first.fx_locked_at) + FX_TTL_MS).toISOString(), fresh: !live };
}
for (const kind of ['orders', 'checkouts'] as const) {
  route('POST', `/${kind}/:id/fx-quote`, ({ me, params, body }) => {
    const p = payableOf(need(me), kind, params[0]!);
    notInCart(p);
    const cur = String(body.currency ?? '').toUpperCase();
    if (!['USD', 'EUR'].includes(cur)) fail(400, 'unsupported_currency', 'Crypto payments are priced in USD or EUR');
    return lockFx(p, cur);
  });
  route('GET', `/${kind}/:id/crypto/coins`, ({ me, params }) => {
    providerDown();
    const p = payableOf(need(me), kind, params[0]!);
    const owed = p.owed - paidSoFar(kind, p.id);
    const coins = DEMO_COINS.map(([coin, name, minUsd]) => ({ coin, name, minUsd, available: minUsd * 100 <= owed, network: DEMO_NETWORK[coin]![0], fee_cents: DEMO_NETWORK[coin]![1], total_cents: owed + DEMO_NETWORK[coin]![1] }));
    return { owedCents: owed, currency: 'USD', coins: coins.sort((a, b) => Number(b.available) - Number(a.available) || a.coin.localeCompare(b.coin)) };
  });
  route('GET', `/${kind}/:id/crypto/payments`, ({ me, params }) => paymentsOf(kind, payableOf(need(me), kind, params[0]!).id).map(view));
  route('POST', `/${kind}/:id/crypto/pay`, ({ me, params, body }) => {
    const p = payableOf(need(me), kind, params[0]!);
    if (p.status !== 'awaiting_payment') fail(409, 'invalid_state', 'This order is already paid');
    notInCart(p);
    if (paymentsOf(kind, p.id).some((x) => x.status === 'waiting')) fail(409, 'payment_open', 'A payment is already waiting for your transfer');
    providerDown();
    const owed = p.owed - paidSoFar(kind, p.id);
    const coin = String(body.coin);
    // Round 25 (B5): the invoice is in USD or EUR; EUR uses the locked quote (409 with a new one when it lapsed).
    const priceCurrency = String(body.priceCurrency ?? 'USD').toUpperCase();
    if (!['USD', 'EUR'].includes(priceCurrency)) fail(400, 'unsupported_currency', 'Crypto payments are priced in USD or EUR');
    let price = { currency: 'USD', amountCents: owed, rate: 1 };
    if (priceCurrency !== 'USD') {
      const q = lockFx(p, priceCurrency);
      if (q.fresh) fail(409, 'fx_quote_expired', `The ${priceCurrency} price was refreshed; check it and pay again`, { currency: q.currency, rate: q.rate, amountCents: q.amountCents, usdCents: p.owed, lockedUntil: q.lockedUntil });
      price = { currency: priceCurrency, amountCents: owed === p.owed ? q.amountCents : Math.ceil(owed * Number(q.rate)), rate: Number(q.rate) };
    }
    if (!DEMO_COINS.some(([c, , min]) => c === coin && min * 100 <= owed)) fail(400, 'coin_unavailable', `${coinNameOf(coin)} can’t be used for this amount`);
    // The buyer sends the order amount plus the coin's network fee; only the order amount counts toward the order.
    const fee = DEMO_NETWORK[coin]?.[1] ?? 0;
    const amount = (owed + fee) / 100 / (DEMO_RATE[coin] ?? 1);
    const pay = {
      id: rid(), ref_kind: kind, ref_id: p.id, payment_id: String(5_000_000 + state.cryptoPayments.length), pay_currency: coin, pay_address: `${coin === 'btc' ? 'bc1q' : coin === 'eth' || coin.endsWith('erc20') ? '0x' : 'T'}demo${rid().replace(/-/g, '').slice(0, 28)}`,
      pay_extra_id: null, pay_amount: amount.toFixed(coin.startsWith('usd') ? 2 : 8), price_usd: (owed / 100).toFixed(2), fee_usd: (fee / 100).toFixed(2), actually_paid: '0', actually_paid_usd: null as string | null, status: 'waiting',
      expires_at: new Date(Date.now() + 20 * 60_000).toISOString(), created_at: now(), finish_at: Date.now() + 1_500, // the demo "network" confirms after a moment
      price_currency: price.currency, price_amount: (price.amountCents / 100).toFixed(2), fx_rate: price.rate.toFixed(8),
    };
    state.cryptoPayments.push(pay);
    save();
    return view(pay);
  });
  route('POST', `/${kind}/:id/crypto/payments/:pid/refresh`, ({ me, params }) => {
    const p = payableOf(need(me), kind, params[0]!);
    const pay = paymentsOf(kind, p.id).find((x) => x.payment_id === params[1]) ?? fail(404, 'not_found', 'Payment not found');
    if (pay.status === 'waiting' && Date.now() >= pay.finish_at) {
      const outcome = demoOutcome();
      if (outcome === 'failed' || outcome === 'expired') pay.status = outcome;
      else {
        pay.status = 'finished';
        pay.actually_paid = pay.pay_amount;
        pay.actually_paid_usd = pay.price_usd;
        if (outcome === 'held') pay.state_override = 'held_for_review';
        else if (outcome === 'credited') {
          pay.state_override = 'credited_to_balance';
          const u = userById(p.orders[0].buyer_id)!;
          state.credit[u.id] = (state.credit[u.id] ?? 0) + Math.round(Number(pay.price_usd) * 100);
        } else if (outcome === 'slow') pay.apply_at = Date.now() + 4_000;
        else for (const o of p.orders) payDemoOrder(o.id);
      }
      save();
    } else if (pay.status === 'finished' && pay.apply_at && Date.now() >= pay.apply_at) {
      pay.apply_at = null;
      for (const o of p.orders) payDemoOrder(o.id);
      save();
    }
    return paymentsOf(kind, p.id).map(view);
  });
}
// Round 26 (A3): staff list of crypto payments, with a re-check that asks the provider again and re-applies.
const staffPaymentView = (p: any) => {
  const o = ordersOfPayment(p)[0];
  return {
    id: p.id, payment_id: p.payment_id, order_id: p.ref_kind === 'orders' ? p.ref_id : null, checkout_id: p.ref_kind === 'checkouts' ? p.ref_id : null, order_ref: o?.ref ?? null,
    buyer_name: o ? userById(o.buyer_id)?.display_name ?? null : null, status: p.status, state: paymentState(p), order_status: o?.status ?? null,
    pay_currency: p.pay_currency, pay_amount: p.pay_amount, actually_paid: p.actually_paid, price_amount: p.price_amount ?? p.price_usd, price_currency: p.price_currency ?? 'USD',
    outcome_amount: p.status === 'finished' ? p.actually_paid : null, outcome_currency: p.status === 'finished' ? 'usdtbsc' : null, review_reason: p.state_override === 'held_for_review' ? 'amount_mismatch' : null,
    applied_cents: paymentState(p) === 'paid' ? Math.round(Number(p.price_usd) * 100) : 0, credited_cents: p.state_override === 'credited_to_balance' ? Math.round(Number(p.price_usd) * 100) : 0,
    last_ipn_at: p.status === 'waiting' ? null : p.last_ipn_at ?? p.created_at, created_at: p.created_at,
  };
};
route('GET', '/admin/crypto/payments', ({ me, query }) => {
  needStaff(me);
  const st = query.get('state');
  return state.cryptoPayments.map(staffPaymentView).filter((x) => !st || x.state === st).sort((a, b) => b.created_at.localeCompare(a.created_at));
});
route('POST', '/admin/crypto/payments/:id/recheck', ({ me, params }) => {
  const staff = needStaff(me);
  const p = state.cryptoPayments.find((x) => x.id === params[0] || x.payment_id === params[0]) ?? fail(404, 'not_found', 'Payment not found');
  // The provider says it is finished: apply it to the order if it isn't yet (held stays held for a person).
  if (p.status === 'waiting' && Date.now() >= p.finish_at) Object.assign(p, { status: 'finished', actually_paid: p.pay_amount, actually_paid_usd: p.price_usd });
  if (p.status === 'finished' && !p.state_override) for (const o of ordersOfPayment(p)) if (o.status === 'awaiting_payment') payDemoOrder(o.id);
  p.apply_at = null;
  p.last_ipn_at = now();
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: staff.display_name, actor_role: staff.role, ip: '203.0.113.7', action: 'crypto.payment.recheck', target_type: 'crypto_payment', target_id: p.payment_id, details: { status: p.status } });
  return staffPaymentView(p);
});
// Wallet for every account: balance plus one history of orders, refunds and withdrawals.
route('GET', '/me/wallet', ({ me }) => {
  const u = need(me);
  const st = (o: any, seller: boolean) => (o.status === 'completed' ? 'completed' : ['refunded', 'cancelled', 'charged_back'].includes(o.status) ? (seller ? 'cancelled' : 'completed') : o.status === 'awaiting_payment' ? 'pending' : 'held');
  const entries = [
    ...state.orders.filter((o) => o.buyer_id === u.id && o.status !== 'awaiting_payment' && o.status !== 'cancelled').flatMap((o) => [
      { id: `b-${o.id}`, at: o.created_at, kind: 'order', ref: o.ref, order_id: o.id, title: o.offer_title, status: st(o, false), amount_cents: -(o.amount_cents), currency: o.currency },
      ...(o.status === 'refunded' ? [{ id: `r-${o.id}`, at: o.updated_at ?? o.created_at, kind: 'refund', ref: o.ref, order_id: o.id, title: o.offer_title, status: 'completed', amount_cents: o.amount_cents, currency: o.currency }] : []),
    ]),
    ...state.orders.filter((o) => o.seller_id === u.id && o.status !== 'awaiting_payment' && o.status !== 'cancelled').map((o) => ({ id: `s-${o.id}`, at: o.created_at, kind: 'sale', ref: o.ref, order_id: o.id, title: o.offer_title, status: st(o, true), amount_cents: o.seller_net_cents, currency: o.currency })),
    ...state.withdrawals.filter((w) => w.user_id === u.id).map((w) => ({ id: w.id, at: w.created_at, kind: 'withdrawal', ref: `#${String(w.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`, address: w.destination_address, coin: w.destination_currency, status: w.status === 'paid' ? 'completed' : ['failed', 'rejected'].includes(w.status) ? 'cancelled' : 'pending', amount_cents: -Number(w.amount_cents), currency: w.currency })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const sellerAvail = u.role === 'user' && state.balances[u.id] ? holdOf(u.id).withdrawableCents : 0;
  return { balances: { USD: (state.credit[u.id] ?? 0) + sellerAvail }, credit_cents: state.credit[u.id] ?? 0, entries };
});
route('POST', '/me/withdrawals', ({ me, body }) => {
  const u = need(me);
  const credit = state.credit[u.id] ?? 0;
  const cents = Number(body.amountCents);
  if (!(cents > 0) || cents > credit) fail(400, 'insufficient_funds', `You can withdraw up to ${(credit / 100).toFixed(2)} USD`);
  if (!String(body.address ?? '').trim()) fail(400, 'validation_error', 'Add the address to send it to');
  const fee = feeFor(cents);
  if (cents - fee <= 0) fail(400, 'amount_too_small', 'The fee would take the whole amount');
  state.credit[u.id] = credit - cents;
  const w = { id: rid(), user_id: u.id, amount_cents: cents, fee_cents: fee, net_cents: cents - fee, currency: 'USD', status: 'pending_approval', destination_address: String(body.address).trim(), destination_currency: String(body.coin ?? 'usdttrc20'), provider_ref: null as string | null, payout_id: null as string | null, tx_hash: null as string | null, created_at: now(), updated_at: now() };
  state.withdrawals.push(w);
  save();
  return w;
});
// Refunds on crypto orders are sent by hand: the buyer gives an address, the treasury records the transaction.
function queueCryptoRefund(o: any, reason: string) {
  if (o.payment_provider !== 'nowpayments' || state.cryptoRefunds.some((r) => r.order_id === o.id && r.status !== 'cancelled')) return;
  state.cryptoRefunds.push({ id: rid(), order_id: o.id, amount_cents: o.amount_cents, currency: 'USD', reason, refund_address: null, refund_currency: null, status: 'awaiting_address', tx_hash: null, created_at: now(), updated_at: now() });
  notify(o.buyer_id, 'orders', 'refund.address', 'Where should we send your refund?', `${o.offer_title}: give us a wallet address on the order page.`, `/orders/${o.id}`);
}
const refundOf = (orderId: string) => state.cryptoRefunds.find((r) => r.order_id === orderId && r.status !== 'cancelled') ?? null;
route('PUT', '/orders/:id/refund-address', ({ me, params, body }) => {
  const o = orderFor(need(me), params[0]!);
  const r = refundOf(o.id) ?? fail(404, 'not_found', 'Refund not found');
  if (r.status === 'sent') fail(409, 'already_sent', 'This refund was already sent');
  Object.assign(r, { refund_address: String(body.address).trim(), refund_currency: String(body.currency).toLowerCase(), status: 'pending', updated_at: now() });
  live(appendMessage(o.room_id, null, 'system', `The buyer gave a ${coinNameOf(r.refund_currency)} address for the refund; the treasury sends it within three working days.`, [], { code: 'refund_address_given', params: { coin: coinNameOf(r.refund_currency) } }));
  save();
  return r;
});
route('GET', '/admin/crypto/refunds', ({ me, query }) => {
  needPerm(me, 'treasury.request');
  const st = query.get('status');
  return state.cryptoRefunds.filter((r) => !st || r.status === st).map((r) => {
    const o = state.orders.find((x) => x.id === r.order_id)!;
    const b = userById(o.buyer_id);
    return { ...r, buyer_email: b?.email, buyer_name: b?.display_name };
  });
});
route('POST', '/admin/crypto/refunds/:id/sent', ({ me, params, body }) => {
  needPerm(me, 'treasury.approve');
  const r = state.cryptoRefunds.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Refund not found');
  if (r.status !== 'pending') fail(409, 'invalid_state', `This refund is ${r.status}`);
  Object.assign(r, { status: 'sent', tx_hash: String(body.txHash).trim(), updated_at: now() });
  const o = state.orders.find((x) => x.id === r.order_id)!;
  notify(o.buyer_id, 'orders', 'refund.sent', 'Refund sent', `$${(r.amount_cents / 100).toFixed(2)} is on its way. Transaction ${r.tx_hash}.`, `/orders/${o.id}`);
  save();
  return r;
});

// --- Crypto payouts (demo): the address confirms at once, withdrawals wait for the CFO -----------
const PAYOUT_COINS = ['usdttrc20', 'usdtbsc']; // USDT only at launch (CEO, Oct 24): TRC-20 and BEP-20
const payoutAddressView = (u: DemoUser) => ({
  address: u.payout_address ?? null, currency: u.payout_address_currency ?? null, currencyName: u.payout_address_currency ? coinNameOf(u.payout_address_currency) : null, setAt: u.payout_address_set_at ?? null, pending: null,
  coins: PAYOUT_COINS.map((coin) => ({ coin, name: coinNameOf(coin) })),
});
route('GET', '/seller/payout-address', ({ me }) => payoutAddressView(need(me)));
route('POST', '/seller/payout-address', ({ me, body }) => {
  const u = need(me);
  const currency = String(body.currency).toLowerCase();
  if (!PAYOUT_COINS.includes(currency)) fail(400, 'unsupported_coin', 'That coin is not supported for payouts');
  if (!/^[A-Za-z0-9:_-]{10,128}$/.test(String(body.address).trim())) fail(400, 'invalid_address', 'That does not look like a wallet address');
  // The real site sends an email link (and asks for the 2FA code); the demo confirms at once.
  Object.assign(u, { payout_address: String(body.address).trim(), payout_address_currency: currency, payout_address_set_at: now(), payouts_enabled: true });
  save();
  return payoutAddressView(u);
});
route('POST', '/seller/payout-address/confirm', ({ me }) => payoutAddressView(need(me)));
route('DELETE', '/seller/payout-address', ({ me }) => {
  const u = need(me);
  Object.assign(u, { payout_address: null, payout_address_currency: null, payout_address_set_at: null, payouts_enabled: false });
  save();
  return payoutAddressView(u);
});
const WITHDRAWAL_FEE_BPS = 600;
const WITHDRAWAL_FEE_MIN = 150;
const feeFor = (cents: number) => Math.min(cents, Math.max(WITHDRAWAL_FEE_MIN, Math.ceil((cents * WITHDRAWAL_FEE_BPS) / 10_000)));
route('GET', '/ranks', () => ({ ranks: RANKS, settings: PROMO }));
route('GET', '/tiers', () => RANKS.map((r) => ({ ...asTier(r), rate: r.rateBps / 100, accountRate: r.rateBps / 100, otherRate: r.rateBps / 100, promo: PROMO })));
route('GET', '/admin/ranks', ({ me }) => (needPerm(me, 'ranks.manage'), { ranks: RANKS, settings: PROMO }));
route('PUT', '/admin/ranks', ({ me, body }) => {
  needPerm(me, 'ranks.manage');
  const ranks = [...(body.ranks ?? [])].sort((a: any, b: any) => a.position - b.position);
  if (ranks.length !== 5 || ranks.some((r: any, i: number) => r.position !== i + 1)) fail(400, 'invalid_ranks', 'Send all five ranks, positions 1 to 5');
  if (ranks[0].minMonthlySalesCents !== 0) fail(400, 'invalid_ranks', 'The first rank starts at 0');
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i].minMonthlySalesCents <= ranks[i - 1].minMonthlySalesCents) fail(400, 'invalid_ranks', 'Thresholds must increase with each rank');
    if (ranks[i].rateBps > ranks[i - 1].rateBps) fail(400, 'invalid_ranks', 'Rates must not rise with rank');
  }
  ranks.forEach((r: any, i: number) => Object.assign(RANKS[i]!, { name: String(r.name).trim(), minMonthlySalesCents: Number(r.minMonthlySalesCents), rateBps: Number(r.rateBps), perks: r.perks ?? [] }));
  if (body.settings) Object.assign(PROMO, { promoRateBps: body.settings.promoRateBps ?? PROMO.promoRateBps, promoDays: body.settings.promoDays ?? PROMO.promoDays });
  return { ranks: RANKS, settings: PROMO };
});
/** Sell form preview: what buyers pay (in each currency) and what the seller keeps after the withdrawal fee. */
route('GET', '/seller/price-preview', ({ me, query }) => {
  const u = needSeller(me);
  const sellerCents = Number(query.get('priceCents'));
  if (!(sellerCents > 0)) fail(400, 'validation_error', 'priceCents must be positive');
  const listingCurrency = (query.get('currency') ?? 'USD').toUpperCase();
  const settlementCents = Math.round(sellerCents / (RATES[listingCurrency] ?? 1));
  const t = tierOf(u.id);
  const buyer = grossUp(settlementCents, t.rateBps);
  const fee = feeFor(settlementCents);
  const buyerIn = Object.fromEntries(Object.entries(RATES).map(([c, r]) => [c, Math.round(buyer * (c === 'USD' ? 1 : r * 1.01))]));
  return { sellerCents, listingCurrency, settlementCurrency: 'USD', settlementCents, rateBps: t.rateBps, promo: t.promo, rank: t.rank.name, buyerCents: buyer, buyerIn, commissionCents: buyer - settlementCents, withdrawalFeeBps: WITHDRAWAL_FEE_BPS, withdrawalFeeCents: fee, afterWithdrawalCents: settlementCents - fee };
});
// Buyer credit (the demo seeds none; a kept underpayment would land here). Tests top it up through
// window.__bzDemo.credit(cents) for the signed-in user.
if (typeof window !== 'undefined') {
  (window as any).__bzDemo = {
    credit(cents: number) {
      const token = localStorage.getItem('mkt.token') ?? '';
      const u = token.startsWith('demo:') ? userById(token.slice(5)) : null;
      if (!u) throw new Error('no session');
      state.credit[u.id] = (state.credit[u.id] ?? 0) + cents;
      save();
    },
  };
}
route('GET', '/me/credit', ({ me }) => {
  const u = need(me);
  const cents = state.credit[u.id] ?? 0;
  return { currency: 'USD', balanceCents: cents, availableCents: cents, history: [] };
});
route('POST', '/me/credit/withdraw', ({ me, body }) => {
  const u = need(me);
  const amount = Number(body.amountCents);
  if (!u.payout_address) fail(400, 'no_payout_address', 'Add and confirm a payout address first');
  if (!(amount > 0) || amount > (state.credit[u.id] ?? 0)) fail(400, 'insufficient_funds', `Available credit is ${state.credit[u.id] ?? 0} cents`);
  const fee = feeFor(amount);
  state.credit[u.id] = (state.credit[u.id] ?? 0) - amount;
  const w = { id: rid(), user_id: u.id, amount_cents: amount, currency: 'USD', status: 'pending_approval', fee_cents: fee, net_cents: amount - fee, destination_address: u.payout_address, destination_currency: u.payout_address_currency, source: 'credit', created_at: now(), updated_at: now() };
  state.withdrawals.unshift(w);
  save();
  return w;
});
route('GET', '/seller/withdrawals/quote', ({ query }) => {
  const raw = (query.get('amountCents') ?? '').trim();
  const amountCents = /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  if (!(amountCents > 0)) fail(400, 'amount_required', 'Enter an amount to see the fee'); // Round 24, as the API
  const fee = feeFor(amountCents);
  return { amountCents, feeCents: fee, netCents: amountCents - fee, feeBps: WITHDRAWAL_FEE_BPS, feeMinCents: WITHDRAWAL_FEE_MIN };
});
route('GET', '/seller/withdrawals', ({ me }) => state.withdrawals.filter((w) => w.user_id === need(me).id).sort((a, b) => b.created_at.localeCompare(a.created_at)));
route('GET', '/admin/withdrawals', ({ me }) => {
  // Finance, or the Support Lead who co-signs the large ones (Round 22).
  if (!(me && permsOf(me).has('withdrawals.second_approve'))) needPerm(me, 'treasury.request');
  return state.withdrawals.filter((w) => ['pending_approval', 'processing', 'unknown'].includes(w.status)).map((w) => {
    const u = userById(w.user_id);
    return { ...w, email: u?.email, display_name: u?.display_name, kyc_tier: u?.kyc_tier, trust_level: state.trust[w.user_id] ?? 'new' };
  });
});
route('POST', '/admin/withdrawals/:id/decide', ({ me, params, body }) => {
  const staff = needPerm(me, 'treasury.approve');
  const w = state.withdrawals.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Withdrawal not found');
  if (w.user_id === staff.id) fail(403, 'own_withdrawal', 'You cannot decide your own withdrawal');
  if (w.status !== 'pending_approval') fail(409, 'invalid_state', `This withdrawal is ${w.status}`);
  // Round 22b: a coin we no longer pay out in is rejected, money back.
  if (body.approve && !PAYOUT_COINS.includes(w.destination_currency)) {
    Object.assign(w, { status: 'rejected', decided_at: now(), decision_note: 'unsupported_coin', refused: 'unsupported_coin' });
    state.balances[w.user_id] = (state.balances[w.user_id] ?? 0) + w.amount_cents;
    save();
    return w;
  }
  if (body.approve) {
    Object.assign(w, { status: 'processing', decided_at: now(), decision_note: body.note ?? null, provider_ref: `batch_${rid().slice(0, 8)}`, payout_id: String(7_000_000 + state.withdrawals.length) });
    state.platform.treasury += w.fee_cents;
    setTimeout(() => {
      Object.assign(w, { status: 'paid', tx_hash: `0x${rid().replace(/-/g, '')}`, updated_at: now() });
      notify(w.user_id, 'selling', 'payout.paid', 'Payout sent', `$${(w.net_cents / 100).toFixed(2)} in ${coinNameOf(w.destination_currency)} is on its way to your wallet.`, '/sell/money');
      save();
    }, 3_000);
  } else {
    Object.assign(w, { status: 'rejected', decided_at: now(), decision_note: body.note ?? null });
    state.balances[w.user_id] = (state.balances[w.user_id] ?? 0) + w.amount_cents;
    notify(w.user_id, 'selling', 'payout.failed', 'Withdrawal not approved', `$${(w.amount_cents / 100).toFixed(2)} is back in your balance${body.note ? `: ${body.note}` : '.'}`, '/sell/money');
  }
  save();
  return w;
});

// --- Release rule (demo): staff release 24h+ after delivery; seller follow-up opens a ticket ------
const RELEASE_AFTER_H = 24;
route('GET', '/admin/orders/unconfirmed', ({ me }) => {
  needPerm(me, 'orders.release');
  return state.orders
    .filter((o) => o.status === 'delivered' && o.rail === 'fiat' && !o.escrow_frozen && o.delivered_at && Date.now() - new Date(o.delivered_at).getTime() >= RELEASE_AFTER_H * 3_600_000)
    .map((o) => ({
      id: o.id, buyer_id: o.buyer_id, seller_id: o.seller_id, amount_cents: o.amount_cents, currency: o.currency, delivered_at: o.delivered_at, protection: o.protection, protection_ends_at: o.protection_ends_at,
      title: o.offer_title, game: o.game, buyer_name: userById(o.buyer_id)?.display_name, seller_name: userById(o.seller_id)?.display_name,
      open_tickets: state.tickets.filter((t) => t.order_id === o.id && t.status !== 'resolved').length,
      buyer_last_message_at: state.messages.filter((m) => m.room_id === o.room_id && m.sender_id === o.buyer_id).map((m) => m.created_at).sort().at(-1) ?? null,
    }))
    .sort((a, b) => a.delivered_at.localeCompare(b.delivered_at));
});
route('POST', '/admin/orders/:id/release', ({ me, params, body }) => {
  const staff = needPerm(me, 'orders.release');
  const o = state.orders.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Order not found');
  if (o.amount_cents > 200_00) needPerm(me, 'orders.lead'); // above $200: the Support Lead releases
  if (o.status !== 'delivered') fail(409, 'invalid_state', `Cannot release an order that is ${o.status}`);
  if (o.escrow_frozen) fail(423, 'under_review', 'Order is under security review');
  if (Date.now() - new Date(o.delivered_at).getTime() < RELEASE_AFTER_H * 3_600_000) fail(409, 'too_early', `Staff can release this order ${RELEASE_AFTER_H} hours after delivery`);
  if (o.checklist && !o.checklist.completed_at) fail(409, 'checklist_incomplete', 'The buyer has not finished the Security Changeover checklist');
  o.released_by = staff.id;
  o.release_note = String(body.note ?? '');
  releaseOrder(o, 'staff_released');
  live(appendMessage(o.room_id, null, 'system', `Support released the payment to the seller after reviewing the delivery: ${o.release_note}`, [], { code: 'staff_released', params: { note: o.release_note } }));
  save();
  return { id: o.id, status: 'completed' };
});
route('POST', '/orders/:id/follow-up', ({ me, params, body }) => {
  const u = need(me);
  const o = state.orders.find((x) => x.id === params[0] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Order not found');
  if (o.status !== 'delivered') fail(409, 'invalid_state', `This order is ${o.status}`);
  const since = Date.now() - new Date(o.delivered_at).getTime();
  if (since < RELEASE_AFTER_H * 3_600_000) fail(409, 'too_early', `You can ask for a release ${RELEASE_AFTER_H} hours after delivery`);
  if (state.tickets.some((t) => t.order_id === o.id && t.user_id === u.id && t.status !== 'resolved')) fail(409, 'already_open', 'You already have an open request on this order');
  const t = createTicketRecord(u, { category: 'order', subject: `Release request: ${o.offer_title}`, orderId: o.id, body: `Delivered ${Math.floor(since / 3_600_000)} hours ago and the buyer has not confirmed. Please review the delivery proof in the order chat and release the payment.${body?.message ? `\n\n${body.message}` : ''}` });
  live(appendMessage(o.room_id, null, 'system', 'The seller asked support to review the delivery and release the payment.', [], { code: 'follow_up' }));
  return { ticketId: t.id };
});

// --- Seller-funded discounts: sales and codes ---------------------------------------------
function sellerCodeQuote(offer: any, buyer: DemoUser, qty: number, text: string) {
  const c = state.sellerCodes.find((x) => x.seller_id === offer.seller_id && x.code.toLowerCase() === String(text).trim().toLowerCase());
  if (!c || !c.active) fail(400, 'code_invalid', 'That code isn’t valid for this seller');
  if (c!.ends_at && c!.ends_at <= now()) fail(400, 'code_expired', 'That code has expired');
  const subtotal = unitPriceFor({ price_cents: effectivePrice(offer), price_tiers: offer.price_tiers }, qty) * qty;
  if (subtotal < c!.min_order_cents) fail(400, 'code_min_order', `This code needs an order of at least ${(c!.min_order_cents / 100).toFixed(2)}`);
  const used = state.orders.filter((o) => o.seller_code_id === c!.id && o.status !== 'cancelled');
  if (c!.max_uses != null && used.length >= c!.max_uses) fail(400, 'code_exhausted', 'This code has been fully used');
  if (used.filter((o) => o.buyer_id === buyer.id).length >= c!.per_buyer_limit) fail(400, 'code_used', 'You’ve already used this code');
  return { c: c!, discount: Math.floor((subtotal * c!.percent_off) / 100), subtotal };
}
route('POST', '/orders/quote', ({ me, body }) => {
  const u = need(me);
  const offer = state.offers.find((x) => x.id === body.offerId) ?? fail(404, 'not_found', 'Listing not found');
  const qty = Number(body.quantity ?? 1);
  const code = body.sellerCode ? sellerCodeQuote(offer, u, qty, body.sellerCode) : null;
  const priced = orderPrice(offer, qty);
  const sellerAmount = priced.sellerCents - (code?.discount ?? 0);
  const amount = gross(offer.seller_id, sellerAmount);
  if (priced.unitMicros != null && amount < MIN_CURRENCY_ORDER_USD_CENTS) fail(400, 'below_minimum_order', 'The smallest order is $1.00; add more units', { minCents: MIN_CURRENCY_ORDER_USD_CENTS, currency: 'USD' });
  return { listingCurrency: offer.currency, amountCents: amount, sellerAmountCents: sellerAmount, commissionBps: rateFor(offer), chargedCents: amount, sellerDiscountCents: code?.discount ?? 0, discountCents: 0, creditCents: 0, presentmentCurrency: offer.currency, presentmentAmountCents: amount, listingUnitPriceMicros: priced.listingUnitMicros, volumePercentOff: priced.pct, unitPriceMicros: priced.unitMicros };
});
const ownOffer = (me: DemoUser | null, id: string) => {
  const u = needSeller(me);
  return state.offers.find((x) => x.id === id && x.seller_id === u.id) ?? fail(404, 'not_found', 'Offer not found');
};
route('PUT', '/offers/:id/sale', ({ me, params, body }) => {
  const o = ownOffer(me, params[0]!);
  const starts = body.startsAt ?? now();
  if (!(body.salePriceCents < o.price_cents)) fail(400, 'invalid_sale', 'The sale price must be lower than the listing price');
  if (!body.endsAt || body.endsAt <= now() || body.endsAt <= starts) fail(400, 'invalid_sale', 'The sale must end in the future, after it starts');
  if (Date.parse(body.endsAt) - Date.parse(starts) > 30 * day) fail(400, 'invalid_sale', 'A sale can run for up to 30 days');
  Object.assign(o, { sale_price_cents: body.salePriceCents, sale_starts_at: starts, sale_ends_at: body.endsAt });
  return offerView(o);
});
route('DELETE', '/offers/:id/sale', ({ me, params }) => {
  const o = ownOffer(me, params[0]!);
  Object.assign(o, { sale_price_cents: null, sale_starts_at: null, sale_ends_at: null });
  return offerView(o);
});
const codeView = (c: any) => {
  const used = state.orders.filter((o) => o.seller_code_id === c.id && !['cancelled', 'awaiting_payment'].includes(o.status));
  return { ...c, uses: used.length + (c.uses_before ?? 0), discount_cents: used.reduce((s, o) => s + (o.seller_discount_cents ?? 0), 0) };
};
route('GET', '/seller/codes', ({ me }) => state.sellerCodes.filter((c) => c.seller_id === needSeller(me).id).map(codeView));
route('POST', '/seller/codes', ({ me, body }) => {
  const u = needSeller(me);
  const code = String(body.code ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,30}$/.test(code)) fail(400, 'validation_error', 'Codes are 3–30 letters, digits, - or _');
  if (!(body.percentOff >= 1 && body.percentOff <= 90)) fail(400, 'validation_error', 'Choose 1–90% off');
  if (state.sellerCodes.some((c) => c.seller_id === u.id && c.code.toLowerCase() === code.toLowerCase())) fail(409, 'code_taken', 'You already have a code with that name');
  const c = { id: rid(), seller_id: u.id, code, percent_off: body.percentOff, min_order_cents: body.minOrderCents ?? 0, max_uses: body.maxUses ?? null, per_buyer_limit: 1, starts_at: now(), ends_at: body.endsAt ?? null, active: true, created_at: now() };
  state.sellerCodes.unshift(c);
  return codeView(c);
});
route('PATCH', '/seller/codes/:id', ({ me, params, body }) => {
  const u = needSeller(me);
  const c = state.sellerCodes.find((x) => x.id === params[0] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Code not found');
  c.active = !!body.active;
  return codeView(c);
});
// Cart: one demo payment for several orders (one per listing, each in its own escrow).
route('POST', '/orders/cart', ({ me, body }) => {
  const u = need(me);
  assertTosVersion(body.tosVersion); // Round 23e: the Terms version loaded with the page is required
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email first.');
  const items: Array<{ offerId: string; quantity: number; characterName?: string }> = body.items ?? [];
  if (!items.length || items.length > 20) fail(400, 'invalid_cart', 'A cart holds 1 to 20 listings');
  if (new Set(items.map((i) => i.offerId)).size !== items.length) fail(400, 'invalid_cart', 'Each listing can appear once; change its quantity instead');
  // Check everything first so a cart either fully goes through or not at all.
  const lines = items.map((i) => {
    const offer = state.offers.find((x) => x.id === i.offerId && (!x.reserved_for || x.reserved_for === u.id) && x.status === 'active') ?? fail(404, 'not_found', 'Listing not found');
    if (offer.seller_id === u.id) fail(403, 'own_offer', 'You cannot buy your own offer');
    const qty = Number(i.quantity ?? 1);
    if (availableOf(offer) < qty) fail(409, 'out_of_stock', `Not enough stock for "${offer.title}"`);
    return { offer, qty, choice: deliveryChoiceFor(offer, i), saveInfo: (i as any).saveInfo };
  });
  const checkout = { id: `cart-${rid().slice(0, 8)}`, buyer_id: u.id, order_ids: lines.map(({ offer, qty, choice, saveInfo }) => {
    const o = createOrderRecord(u, offer, qty, 'fiat');
    applyDeliveryChoice(u, offer, o, choice, saveInfo);
    return o.id;
  }), created_at: now() };
  for (const id of checkout.order_ids) {
    const o = state.orders.find((x) => x.id === id)!;
    o.checkout_id = checkout.id;
    if (body.useCredit) applyCredit(u, o);
  }
  state.checkouts.push(checkout);
  const v = checkoutView(checkout);
  return { ...v, checkoutUrl: v.checkout.status === 'paid' ? null : `/checkouts/${checkout.id}/pay`, replayed: false };
});
const checkoutView = (c: any) => {
  const orders = c.order_ids.map((id: string) => state.orders.find((o) => o.id === id)!);
  return {
    checkout: { id: c.id, status: orders.every((o: any) => o.status !== 'awaiting_payment') ? 'paid' : 'awaiting_payment', presentment_amount_cents: orders.reduce((s: number, o: any) => s + (o.charged_cents ?? o.amount_cents), 0), presentment_currency: 'USD', created_at: c.created_at },
    orders: orders.map((o: any) => ({ id: o.id, ref: o.ref, status: o.status, seller_id: o.seller_id, offer_id: o.offer_id, offer_title: o.offer_title, quantity: o.quantity, amount_cents: o.amount_cents, credit_cents: o.credit_cents ?? 0, charged_cents: o.charged_cents ?? o.amount_cents, currency: o.currency, character_name: o.character_name ?? null, seller_name: userById(o.seller_id)?.display_name })),
  };
};
route('GET', '/checkouts/:id', ({ me, params }) => {
  const u = need(me);
  return checkoutView(state.checkouts.find((c) => c.id === params[0] && c.buyer_id === u.id) ?? fail(404, 'not_found', 'Checkout not found'));
});
route('GET', '/orders', ({ me, query }) => {
  const u = need(me);
  const as = query.get('as') === 'seller' ? 'seller' : 'buyer';
  return state.orders
    .filter((o) => (as === 'buyer' ? o.buyer_id : o.seller_id) === u.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((o) => orderSummary(o, as));
});
route('GET', '/orders/:id', ({ me, params }) => orderDetail(orderFor(need(me), params[0]!), me!));
route('GET', '/me/buyer-reputation', ({ me }) => buyerRepOf(need(me).id));
route('POST', '/orders/:id/buyer-rating', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.seller_id !== u.id) fail(403, 'not_seller', 'Only the seller rates the buyer');
  if (o.status !== 'completed') fail(409, 'not_rateable', 'Rate the buyer once the order is complete');
  const tags: string[] = [...new Set<string>(body.tags ?? [])];
  if (!tags.every((t) => GOOD_BUYER_TAGS.includes(t) === !!body.positive)) fail(409, 'tags_mismatch', body.positive ? 'Pick tags that describe a good buyer' : 'Pick tags that describe what went wrong');
  if (state.buyerRatings.some((r) => r.order_id === o.id)) fail(409, 'already_rated', 'You already rated this buyer for this order');
  const row = { id: rid(), order_id: o.id, seller_id: u.id, buyer_id: o.buyer_id, positive: !!body.positive, tags, created_at: now() };
  state.buyerRatings.push(row);
  return { positive: row.positive, tags: row.tags, created_at: row.created_at };
});
route('GET', '/orders/:id/items', ({ me, params }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.buyer_id !== u.id) fail(404, 'not_found', 'Order not found');
  return (o.items ?? []).map((content: string, i: number) => ({ id: `${o.id}-${i}`, content, deliveredAt: o.delivered_at }));
});
route('POST', '/orders/:id/deliver', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.seller_id !== u.id) fail(403, 'not_seller', 'Only the seller can deliver this order');
  if (o.status !== 'paid') fail(409, 'invalid_state', `Cannot deliver an order that is ${o.status}`);
  if (PROOF_KINDS.has(o.category_kind) && !body.proofAttachmentId) fail(400, 'proof_required', 'Attach a photo or video of the delivery (trade window, mail or confirmation) before marking it delivered');
  if (body.proofAttachmentId) {
    const att = state.attachments.find((a) => a.id === body.proofAttachmentId && a.room_id === o.room_id && a.uploader_id === u.id) ?? fail(400, 'invalid_proof', 'Upload the proof to this order’s chat first, then mark it delivered');
    o.delivery_proof_id = att.id;
  }
  deliverOrder(o, body.payload);
  notifyOrder(o.id);
  return orderDetail(o);
});
const PROOF_KINDS = new Set(['currency', 'item', 'topup', 'boosting']);
// --- Boosting progress and chat screenshots ----------------------------------------------
route('POST', '/chat/rooms/:id/attachments', ({ me, params, body }) => {
  const u = need(me);
  const room = state.rooms.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Chat not found');
  if (room.buyer_id !== u.id && room.seller_id !== u.id) fail(403, 'not_participant', 'Only the buyer and seller can add evidence');
  if (!/^(image\/(png|jpeg|webp)|video\/(mp4|webm))$/.test(body.type ?? '')) fail(400, 'unsupported_file', 'Only PNG, JPEG and WebP images or MP4/WebM videos can be attached');
  // The demo keeps files in this browser's storage, so they have to stay small.
  if (body.size > 600_000) fail(413, 'file_too_large', 'In the demo, proof files can be up to 600 KB');
  const video = body.type.startsWith('video/');
  const att = { id: rid(), room_id: room.id, uploader_id: u.id, data_url: body.dataUrl, mime: body.type, original_name: body.name ?? (video ? 'proof.mp4' : 'screenshot.png'), created_at: now() };
  state.attachments.push(att);
  const m = appendMessage(room.id, u.id, 'attachment', video ? '🎬 video proof' : '📎 screenshot');
  return { id: att.id, mime: att.mime, width: video ? null : 0, created_at: att.created_at, seq: m.seq };
});
// Large videos go straight to object storage in the real app; the demo has none (like an API without S3).
route('POST', '/chat/rooms/:id/attachments/direct', ({ me }) => (need(me), fail(409, 'direct_upload_unavailable', 'Videos can be up to 95 MB')));
route('POST', '/chat/attachments/:id/complete', () => fail(404, 'not_found', 'Upload not found'));
route('POST', '/orders/:id/progress', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.seller_id !== u.id) fail(403, 'not_seller', 'Only the seller posts progress');
  if (o.category_kind !== 'boosting') fail(400, 'not_boosting', 'Progress updates are for boosting orders');
  if (o.status !== 'paid') fail(409, 'invalid_state', 'Progress can be posted while the order is in progress');
  const percent = Number(body.percent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) fail(400, 'validation_error', 'Percent must be 0 to 100');
  const last = state.progress.filter((p) => p.order_id === o.id).at(-1);
  if (last && percent < last.percent) fail(400, 'progress_backwards', `Progress can’t go below the last update (${last.percent}%)`);
  if (body.attachmentId && !state.attachments.some((a) => a.id === body.attachmentId && a.room_id === o.room_id && a.uploader_id === u.id)) {
    fail(400, 'invalid_attachment', 'Attach a screenshot you uploaded to this order’s chat');
  }
  const note = String(body.note ?? '').trim().slice(0, 500);
  const row = { id: rid(), order_id: o.id, percent, note, attachment_id: body.attachmentId ?? null, created_at: now() };
  state.progress.push(row);
  live(appendMessage(o.room_id, null, 'system', `Progress: ${percent}%${note ? ` · ${note}` : ''}${row.attachment_id ? ' (screenshot attached)' : ''}`));
  notify(o.buyer_id, 'orders', 'order_progress', `${percent}% done: ${o.offer_title}`, note || 'The seller posted progress on your order.', `/orders/${o.id}`);
  notifyOrder(o.id);
  return row;
});

// --- Account warranty claims (after release) ---------------------------------------------
const CLAIM_OPEN = ['open', 'seller_fixed', 'escalated'];
const REASON_TEXT: Record<string, string> = { recovered: 'the account was taken back by its original owner', banned: 'the account was banned', locked: 'the account is locked', other: 'the account stopped working' };
function claimFor(id: string) {
  const c = state.warrantyClaims.find((x) => x.id === id) ?? fail(404, 'not_found', 'Warranty claim not found');
  return { c, o: state.orders.find((x) => x.id === c.order_id)! };
}
function claimUpdate(c: any, o: any, status: string, extra: Record<string, unknown>, chat: string) {
  Object.assign(c, { status, updated_at: now() }, extra);
  live(appendMessage(o.room_id, null, 'system', chat));
  for (const uid of [o.buyer_id, o.seller_id]) notify(uid, 'disputes', 'warranty_update', `Warranty claim update: ${o.offer_title}`, `Status: ${status.replace('_', ' ')}.`, `/orders/${o.id}`);
}
function warrantyRefund(o: any, c: any) {
  // Refunded from the seller's balance (the warranty kept this payout on hold).
  state.balances[o.seller_id] = (state.balances[o.seller_id] ?? 0) - o.seller_net_cents;
  live(appendMessage(o.room_id, null, 'system', `${(o.amount_cents / 100).toFixed(2)} USD was refunded to the buyer under the warranty.`));
  c.refunded_cents = o.amount_cents;
}
route('POST', '/orders/:id/warranty-claims', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.buyer_id !== u.id) fail(403, 'not_buyer', 'Only the buyer can claim on the warranty');
  if (o.status !== 'completed' || !o.warranty_ends_at) fail(409, 'no_warranty', 'This order has no warranty');
  if (Date.parse(o.warranty_ends_at) <= Date.now()) fail(409, 'warranty_expired', 'The warranty on this order has ended');
  if (state.warrantyClaims.some((c) => c.order_id === o.id && CLAIM_OPEN.includes(c.status))) fail(409, 'claim_open', 'There is already an open claim on this order');
  if (String(body.details ?? '').trim().length < 10) fail(400, 'validation_error', 'Describe what happened');
  const c = {
    id: rid(), order_id: o.id, buyer_id: o.buyer_id, seller_id: o.seller_id, reason: body.reason, details: String(body.details).trim(), status: 'open',
    seller_message: null, respond_by: new Date(Date.now() + 48 * 3_600_000).toISOString(), confirm_by: null, decision_note: null, created_at: now(), updated_at: now(),
  };
  state.warrantyClaims.push(c);
  live(appendMessage(o.room_id, null, 'system', `Warranty claim: the buyer says ${REASON_TEXT[c.reason] ?? REASON_TEXT.other}. The seller has 48 hours to fix it, refund, or contest it.`));
  notify(o.seller_id, 'disputes', 'warranty_claim', `Warranty claim on ${o.offer_title}`, 'Fix it, refund, or contest it within 48 hours.', `/orders/${o.id}`);
  return c;
});
route('POST', '/warranty-claims/:id/seller', ({ me, params, body }) => {
  const u = need(me);
  const { c, o } = claimFor(params[0]!);
  if (c.seller_id !== u.id) fail(403, 'not_seller', 'Only the seller can answer this claim');
  if (c.status !== 'open') fail(409, 'claim_not_open', 'This claim is no longer waiting for the seller');
  const msg = body.message ? `: "${body.message}"` : '';
  if (body.action === 'fixed') claimUpdate(c, o, 'seller_fixed', { seller_message: body.message ?? null, confirm_by: new Date(Date.now() + 72 * 3_600_000).toISOString() }, `The seller says the account is working again${msg}. The buyer has 72 hours to confirm or send it to an arbiter.`);
  else if (body.action === 'contest') claimUpdate(c, o, 'escalated', { seller_message: body.message ?? null }, `The seller contests the warranty claim${msg}. An arbiter will decide.`);
  else {
    warrantyRefund(o, c);
    claimUpdate(c, o, 'refunded', { seller_message: body.message ?? null }, 'The seller accepted the warranty claim and refunded the buyer.');
  }
  return c;
});
route('POST', '/warranty-claims/:id/buyer', ({ me, params, body }) => {
  const u = need(me);
  const { c, o } = claimFor(params[0]!);
  if (c.buyer_id !== u.id) fail(403, 'not_buyer', 'Only the buyer can do this');
  if (body.action === 'withdraw') {
    if (!CLAIM_OPEN.includes(c.status)) fail(409, 'claim_closed', 'This claim is already closed');
    claimUpdate(c, o, 'withdrawn', {}, 'The buyer withdrew the warranty claim.');
  } else {
    if (c.status !== 'seller_fixed') fail(409, 'nothing_to_confirm', 'The seller hasn’t reported a fix yet');
    if (body.action === 'confirm') claimUpdate(c, o, 'resolved', {}, 'The buyer confirmed the account works again. Warranty claim resolved.');
    else claimUpdate(c, o, 'escalated', {}, 'The buyer says the account still doesn’t work. An arbiter will decide.');
  }
  return c;
});
route('GET', '/admin/warranty-claims', ({ me }) => {
  needPerm(me, 'disputes.manage');
  return state.warrantyClaims.filter((c) => c.status === 'escalated').map((c) => {
    const o = state.orders.find((x) => x.id === c.order_id)!;
    return { ...c, title: o.offer_title, amount_cents: o.amount_cents, currency: o.currency, warranty_ends_at: o.warranty_ends_at, buyer_name: userById(o.buyer_id)?.display_name, seller_name: userById(o.seller_id)?.display_name };
  });
});
route('POST', '/admin/warranty-claims/:id/decide', ({ me, params, body }) => {
  needPerm(me, body.outcome === 'refund' ? 'orders.refund_after_release' : 'disputes.manage');
  const { c, o } = claimFor(params[0]!);
  if (c.status !== 'escalated') fail(409, 'not_escalated', 'Only claims sent to an arbiter can be decided here');
  if (body.outcome === 'refund') {
    if (body.paidBy === 'seller' || !body.paidBy) warrantyRefund(o, c);
    claimUpdate(c, o, 'refunded', { decision_note: body.note }, `An arbiter refunded the buyer under the warranty: "${body.note}"`);
  } else claimUpdate(c, o, 'rejected', { decision_note: body.note }, `An arbiter rejected the warranty claim: "${body.note}"`);
  return c;
});

route('POST', '/orders/:id/confirm', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.buyer_id !== u.id) fail(403, 'not_buyer', 'Only the buyer can confirm');
  if (o.status !== 'delivered' && o.status !== 'paid') fail(409, 'invalid_state', `Cannot confirm an order that is ${o.status}`);
  let reason = o.status === 'paid' ? 'buyer_confirmed_early' : 'buyer_confirmed';
  if (o.checklist && !o.checklist.completed_at) {
    if (!o.checklist.handover_at) fail(409, 'checklist_incomplete', 'Finish the security changeover first');
    if (!body?.handoverConsent) fail(409, 'handover_consent_required', 'The checklist is not finished. Confirm that you want to release the payment now and end the insurance period early');
    reason = 'buyer_confirmed_after_handover';
  }
  releaseOrder(o, reason);
  return orderDetail(o);
});
// Handover check: the buyer signs in to the account they bought. The platform sign-in completes instantly in the demo.
route('POST', '/orders/:id/handover/start', ({ me, params }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.buyer_id !== u.id) fail(404, 'not_found', 'Order not found');
  if (o.status !== 'delivered') fail(409, 'invalid_state', `The handover check runs while the order is delivered, not ${o.status}`);
  if (!o.checklist?.handover_platform) fail(400, 'no_linked_account', 'This listing did not show a linked game account, so there is nothing to sign in to');
  if (o.checklist.handover_at) fail(409, 'already_verified', 'The handover is already confirmed');
  const offer = state.offers.find((f) => f.id === o.offer_id)!;
  const la = state.linkedAccounts.find((a) => a.id === offer.linked_account_id && !a.unlinked_at);
  if (la) {
    la.unlinked_at = now();
    offer.linked_account_id = null;
    state.linkedAccounts.push({ ...la, id: `la-${rid().slice(0, 8)}`, user_id: u.id, linked_at: now(), unlinked_at: null });
  }
  const item = o.checklist.items.find((i: any) => i.key === 'account_linked');
  if (item) item.done = true;
  o.checklist.handover_at = now();
  if (o.checklist.items.every((i: any) => i.done)) o.checklist.completed_at = now();
  const name = o.checklist.handover_platform === 'steam' ? 'Steam' : 'Riot';
  live(appendMessage(o.room_id, null, 'system', `Handover confirmed: the buyer signed in to the ${name} account from Bullizard.${o.checklist.completed_at ? ' The Security Changeover checklist is complete.' : ''}`));
  notify(o.seller_id, 'orders', 'order.handover', 'Handover confirmed', `${o.offer_title}: the buyer signed in to the account.`, `/orders/${o.id}`);
  return { url: `/orders/${o.id}?handover=ok` };
});
route('PATCH', '/orders/:id/checklist', ({ me, params, body }) => {
  const o = orderFor(need(me), params[0]!);
  const item = o.checklist?.items.find((i: any) => i.key === body.key) ?? fail(400, 'unknown_item', 'Unknown checklist item');
  if (item.auto) fail(400, 'auto_item', 'This step is ticked by signing in to the account from Bullizard');
  item.done = !!body.done;
  o.checklist.completed_at = o.checklist.items.every((i: any) => i.done) ? now() : null;
  return o.checklist;
});
/** Opens a dispute for one party (the buyer endpoint, kept for older clients, and staff from a support ticket). */
function openDisputeRecord(u: DemoUser, o: any, reason: string, category: string, statement: string, extra: Record<string, unknown> = {}) {
  if (!['paid', 'delivered'].includes(o.status)) fail(409, 'invalid_state', `Cannot dispute an order that is ${o.status}`);
  if (o.dispute) fail(409, 'already_disputed', 'This order already has a dispute');
  const role = u.id === o.buyer_id ? 'buyer' : 'seller';
  o.dispute = { id: rid(), order_id: o.id, reason, category, status: 'open', opened_by: u.id, created_at: now(), ...extra,
    statements: [{ id: rid(), role, body: statement, author_name: u.display_name, created_at: now() }] };
  transition(o, 'disputed', 'dispute_opened');
  live(appendMessage(o.room_id, null, 'system', 'A dispute was opened. Escrow is frozen until an arbiter reviews this chat.', [], { code: 'dispute_opened', params: { reason } }));
  return o.dispute;
}
route('POST', '/orders/:id/dispute', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  return openDisputeRecord(u, o, body.reason, body.category ?? 'other', body.reason);
});
route('POST', '/orders/:id/dispute/statements', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (!o.dispute) fail(404, 'not_found', 'Dispute not found');
  if (o.dispute.status !== 'open') fail(409, 'dispute_closed', 'This dispute has been decided');
  const role = u.id === o.buyer_id ? 'buyer' : 'seller';
  o.dispute.statements ??= [];
  if (o.dispute.statements.filter((s: any) => s.role === role).length >= 5) fail(409, 'too_many_statements', 'Each side can add up to 5 statements; add anything else in the chat');
  if (String(body.body ?? '').trim().length < 10) fail(400, 'validation_error', 'Write at least 10 characters');
  o.dispute.statements.push({ id: rid(), role, body: String(body.body).trim(), author_name: u.display_name, created_at: now() });
  live(appendMessage(o.room_id, null, 'system', `The ${role} added a statement to the dispute.`, [], { code: 'dispute_statement', params: { role } }));
  // Stand-in for the other side answering, so the demo shows both cases.
  if (role === 'buyer' && !o.dispute.statements.some((s: any) => s.role === 'seller')) {
    setTimeout(() => {
      o.dispute.statements.push({ id: rid(), role: 'seller', body: 'I delivered what the listing describes; the delivery message in the chat shows it. (Demo: simulated reply.)', author_name: userById(o.seller_id)?.display_name, created_at: now() });
      save();
    }, 4000);
  }
  return o.dispute.statements;
});
route('POST', '/orders/:id/cancel', ({ me, params }) => {
  const o = orderFor(need(me), params[0]!);
  if (o.status !== 'awaiting_payment') fail(409, 'invalid_state', 'Only unpaid orders can be cancelled');
  transition(o, 'cancelled', 'buyer_cancelled');
  return orderDetail(o);
});
route('POST', '/orders/:id/review', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.buyer_id !== u.id || o.status !== 'completed') fail(409, 'not_reviewable', 'Only completed purchases can be reviewed');
  if (state.reviews.some((r) => r.order_id === o.id)) fail(409, 'already_reviewed', 'You already reviewed this order');
  const r = { id: rid(), order_id: o.id, seller_id: o.seller_id, rating: body.rating, comment: body.comment ?? '', seller_reply: null, created_at: now() };
  state.reviews.push(r);
  return r;
});
route('GET', '/orders/:id/crypto-terms', ({ me, params, query }) => {
  const o = orderFor(need(me), params[0]!);
  return {
    note: 'Demo terms: in production these are EIP-712 terms signed by the platform key in KMS.',
    domain: { name: 'MarketEscrow', version: '1', chainId: 8453 },
    terms: { orderId: o.id, buyer: query.get('wallet'), amount: String(o.amount_cents * 10_000), feeBps: o.commission_bps },
    signature: '0x' + 'ab'.repeat(65),
  };
});

// --- Chat ------------------------------------------------------------------------------
route('POST', '/chat/rooms', ({ me, body }) => {
  const u = need(me);
  const offer = state.offers.find((x) => x.id === body.offerId) ?? fail(404, 'not_found', 'Listing not found');
  let room = state.rooms.find((r) => !r.order_id && r.offer_id === offer.id && r.buyer_id === u.id);
  if (!room) {
    room = { id: rid(), order_id: null, offer_id: offer.id, buyer_id: u.id, seller_id: offer.seller_id, last_seq: 0 };
    state.rooms.push(room);
    appendMessage(room.id, null, 'system', `Questions about "${offer.title}". Keep the conversation here: deals made elsewhere aren't protected by escrow.`);
  }
  return room;
});
const roomFor = (me: DemoUser, id: string) => {
  const r = state.rooms.find((x) => x.id === id);
  if (!r || (r.buyer_id !== me.id && r.seller_id !== me.id && me.role === 'user')) fail(404, 'not_found', 'Chat not found');
  return r;
};
route('GET', '/chat/rooms', ({ me }) => {
  const u = need(me);
  return state.rooms
    .filter((r) => r.buyer_id === u.id || r.seller_id === u.id)
    .map((r) => {
      const last = state.messages.filter((m) => m.room_id === r.id).sort((a, b) => a.seq - b.seq).at(-1);
      const order = r.order_id ? state.orders.find((o: any) => o.id === r.order_id) : null;
      const offer = state.offers.find((o) => o.id === r.offer_id);
      return {
        ...r,
        offer_title: offer?.title ?? order?.offer_title ?? null,
        order_status: order?.status ?? null,
        order_ref: order?.ref ?? null,
        buyer_name: userById(r.buyer_id)?.display_name,
        seller_name: userById(r.seller_id)?.display_name,
        last_message: last?.body ?? null,
        last_kind: last?.kind ?? null,
        last_sender_id: last?.sender_id ?? null,
        last_at: last?.created_at ?? null,
      };
    })
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
});
route('GET', '/chat/rooms/:id', ({ me, params }) => {
  const r = roomFor(need(me), params[0]!);
  return { ...r, buyer_name: userById(r.buyer_id)?.display_name, seller_name: userById(r.seller_id)?.display_name };
});
route('GET', '/chat/rooms/:id/messages', ({ me, params }) => {
  roomFor(need(me), params[0]!);
  return state.messages.filter((m) => m.room_id === params[0]).sort((a, b) => a.seq - b.seq);
});
route('POST', '/chat/rooms/:id/messages', ({ me, params, body }) => {
  const u = need(me);
  const r = roomFor(u, params[0]!);
  const text = String(body.body ?? '').trim();
  if (!text) fail(400, 'validation_error', 'Write a message');
  if (state.controls.pause_chat && u.role === 'user') fail(503, 'chat_paused', state.controls.pause_message || 'Chat is paused for a short while. Your order and its record are safe.');
  const accountOrder = !!r.order_id && state.orders.find((o) => o.id === r.order_id)?.category_kind === 'account';
  // Round 22b: account rooms (order or inquiry) carry labelled UIDs too.
  const accountRoom = accountOrder || state.offers?.find((f: any) => f.id === r.offer_id)?.category_kind === 'account';
  // Round 22b: our own deposit addresses are delivered; the rest of the message is checked as usual.
  const ownAddresses = state.cryptoPayments.map((p: any) => p.pay_address);
  const reasons = detectOffPlatform(text, { allowEmail: accountOrder, allowIds: accountRoom, ownAddresses });
  const flagged = reasons.length > 0;
  if (flagged && u.role === 'user') {
    // Not delivered: kept hidden for the staff queue; the action per offence is staff-set.
    // Round 22: blocked and queued for staff (no strike) unless the contact is unambiguous, which bans at once.
    const seq = (state.messages.filter((m) => m.room_id === r.id).length || 0) + 1;
    // Round 22b: our own deposit addresses never ban.
    const action = classify(reasons, { body: text, ownAddresses });
    state.chatFlags.unshift({ id: rid(), room_id: r.id, seq, user_id: u.id, reasons, status: 'open', note: null, created_at: now(), attempted: text, strike: action === 'ban', auto_ban: action === 'ban', prior_status: action === 'ban' ? u.status : null, prior_suspended_until: action === 'ban' ? (u as any).suspended_until ?? null : null });
    if (action === 'ban') {
      u.status = 'banned';
      live(appendMessage(r.id, null, 'warning', 'This account has been banned for trying to move the deal outside Bullizard. Do not continue this trade anywhere else; staff will review the case.'));
    }
    save();
    fail(422, 'offplatform_blocked', 'Not sent. Sharing outside contacts can get your account banned right away.', { action }); // Round 23f: queue | ban, as the API
  }
  const m = appendMessage(r.id, u.id, 'text', text, reasons.map((x) => `offplatform:${x}`));
  scheduleReply(r.id, u.id === r.buyer_id ? r.seller_id : r.buyer_id);
  return m;
});

// --- Selling ---------------------------------------------------------------------------
/** Who may sell: Tier 1 plus a passed rules test; identity (Tier 2) within 30 days or selling pauses. */
const needSeller = (me: DemoUser | null) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'tier1_required', 'Verify your email first.');
  if (!u.rules_passed_at) fail(403, 'rules_test_required', 'Pass the seller rules test before your first listing');
  if (u.selling_restricted_at && u.kyc_tier < 2) fail(403, 'kyc_overdue', 'Verify your identity to keep selling: the 30-day deadline has passed');
  if (u.listing_banned_at) fail(403, 'listing_banned', 'Your account cannot list items right now. Open an appeal from the help centre if you think this is a mistake.');
  return u;
};
route('POST', '/admin/users/:id/listing-ban', ({ me, params, body }) => {
  const staff = needStaff(me);
  const u = state.users.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'User not found');
  u.listing_banned_at = body.on ? now() : null;
  u.listing_ban_reason = body.on ? String(body.reason ?? '') : null;
  for (const f of state.offers.filter((f) => f.seller_id === u.id)) {
    if (body.on && f.status === 'active') { f.status = 'paused'; f.expired_reason = 'listing_ban'; }
    else if (!body.on && f.expired_reason === 'listing_ban') { f.status = 'active'; f.expired_reason = null; }
  }
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: staff.display_name, actor_role: staff.role, ip: '203.0.113.7', action: body.on ? 'user.listing_ban' : 'user.listing_unban', target_type: 'user', target_id: u.id, details: { reason: body.reason } });
  save();
  return { listingBannedAt: u.listing_banned_at };
});
const onboardingOf = (u: DemoUser) => {
  const idDueAt = u.seller_since && u.kyc_tier < 2 ? new Date(Date.parse(u.seller_since) + state.rulesSettings.idDueDays * day).toISOString() : null;
  return { tier1: u.kyc_tier >= 1, rulesPassedAt: u.rules_passed_at ?? null, identityVerified: u.kyc_tier >= 2, sellerSince: u.seller_since ?? null, idDueAt, idDueDays: state.rulesSettings.idDueDays, sellingRestrictedAt: u.selling_restricted_at ?? null, canSell: u.kyc_tier >= 1 && !!u.rules_passed_at && !u.selling_restricted_at };
};
route('GET', '/seller/onboarding', ({ me }) => onboardingOf(need(me)));
route('GET', '/seller/rules-test', ({ me, query }) => {
  const u = need(me);
  const ar = query.get('lang') === 'ar';
  return {
    passMarkPct: state.rulesSettings.passMarkPct, passedAt: u.rules_passed_at ?? null, attempts: u.rules_attempts ?? 0, tier1: u.kyc_tier >= 1, locale: ar ? 'ar' : 'en',
    questions: state.rulesQuestions.filter((q) => q.active).map((q: any) => ({ id: q.id, position: q.position, question: ar && q.question_ar ? q.question_ar : q.question, options: ar && q.options_ar ? q.options_ar : q.options })),
  };
});
route('POST', '/seller/rules-test', ({ me, body }) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'tier1_required', 'Verify your email first.');
  const qs = state.rulesQuestions.filter((q) => q.active);
  const ar = body?.lang === 'ar';
  const results = qs.map((q: any) => ({ id: q.id, correct: body.answers?.[q.id] === q.correct, explanation: body.answers?.[q.id] === q.correct ? null : (ar && q.explanation_ar) || q.explanation }));
  const scorePct = Math.round((results.filter((r) => r.correct).length * 100) / qs.length);
  const passed = scorePct >= state.rulesSettings.passMarkPct;
  u.rules_attempts = (u.rules_attempts ?? 0) + 1;
  if (passed && !u.rules_passed_at) u.rules_passed_at = now();
  save();
  return { passed, scorePct, passMarkPct: state.rulesSettings.passMarkPct, results };
});
route('GET', '/admin/rules-test', ({ me }) => (needPerm(me, 'rules.manage'), { questions: state.rulesQuestions, settings: state.rulesSettings }));
route('PUT', '/admin/rules-test', ({ me, body }) => {
  needPerm(me, 'rules.manage');
  const keep = new Set<string>();
  for (const q of body.questions ?? []) {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) fail(400, 'invalid_question', 'Each question has 2 to 6 options');
    if (q.correct < 0 || q.correct >= q.options.length) fail(400, 'invalid_question', 'The correct answer must be one of the options');
    const cur = q.id ? state.rulesQuestions.find((x) => x.id === q.id) : null;
    const row = {
      id: cur?.id ?? rid(), position: Number(q.position), question: String(q.question).trim(), options: q.options.map(String), correct: Number(q.correct), explanation: String(q.explanation ?? ''), active: q.active ?? true,
      question_ar: q.question_ar ? String(q.question_ar) : null, options_ar: Array.isArray(q.options_ar) && q.options_ar.length === q.options.length ? q.options_ar.map(String) : null, explanation_ar: q.explanation_ar ? String(q.explanation_ar) : null,
    };
    if (cur) Object.assign(cur, row);
    else state.rulesQuestions.push(row);
    keep.add(row.id);
  }
  for (const q of state.rulesQuestions) if (!keep.has(q.id)) q.active = false;
  if (body.settings) Object.assign(state.rulesSettings, { passMarkPct: body.settings.passMarkPct ?? state.rulesSettings.passMarkPct, idDueDays: body.settings.idDueDays ?? state.rulesSettings.idDueDays });
  save();
  return { questions: state.rulesQuestions, settings: state.rulesSettings };
});
route('POST', '/admin/rules-test/enforce', ({ me }) => {
  needPerm(me, 'rules.manage');
  let restricted = 0;
  for (const u of state.users) {
    if (!u.seller_since || u.kyc_tier >= 2 || u.selling_restricted_at) continue;
    if (Date.parse(u.seller_since) + state.rulesSettings.idDueDays * day > Date.now()) continue;
    u.selling_restricted_at = now();
    for (const o of state.offers.filter((f) => f.seller_id === u.id && f.status === 'active')) Object.assign(o, { status: 'paused', expired_reason: 'id_overdue' });
    notify(u.id, 'selling', 'id_overdue', 'Your listings are paused until you verify your identity', 'Verify now and everything comes back automatically.', '/account');
    restricted++;
  }
  save();
  return { reminded: 0, restricted };
});
const TRUST_ORDER = ['top', 'trusted', 'rising', 'new'];
const TRUST_REQ: Record<string, { completed: number; ageDays: number; onTimePct: number; disputePct: number; chargebackPct: number }> = {
  rising: { completed: 10, ageDays: 30, onTimePct: 85, disputePct: 5, chargebackPct: 1 },
  trusted: { completed: 100, ageDays: 180, onTimePct: 92, disputePct: 2, chargebackPct: 0.5 },
  top: { completed: 1000, ageDays: 365, onTimePct: 97, disputePct: 1, chargebackPct: 0.3 },
};
route('GET', '/seller/trust', ({ me }) => {
  const u = needSeller(me);
  const level = state.trust[u.id] ?? 'new';
  const before = state.reviewsBefore[u.id];
  const metrics = {
    completed: sellerStats(u.id).completed, ageDays: Math.floor((Date.now() - Date.parse(u.created_at)) / day),
    onTimePct: before ? Math.min(100, 93 + (before.count % 7)) : null, disputePct: before ? 0.8 : null, chargebackPct: before ? 0.1 : null,
  };
  const nextLevel = ['new', 'rising', 'trusted', 'top'][['new', 'rising', 'trusted', 'top'].indexOf(level) + 1];
  const r = nextLevel ? TRUST_REQ[nextLevel]! : null;
  return {
    level, metrics,
    next: r ? { level: nextLevel, requirements: r, met: { completed: metrics.completed >= r.completed, ageDays: metrics.ageDays >= r.ageDays, onTimePct: (metrics.onTimePct ?? 100) >= r.onTimePct, disputePct: (metrics.disputePct ?? 0) <= r.disputePct, chargebackPct: (metrics.chargebackPct ?? 0) <= r.chargebackPct } } : null,
  };
});
route('PUT', '/seller/presence', ({ me, body }) => {
  const u = needSeller(me);
  state.showOnline[u.id] = !!body.showOnline;
  return { showOnline: state.showOnline[u.id] };
});
route('GET', '/seller/dashboard', ({ me }) => {
  const u = needSeller(me);
  const t = tierOf(u.id);
  const mine = state.orders.filter((o) => o.seller_id === u.id);
  return {
    tier: t.tier,
    rank: t.rank,
    rateBps: t.rateBps,
    promo: t.promo,
    monthlySalesCents: t.sales,
    next: t.next,
    tiers: RANKS.map(asTier),
    onboarding: onboardingOf(u),
    founding: foundingOf(u),
    payoutCurrency: state.payoutCurrency[u.id] ?? 'USD',
    debts: state.debts.filter((d) => d.seller_id === u.id && !d.closed_at).map((d) => ({ id: d.id, currency: d.currency, owedCents: d.owed_cents, openedAt: d.opened_at, shopPausedAt: d.paused_at, pausesAt: d.paused_at ? null : new Date(Date.parse(d.opened_at) + 14 * day).toISOString() })),
    allBalances: [{ currency: 'USD', cents: state.balances[u.id] ?? 0 }],
    balances: { availableCents: state.balances[u.id] ?? 0, withdrawableCents: holdOf(u.id).withdrawableCents, onHoldCents: holdOf(u.id).heldCents, currency: 'USD', pendingEscrowCents: mine.filter((o) => ['paid', 'delivered', 'disputed'].includes(o.status)).reduce((s, o) => s + o.seller_net_cents, 0) },
    withdrawalsFrozen: u.withdrawals_frozen,
    shop: { paused: false, until: null, message: null, showOnline: state.showOnline[u.id] ?? true, responseMinutes: state.presence[u.id]?.response_minutes ?? null, responseSample: state.presence[u.id] ? 12 : 0 },
    stats: {
      completed: sellerStats(u.id).completed,
      in_progress: mine.filter((o) => ['paid', 'delivered'].includes(o.status)).length,
      disputed: mine.filter((o) => o.status === 'disputed').length,
      charged_back: 0,
    },
  };
});
route('GET', '/seller/offers', ({ me }) => {
  const u = needSeller(me);
  return state.offers
    .filter((o) => o.seller_id === u.id)
    .filter((o) => o.status !== 'removed')
    .map((o) => ({ ...offerView(o), available: availableOf(o), linked_account_id: o.linked_account_id ?? null, featured: isFeatured(o), featured_until: o.featured_until ?? null, open_orders: openOrdersOf(o.id) }));
});
/**
 * Round 26: a listing from a create body, checked as the API checks it, not saved. Currency listings get an
 * automatic title (game · server · faction); every listing has a description; min and optional max per order.
 */
function buildOffer(u: DemoUser, body: any) {
  const cat = CATEGORIES.find((c) => c.slug === body.categorySlug) ?? fail(400, 'invalid_category', 'Unknown category');
  if (cat.slug === 'currency') {
    const a = body.attributes ?? {};
    body = { ...body, title: [body.game, ...attributesFor(String(body.game ?? ''), 'currency').map((d) => a[d.key]).filter(Boolean)].join(' · ') };
  }
  if (!body.title || String(body.title).length < 3) fail(400, 'validation_error', 'Give the listing a title');
  if (!String(body.description ?? '').trim()) fail(400, 'description_required', 'Add a description, with delivery notes for the buyer');
  // Round 25: currency listings give a unit price with up to 6 decimals (or micro-units); others a price in cents.
  let unitMicros: number | null = body.unitPriceMicros ?? null;
  if (body.unitPrice != null) {
    const p = parseUnitPrice(String(body.unitPrice));
    if (p == null || p < 1) fail(400, 'invalid_unit_price', 'The unit price is a number with up to 6 decimals, e.g. 0.000123');
    if (unitMicros != null && unitMicros !== p) fail(400, 'invalid_unit_price', 'unitPrice and unitPriceMicros disagree');
    unitMicros = p;
  }
  if (unitMicros == null && !(body.priceCents > 0)) fail(400, 'validation_error', 'Set a price');
  if (!gameAllowed(String(body.game ?? ''))) fail(400, 'game_not_open', `${body.game} isn’t on Bullizard yet; suggest it on the game vote`);
  const attrs = cleanAttributes(String(body.game ?? ''), cat.slug, body.attributes);
  if (!attrs.ok) fail(400, 'invalid_attributes', attrs.error);
  if (unitMicros != null && body.priceTiers?.length) fail(400, 'invalid_tiers', 'Currency listings use volume discounts instead of price tiers');
  const tiers = unitMicros != null ? { ok: true as const, value: [] as Array<{ minQty: number; priceCents: number }> } : checkTiers(Number(body.priceCents), body.priceTiers, cat.kind);
  if (!tiers.ok) fail(400, 'invalid_tiers', tiers.error);
  // Same screening as the API: block terms refuse, review terms and contact details hold for a moderator.
  const text = `${body.title}\n${body.description ?? ''}`;
  const hits = matchTerms(text, state.modTerms);
  if (hits.some((h) => h.action === 'block')) fail(400, 'listing_blocked', 'This listing breaks the rules on prohibited goods and can’t be published');
  const reviewReasons = [...hits.map((h) => `term:${h.term}`), ...detectOffPlatform(text).map((x) => `contact:${x}`)];
  if (body.warrantyDays && cat.kind !== 'account') fail(400, 'invalid_warranty', 'Only account listings can carry a warranty');
  if (body.warrantyDays && ![7, 14, 30, 60, 90].includes(Number(body.warrantyDays))) fail(400, 'validation_error', 'Pick 7, 14, 30, 60 or 90 days');
  let bundle: Array<{ offer_id: string; quantity: number }> | null = null;
  if (body.bundle) {
    if (cat.kind === 'account') fail(400, 'invalid_bundle', 'Accounts are sold one at a time and can’t be bundled');
    if (body.bundle.length < 2 || body.bundle.length > 10) fail(400, 'invalid_bundle', 'A bundle has 2 to 10 listings');
    for (const p of body.bundle) {
      const f = state.offers.find((x) => x.id === p.offerId);
      if (!f || f.seller_id !== u.id || f.status !== 'active' || f.delivery_mode !== 'auto' || (f as any).bundle?.length) fail(400, 'invalid_bundle', 'Bundles combine your own active instant-delivery listings');
    }
    bundle = body.bundle.map((p: any) => ({ offer_id: p.offerId, quantity: Number(p.quantity) }));
  }
  const o = {
    bundle,
    id: `offer-${rid().slice(0, 8)}`, seller_id: u.id, category_slug: cat.slug, category_kind: cat.kind, game: body.game, title: body.title,
    description: body.description ?? '', price_cents: body.priceCents, currency: 'USD', delivery_mode: body.deliveryMode, delivery_hours: body.deliveryMode === 'auto' ? 0 : Number(body.deliveryHours ?? 2),
    stock: body.deliveryMode === 'manual' ? Number(body.stock ?? 1) : 0, inventory: [] as string[], status: reviewReasons.length ? 'review' : 'active', review_reasons: reviewReasons, owner_proof_status: 'none', version: 1, created_at: now(),
    attributes: attrs.ok ? attrs.value : {}, reserved_for: null, request_id: null, price_tiers: tiers.ok ? tiers.value : [], sale_price_cents: null, sale_starts_at: null, sale_ends_at: null,
    warranty_days: cat.kind === 'account' ? Number(body.warrantyDays ?? 0) : 0,
    expired_reason: null as string | null,
    featured_until: null as string | null,
    linked_account_id: null as string | null,
    unit_label: null as string | null,
    min_qty: Math.max(1, Math.floor(Number(body.minQty ?? 1))),
    max_qty: body.maxQty == null || body.maxQty === '' ? null : Math.floor(Number(body.maxQty)) as number | null,
  };
  if (o.max_qty != null && !(o.max_qty >= o.min_qty)) fail(400, 'invalid_max_qty', 'The maximum per order must be at least the minimum');
  if (unitMicros != null) {
    if (cat.slug !== 'currency') fail(400, 'invalid_unit_price', 'Only currency listings have a unit price');
    const first = attributesFor(String(body.game), cat.slug)[0];
    if (first && !(o.attributes as Record<string, string>)[first.key]) fail(400, 'server_required', `Pick the ${first.label.toLowerCase()}`, { field: first.key });
    if (body.deliveryMode === 'manual' && !(Number(body.stock) >= 1)) fail(400, 'stock_required', 'Set how many units you have');
    if (!isDeliveryTime(body.deliveryTime)) fail(400, 'delivery_time_required', 'Pick a delivery time');
    const vd = checkVolumeDiscounts(body.volumeDiscounts, 1);
    if (!vd.ok) return fail(400, 'invalid_volume_discounts', vd.error);
    Object.assign(o, { unit_price_micros: unitMicros, price_cents: centsForMicros(unitMicros), volume_discounts: vd.value, delivery_minutes: DELIVERY_TIMES[body.deliveryTime as keyof typeof DELIVERY_TIMES], stock: Math.max(1, Math.floor(Number(body.stock))) });
    if (body.deliveryMethods === undefined) fail(400, 'invalid_delivery_method', 'Pick at least one delivery method');
  } else if (isDeliveryTime(body.deliveryTime)) (o as any).delivery_minutes = DELIVERY_TIMES[body.deliveryTime as keyof typeof DELIVERY_TIMES];
  // Currency sold by amount: a unit, a minimum order and the stock in units (same rules as the API).
  if (body.unitLabel) {
    if (cat.kind !== 'currency') fail(400, 'invalid_unit', 'Only currency can be sold by amount');
    const min = Math.max(1, Math.floor(Number(body.minQty ?? 1)));
    o.unit_label = String(body.unitLabel).trim().slice(0, 12);
    o.min_qty = min;
    o.stock = Math.max(1, Math.floor(Number(body.stock ?? 1)));
    if (min > o.stock) fail(400, 'invalid_min_qty', 'The minimum order can’t be more than your stock');
  }
  // Round 24: delivery methods from the game's fixed list.
  if (body.deliveryMethods !== undefined) {
    const r = cleanDeliveryMethods(body.game, handoverFieldFor(body.game, body.categorySlug)?.key ?? null, body.deliveryMethods);
    if (!r.ok) return fail(400, 'invalid_delivery_method', r.error);
    (o as any).delivery_methods = r.value;
  }
  if (body.linkedAccountId) {
    checkAttach(u, body.linkedAccountId, body.game, cat.kind);
    o.linked_account_id = body.linkedAccountId;
  }
  return { o, reviewReasons };
}
route('POST', '/offers', ({ me, body }) => {
  const u = needSeller(me);
  const { o, reviewReasons } = buildOffer(u, body);
  if (!u.seller_since) {
    u.seller_since = now(); // the launch promo and the ID deadline count from here
    u.founding = Date.parse(state.launch.foundingUntil) > Date.now();
  }
  state.offers.unshift(o);
  if (reviewReasons.length) notify(u.id, 'selling', 'listing_review', 'Your listing is being reviewed', 'It mentions something our rules ask us to check, so it’s hidden until a moderator looks at it.', '/sell');
  return offerView(o);
});
// Round 26 (B10): dry run: the listing as buyers will see it (buyer price after fees), nothing saved.
route('POST', '/offers/preview', ({ me, body }) => {
  const u = needSeller(me);
  const { o, reviewReasons } = buildOffer(u, body);
  return { offer: { ...offerView(o), seller_name: u.display_name, id: 'preview' }, review: reviewReasons.length > 0 };
});
// Round 26 (B3): copy a listing to another server; the seller picks the server and the stock.
route('POST', '/offers/:id/duplicate', ({ me, params, body }) => {
  const u = needSeller(me);
  const src = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Offer not found');
  const attrs = cleanAttributes(src.game, src.category_slug, { ...(src.attributes ?? {}), ...(body.attributes ?? {}) });
  if (!attrs.ok) return fail(400, 'invalid_attributes', attrs.error);
  const stock = Math.floor(Number(body.stock));
  if (!(stock >= 1)) fail(400, 'stock_required', 'Set how many units you have');
  const first = attributesFor(src.game, src.category_slug)[0];
  const title = src.category_slug === 'currency' ? [src.game, ...attributesFor(src.game, 'currency').map((d) => attrs.value[d.key]).filter(Boolean)].join(' · ') : src.title;
  if (first && attrs.value[first.key] === src.attributes?.[first.key] && JSON.stringify(attrs.value) === JSON.stringify(src.attributes)) fail(400, 'same_server', 'Pick another server');
  const o = { ...JSON.parse(JSON.stringify(src)), id: `offer-${rid().slice(0, 8)}`, attributes: attrs.value, title, stock, inventory: [], version: 1, created_at: now(), status: 'active', featured_until: null, linked_account_id: null, expired_reason: null };
  state.offers.unshift(o);
  return offerView(o);
});
// Round 26 (B2): edit, pause, resume, delete (status "removed"; refused while orders are open).
const openOrdersOf = (offerId: string) => state.orders.filter((x) => x.offer_id === offerId && ['awaiting_payment', 'paid', 'delivered', 'disputed'].includes(x.status)).length;
route('PATCH', '/offers/:id', ({ me, params, body }) => {
  const u = needSeller(me);
  const o: any = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id && x.status !== 'removed') ?? fail(404, 'not_found', 'Offer not found');
  if (body.version !== o.version) fail(409, 'version_conflict', 'This listing changed in another tab. Reload and try again');
  if (body.status === 'removed' && openOrdersOf(o.id)) fail(409, 'open_orders', 'This listing has open orders. Pause it instead; you can delete it once they are done', { openOrders: openOrdersOf(o.id) });
  const merged = {
    categorySlug: o.category_slug, game: o.game, title: body.title ?? o.title, description: body.description ?? o.description, deliveryMode: o.delivery_mode,
    priceCents: body.priceCents ?? o.price_cents, attributes: body.attributes ?? o.attributes, stock: body.stock ?? o.stock,
    minQty: body.minQty ?? o.min_qty, maxQty: body.maxQty === undefined ? o.max_qty : body.maxQty,
    ...(o.unit_price_micros != null ? { unitPriceMicros: body.unitPrice != null ? parseUnitPrice(String(body.unitPrice)) ?? fail(400, 'invalid_unit_price', 'The unit price is a number with up to 6 decimals') : o.unit_price_micros, deliveryTime: body.deliveryTime ?? deliveryTimeFor(o.delivery_minutes ?? 1440), volumeDiscounts: body.volumeDiscounts ?? o.volume_discounts ?? [], deliveryMethods: body.deliveryMethods ?? o.delivery_methods ?? null } : { priceTiers: body.priceTiers ?? o.price_tiers }),
    warrantyDays: o.warranty_days || undefined,
  };
  if (body.status !== 'removed' && Object.keys(body).some((k) => !['version', 'status'].includes(k))) {
    const { o: next } = buildOffer(u, merged);
    const keep = { id: o.id, seller_id: o.seller_id, status: o.status, created_at: o.created_at, inventory: o.inventory, bundle: o.bundle, featured_until: o.featured_until, linked_account_id: o.linked_account_id, owner_proof_status: o.owner_proof_status, review_reasons: o.review_reasons };
    Object.assign(o, next, keep);
  }
  if (body.status) o.status = body.status;
  o.version++;
  return { ...offerView(o), available: availableOf(o), open_orders: openOrdersOf(o.id) };
});
// Bulk listings from CSV (simplified checks; the real API runs the full listing validation).
route('POST', '/seller/listings/import', ({ me, body }) => {
  const u = needSeller(me);
  const [head, ...rows] = parseCsv(String(body.csv ?? '').replace(/^\uFEFF/, ''));
  const header = (head ?? []).map((h) => h.trim().toLowerCase());
  if (rows.length > 500) fail(400, 'too_many_rows', 'Import up to 500 rows at a time');
  const results = rows.map((fields, i) => {
    const get = (k: string) => (header.includes(k) ? (fields[header.indexOf(k)] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '');
    const r: any = { row: i + 1, id: get('id') || null, title: get('title'), action: 'error' };
    const price = get('price') ? Math.round(Number(get('price')) * 100) : undefined;
    if (price !== undefined && !(price > 0)) return { ...r, error: 'Price must be between 0.01 and 100000' };
    if (r.id) {
      const o = state.offers.find((x) => x.id === r.id && x.seller_id === u.id && x.status !== 'removed');
      if (!o) return { ...r, error: 'No listing of yours with this id' };
      const patch: Record<string, unknown> = {};
      if (price !== undefined && price !== o.price_cents) patch.price_cents = price;
      if (get('stock') && o.delivery_mode === 'manual' && Number(get('stock')) !== o.stock) patch.stock = Number(get('stock'));
      if (r.title && r.title !== o.title) patch.title = r.title;
      if (get('status') && get('status') !== o.status) patch.status = get('status');
      const changes = Object.keys(patch).map((k) => ({ price_cents: 'price', stock: 'stock', title: 'title', status: 'status' })[k]);
      return changes.length ? { ...r, title: o.title, action: 'update', changes, patch } : { ...r, title: o.title, action: 'unchanged' };
    }
    for (const k of ['game', 'category', 'title', 'price', 'delivery']) if (!get(k)) return { ...r, error: `${k} is required for a new listing` };
    const cat = CATEGORIES.find((c) => c.slug === get('category')) ?? null;
    if (!cat) return { ...r, error: `Unknown category "${get('category')}"` };
    const text = `${r.title}\n${get('description')}`;
    return { ...r, action: 'create', review: detectOffPlatform(text).length > 0 || matchTerms(text, state.modTerms).length > 0, cat, price };
  });
  if (!body.dryRun) {
    for (const r of results) {
      if (r.action === 'update') Object.assign(state.offers.find((o) => o.id === r.id)!, r.patch, { version: (state.offers.find((o) => o.id === r.id)!.version ?? 1) + 1 });
      if (r.action === 'create') {
        const get = (k: string) => { const f = rows[r.row - 1]!; return header.includes(k) ? (f[header.indexOf(k)] ?? '').trim() : ''; };
        const id = `offer-${rid().slice(0, 8)}`;
        state.offers.unshift({
          ...state.offers.find((o) => o.seller_id === u.id)!, id, bundle: null, category_slug: r.cat.slug, category_kind: r.cat.kind, game: get('game'), title: r.title, description: get('description'),
          price_cents: r.price, currency: 'USD', delivery_mode: get('delivery') === 'instant' ? 'auto' : 'manual', delivery_hours: 2, stock: Number(get('stock') || 1), inventory: [],
          status: r.review ? 'review' : 'active', review_reasons: [], owner_proof_status: 'none', version: 1, created_at: now(), attributes: {}, reserved_for: null, request_id: null,
          price_tiers: [], sale_price_cents: null, sale_starts_at: null, sale_ends_at: null, warranty_days: 0,
        });
        r.id = id;
      }
    }
  }
  const out = results.map(({ patch: _p, cat: _c, price: _pr, ...r }) => r);
  const count = (a: string) => out.filter((r) => r.action === a).length;
  return { rows: out, summary: { create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') } };
});
route('POST', '/offers/:id/inventory', ({ me, params, body }) => {
  const u = needSeller(me);
  const o = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Listing not found');
  let items: string[];
  if (body.format === 'json') {
    try {
      items = (JSON.parse(body.content) as unknown[]).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    } catch {
      return fail(400, 'invalid_json', 'Upload is not valid JSON');
    }
  } else items = String(body.content).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fresh = items.filter((i) => !o.inventory.includes(i));
  o.inventory.push(...fresh);
  return { added: fresh.length, duplicates: items.length - fresh.length, available: o.inventory.length };
});
route('POST', '/offers/:id/owner-proof', ({ me, params, body }) => {
  const u = needSeller(me);
  const o = state.offers.find((x) => x.id === params[0] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Listing not found');
  o.owner_proof_status = 'pending';
  state.ownerProofs.push({
    id: rid(), offer_id: o.id, title: o.title, seller_id: u.id, registration_email: body.registrationEmail, registration_date: body.registrationDate,
    billing_name: body.billingName ?? null, seller_legal_name: u.legal_name, status: 'pending', created_at: now(),
  });
  return { status: 'pending' };
});
// Linked game accounts: the platform sign-in completes instantly in the demo.
route('GET', '/seller/linked-accounts', ({ me }) => linkedOf(need(me).id));
route('POST', '/seller/linked-accounts/:provider/start', ({ me, params }) => {
  const u = needSeller(me);
  const provider = params[0] as 'steam' | 'riot';
  const n = state.linkedAccounts.filter((a) => a.user_id === u.id && a.provider === provider).length + 1;
  state.linkedAccounts.push({
    id: `la-${rid().slice(0, 8)}`, user_id: u.id, provider, display_name: provider === 'steam' ? `${u.display_name}_steam${n}` : `${u.display_name}#${1000 + n}`,
    profile_url: null, account_created_at: provider === 'steam' ? '2016-03-14T00:00:00Z' : null, linked_at: now(), unlinked_at: null,
  });
  return { url: `/sell?linked=${provider}` };
});
route('DELETE', '/seller/linked-accounts/:id', ({ me, params }) => {
  const u = need(me);
  const a = state.linkedAccounts.find((x) => x.id === params[0] && x.user_id === u.id && !x.unlinked_at) ?? fail(404, 'not_found', 'Linked account not found');
  a.unlinked_at = now();
  for (const o of state.offers) if (o.linked_account_id === a.id) o.linked_account_id = null;
  return linkedOf(u.id);
});
route('POST', '/seller/withdrawals', ({ me, body }) => {
  const u = needSeller(me);
  // Round 22b: withdrawals are USD only.
  if (body.currency && String(body.currency).toUpperCase() !== 'USD') fail(400, 'unsupported_currency', 'Withdrawals are in USD only; contact support about a balance in another currency');
  if (!u.payout_address) fail(400, 'no_payout_address', 'Add and confirm a payout address first');
  const available = state.balances[u.id] ?? 0;
  const { withdrawableCents } = holdOf(u.id);
  if (!(body.amountCents > 0) || body.amountCents > withdrawableCents) fail(400, 'insufficient_funds', `You can withdraw up to ${withdrawableCents} cents right now`);
  const fee = feeFor(body.amountCents);
  if (body.amountCents - fee <= 0) fail(400, 'amount_too_small', 'The fee would take the whole amount');
  state.balances[u.id] = available - body.amountCents;
  const w = {
    id: rid(), user_id: u.id, amount_cents: body.amountCents, fee_cents: fee, net_cents: body.amountCents - fee, currency: 'USD', status: 'pending_approval',
    destination_address: u.payout_address, destination_currency: u.payout_address_currency, provider_ref: null as string | null, payout_id: null as string | null, tx_hash: null as string | null, created_at: now(), updated_at: now(),
  };
  state.withdrawals.push(w);
  notify(u.id, 'selling', 'payout.requested', 'Withdrawal requested', `$${(body.amountCents / 100).toFixed(2)} requested; $${((body.amountCents - fee) / 100).toFixed(2)} is sent once the treasury approves it.`, '/sell/money');
  save();
  return w;
});

// --- Seller money: payout holds, currency, tax, invoices ------------------------------------
function holdOf(sellerId: string) {
  const [level, holdDays] = state.completedBefore[sellerId]! > 150 ? ['established', 3] : ['new', 7];
  const available = state.balances[sellerId] ?? 0;
  const recent = state.orders
    .filter((o) => o.seller_id === sellerId && o.status === 'completed' && Date.parse(o.completed_at) > Date.now() - holdDays * day)
    .map((o) => ({ unlocksAt: new Date(Date.parse(o.completed_at) + holdDays * day).toISOString(), cents: o.seller_net_cents }));
  // A couple of sales from "earlier this week" so the hold has something to show before any demo orders complete.
  const earlier = [{ unlocksAt: new Date(Date.now() + 2 * day).toISOString(), cents: Math.round(available * 0.08) }, { unlocksAt: new Date(Date.now() + day).toISOString(), cents: Math.round(available * 0.05) }];
  const upcoming = [...recent, ...earlier].filter((u) => u.cents > 0).sort((a, b) => a.unlocksAt.localeCompare(b.unlocksAt));
  const heldCents = Math.min(available, upcoming.reduce((s, u) => s + u.cents, 0));
  return { level, holdDays, currency: 'USD', availableCents: available, heldCents, withdrawableCents: available - heldCents, upcoming };
}
route('GET', '/seller/payout-hold', ({ me }) => holdOf(needSeller(me).id));
route('PUT', '/seller/payout-currency', ({ me, body }) => {
  const u = needSeller(me);
  if (String(body.currency).toUpperCase() !== 'USD') fail(400, 'unsupported_currency', 'Payouts are in USD only'); // Round 22b
  state.payoutCurrency[u.id] = body.currency;
  return { payoutCurrency: body.currency };
});
const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' '));
const VAT: Record<string, number> = { DE: 1900, FR: 2000, ES: 2100, IT: 2200, NL: 2100, IE: 2300, SE: 2500, PL: 2300, AT: 2000, BE: 2100, GB: 2000 };
function taxView(p: any) {
  const country = p.country ?? 'US';
  const treatment = EU.has(country) || country === 'GB' ? (p.isBusiness && p.taxIdVerified ? 'reverse_charge' : 'standard') : 'outside_scope';
  return { ...p, commissionTax: { country, treatment, rateBps: treatment === 'standard' ? VAT[country] ?? 2100 : 0 } };
}
const blankTax = { country: null, isBusiness: false, taxId: null, taxIdVerified: false, billingAddress: null };
route('GET', '/seller/tax-profile', ({ me }) => taxView(state.taxProfiles[needSeller(me).id] ?? blankTax));
route('PUT', '/seller/tax-profile', ({ me, body }) => {
  const u = needSeller(me);
  if (!body.country) fail(400, 'validation_error', 'Choose your country');
  const taxId = body.isBusiness && body.taxId ? String(body.taxId).replace(/\s/g, '').toUpperCase() : null;
  // Real VIES check happens server-side; here any well-formed EU-style number "verifies".
  state.taxProfiles[u.id] = { country: body.country, isBusiness: !!body.isBusiness, taxId, taxIdVerified: !!taxId && /^[A-Z]{2}[0-9A-Z]{8,12}$/.test(taxId), billingAddress: body.billingAddress ?? null };
  return taxView(state.taxProfiles[u.id]);
});
route('GET', '/seller/invoices', ({ me }) => state.invoices.filter((i) => i.seller_id === needSeller(me).id));
route('GET', '/seller/credit-notes', ({ me }) => state.creditNotes.filter((c) => c.seller_id === needSeller(me).id));

// --- Notifications & push ----------------------------------------------------------------
const inboxOf = (id: string) => state.inbox.filter((n) => n.user_id === id);
const unreadOf = (id: string) => inboxOf(id).filter((n) => !n.read_at).length;
route('GET', '/me/notifications', ({ me, query }) => {
  const u = need(me);
  return { items: inboxOf(u.id).slice(0, Number(query.get('limit') ?? 20)), unread: unreadOf(u.id) };
});
route('GET', '/me/notifications/unread-count', ({ me }) => ({ unread: unreadOf(need(me).id) }));
route('POST', '/me/notifications/read-all', ({ me }) => {
  const u = need(me);
  for (const n of inboxOf(u.id)) n.read_at ??= now();
  return { unread: 0 };
});
route('POST', '/me/notifications/:id/read', ({ me, params }) => {
  const u = need(me);
  const n = inboxOf(u.id).find((x) => x.id === params[0]);
  if (n) n.read_at ??= now();
  return { unread: unreadOf(u.id) };
});
// --- Moderation ----------------------------------------------------------------------------
route('GET', '/admin/moderation/summary', ({ me }) => (needPerm(me, 'moderation.manage'), {
  listings: state.offers.filter((o) => o.status === 'review').length, chats: state.chatFlags.filter((f) => f.status === 'open').length,
}));
route('GET', '/admin/moderation/listings', ({ me }) => {
  needPerm(me, 'moderation.manage');
  return state.offers
    .filter((o) => o.status === 'review')
    .map((o) => ({ ...o, inventory: undefined, seller_name: userById(o.seller_id)?.display_name, seller_email: userById(o.seller_id)?.email, seller_completed_orders: sellerStats(o.seller_id).completed, updated_at: o.created_at }));
});
route('POST', '/admin/moderation/listings/:id', ({ me, params, body }) => {
  needPerm(me, 'moderation.manage');
  const o = state.offers.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Listing not found');
  if (o.status !== 'review') fail(409, 'not_in_review', 'This listing is not waiting for review');
  const note = String(body.note ?? '').trim();
  if (!body.approve && !note) fail(400, 'note_required', 'Tell the seller why the listing was rejected');
  o.status = body.approve ? 'active' : 'removed';
  (o as any).review_note = note || null;
  notify(o.seller_id, 'selling', body.approve ? 'listing_approved' : 'listing_rejected', body.approve ? `Listing approved: ${o.title}` : `Listing removed: ${o.title}`, body.approve ? 'A moderator approved it and it’s live again.' : `A moderator removed it: ${note}`, body.approve ? `/offers/${o.id}` : '/sell');
  return { id: o.id, status: o.status };
});
route('GET', '/admin/moderation/chats', ({ me, query }) => {
  needPerm(me, 'moderation.manage');
  const status = query.get('status') ?? 'open';
  return state.chatFlags
    .filter((f) => f.status === status)
    .map((f) => {
      const room = state.rooms.find((r) => r.id === f.room_id);
      const u = userById(f.user_id);
      return {
        ...f, user_name: u?.display_name ?? f.user_name ?? 'User', user_email: u?.email ?? f.user_email ?? '', offplatform_strikes: state.chatFlags.filter((x) => x.user_id === f.user_id && x.status !== 'dismissed' && x.strike !== false).length,
        user_status: 'active', order_id: room?.order_id ?? null, offer_id: room?.offer_id, role: room?.seller_id === f.user_id ? 'seller' : 'buyer',
        confirmed_before: state.chatFlags.filter((x) => x.user_id === f.user_id && x.status === 'confirmed' && x.id !== f.id).length,
        context: [...state.messages.filter((m) => m.room_id === f.room_id && m.seq <= f.seq && m.seq >= f.seq - 2).sort((a, b) => a.seq - b.seq).map((m) => ({ ...m, erased: false })), ...(f.attempted ? [{ seq: f.seq, sender_id: f.user_id, kind: 'text', body: f.attempted, flags: ['blocked'], created_at: f.created_at, erased: false }] : [])],
      };
    });
});
route('POST', '/admin/moderation/chats/:id', ({ me, params, body }) => {
  const u = needPerm(me, 'moderation.manage');
  const f = state.chatFlags.find((x) => x.id === params[0] && x.status === 'open') ?? fail(404, 'not_found', 'Open flag not found');
  Object.assign(f, { status: body.confirm ? 'confirmed' : 'dismissed', note: body.note ?? null, reviewed_by: u.id });
  // Round 22: a queued hit becomes a strike when staff confirm it; the staff-set ladder applies then.
  let action: string | null = null;
  if (body.confirm && f.strike === false) {
    f.strike = true;
    const strikes = state.chatFlags.filter((x) => x.user_id === f.user_id && x.status !== 'dismissed' && x.strike !== false).length;
    action = state.offplatformActions[Math.min(strikes, state.offplatformActions.length) - 1] ?? 'warn';
    const target = userById(f.user_id);
    if (target && action !== 'warn') {
      target.status = action === 'ban' ? 'banned' : 'suspended';
      live(appendMessage(f.room_id, null, 'warning', `This account has been ${action === 'ban' ? 'banned' : 'suspended'} for trying to move the deal outside Bullizard. Do not continue this trade anywhere else; staff will review the case.`));
    }
  }
  // Round 22b: dismissing the flag behind an automatic ban lifts it, unless another offence still stands.
  let banLifted = false;
  if (!body.confirm && f.auto_ban) {
    const other = state.chatFlags.some((x) => x.id !== f.id && x.user_id === f.user_id && (x.status === 'confirmed' || (x.status === 'open' && x.auto_ban)));
    const target = userById(f.user_id);
    if (!other && target?.status === 'banned') {
      // A prior suspension comes back with its original end; without one still ahead, the user is active again.
      const resuspend = f.prior_status === 'suspended' && f.prior_suspended_until && new Date(f.prior_suspended_until).getTime() > Date.now();
      target.status = resuspend ? 'suspended' : f.prior_status && f.prior_status !== 'suspended' ? f.prior_status : 'active';
      (target as any).suspended_until = resuspend ? f.prior_suspended_until : null;
      f.restored_status = target.status;
      banLifted = true;
    }
  }
  save();
  return { id: f.id, status: f.status, user_id: f.user_id, strike: f.strike !== false, action, banLifted, restoredStatus: banLifted ? f.restored_status : null };
});
route('GET', '/admin/moderation/offplatform-policy', ({ me }) => (needPerm(me, 'moderation.manage'), { actions: state.offplatformActions }));
route('PUT', '/admin/moderation/offplatform-policy', ({ me, body }) => {
  needPerm(me, 'moderation.manage');
  const actions = (body.actions ?? []).map(String);
  if (!actions.length || actions.length > 5 || actions.some((a: string) => !['warn', 'suspend', 'ban'].includes(a))) fail(400, 'validation_error', 'One to five steps: warn, suspend or ban');
  state.offplatformActions = actions;
  save();
  return { actions };
});
route('GET', '/admin/moderation/terms', ({ me }) => (needPerm(me, 'moderation.manage'), [...state.modTerms].sort((a, b) => a.action.localeCompare(b.action) || a.term.localeCompare(b.term))));
route('POST', '/admin/moderation/terms', ({ me, body }) => {
  needPerm(me, 'moderation.manage');
  const term = String(body.term ?? '').trim();
  if (term.length < 2) fail(400, 'validation_error', 'Enter a word or phrase');
  if (state.modTerms.some((x) => x.term.toLowerCase() === term.toLowerCase())) fail(409, 'duplicate_term', 'That term is already on the list');
  const t = { id: rid(), term, action: body.action === 'block' ? 'block' as const : 'review' as const, created_at: now() };
  state.modTerms.push(t);
  return t;
});
route('DELETE', '/admin/moderation/terms/:id', ({ me, params }) => {
  needPerm(me, 'moderation.manage');
  const i = state.modTerms.findIndex((x) => x.id === params[0]);
  if (i < 0) fail(404, 'not_found', 'Term not found');
  state.modTerms.splice(i, 1);
});

// --- Buyer requests board ----------------------------------------------------------------
const reqOpen = (r: any) => r.status === 'open' && r.expires_at > now();
const propView = (p: any) => {
  const s = sellerStats(p.seller_id);
  return { ...p, price_cents: gross(p.seller_id, p.price_cents), seller_price_cents: p.price_cents, seller_name: userById(p.seller_id)?.display_name ?? 'Seller', seller_completed_orders: s.completed, seller_rating: s.rating };
};
const reqView = (r: any, viewer?: string) => {
  const ps = state.proposals.filter((p) => p.request_id === r.id);
  const mine = r.buyer_id === viewer;
  const matches = viewer && !mine && reqOpen(r)
    ? state.offers.filter((f) => f.seller_id === viewer && listed(f) && f.game.toLowerCase() === r.game.toLowerCase() && f.category_slug === r.category_slug && availableOf(f) > 0)
        .map((f) => ({ id: f.id, title: f.title, price_cents: effectivePrice(f), currency: f.currency, stock: availableOf(f) }))
    : [];
  return {
    my_matches: matches,
    ...r, category_kind: CATEGORIES.find((c) => c.slug === r.category_slug)?.kind, open: reqOpen(r), mine,
    proposals: ps.filter((p) => ['pending', 'accepted'].includes(p.status)).length,
    proposal_list: !viewer ? [] : ps.filter((p) => (mine ? p.status !== 'withdrawn' : p.seller_id === viewer)).sort((a, b) => a.price_cents - b.price_cents).map(propView),
  };
};
const reqById = (id: string) => state.requests.find((r) => r.id === id) ?? fail(404, 'not_found', 'Request not found');
route('GET', '/requests', ({ query }) => {
  const game = query.get('game')?.toLowerCase();
  const cat = query.get('category');
  const q = query.get('q')?.toLowerCase().trim();
  return state.requests
    .filter((r) => reqOpen(r) && (!game || r.game.toLowerCase() === game) && (!cat || r.category_slug === cat) && (!q || `${r.title} ${r.game}`.toLowerCase().includes(q)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => ({ ...reqView(r), proposal_list: undefined }));
});
route('GET', '/requests/mine', ({ me }) => {
  const u = need(me);
  return state.requests.filter((r) => r.buyer_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => ({ ...reqView(r, u.id), proposal_list: undefined }));
});
route('GET', '/requests/proposals/mine', ({ me }) => {
  const u = need(me);
  return state.proposals
    .filter((p) => p.seller_id === u.id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((p) => {
      const r = reqById(p.request_id);
      return { ...propView(p), request_title: r.title, game: r.game, category_slug: r.category_slug, currency: r.currency, request_status: r.status, expires_at: r.expires_at };
    });
});
route('POST', '/requests', ({ me, body }) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email first.');
  if (!CATEGORIES.some((c) => c.slug === body.categorySlug)) fail(400, 'unknown_category', 'Unknown category');
  const game = String(body.game ?? '').trim();
  const title = String(body.title ?? '').trim();
  if (!game || title.length < 5) fail(400, 'validation_error', 'Add the game and a title of at least 5 characters');
  const attrs = cleanAttributes(game, body.categorySlug, body.attributes, { partial: true });
  if (!attrs.ok) fail(400, 'invalid_attributes', attrs.error);
  if (state.requests.filter((r) => r.buyer_id === u.id && reqOpen(r)).length >= 10) fail(409, 'too_many_requests', 'You can have up to 10 open requests');
  const r = {
    id: rid(), buyer_id: u.id, buyer_name: u.display_name, game, category_slug: body.categorySlug, title, description: String(body.description ?? '').trim(),
    budget_cents: body.budgetCents ?? null, currency: body.currency ?? 'USD', attributes: (attrs as any).value, status: 'open', accepted_proposal_id: null,
    expires_at: new Date(Date.now() + 14 * day).toISOString(), created_at: now(), updated_at: now(),
  };
  state.requests.unshift(r);
  // Stand-in for sellers answering, so the demo shows a proposal arriving.
  const seller = state.users.find((x) => x.kyc_tier >= 2 && x.id !== u.id && x.role === 'user' && state.offers.some((o) => listed(o) && o.seller_id === x.id && o.game.toLowerCase() === game.toLowerCase()))
    ?? state.users.find((x) => x.email === 'koi@demo.test')!;
  setTimeout(() => {
    if (!reqOpen(r)) return;
    const price = r.budget_cents ? Math.round(r.budget_cents * 0.9) : 25_00;
    state.proposals.push({ id: rid(), request_id: r.id, seller_id: seller.id, price_cents: price, delivery_hours: 6, message: 'I can do this today. (Demo: this proposal is simulated.)', status: 'pending', offer_id: null, created_at: now(), updated_at: now() });
    notify(u.id, 'orders', 'request_proposal', `New proposal for "${r.title}"`, `${seller.display_name} offers ${(price / 100).toFixed(2)} ${r.currency} with delivery within 6 hours.`, `/requests/${r.id}`);
    save();
  }, 5000);
  return reqView(r, u.id);
});
route('GET', '/requests/:id', ({ me, params }) => {
  const r = reqById(params[0]!);
  const v = reqView(r, me?.id);
  if (r.status !== 'open' && !v.mine && v.proposal_list.length === 0) fail(404, 'not_found', 'Request not found');
  return v;
});
route('POST', '/requests/:id/close', ({ me, params }) => {
  const u = need(me);
  const r = reqById(params[0]!);
  if (r.buyer_id !== u.id) fail(404, 'not_found', 'Request not found');
  if (r.status !== 'open') fail(409, 'not_open', 'This request is no longer open');
  Object.assign(r, { status: 'closed', updated_at: now() });
  for (const p of state.proposals) if (p.request_id === r.id && p.status === 'pending') Object.assign(p, { status: 'declined', updated_at: now() });
  return reqView(r, u.id);
});
route('POST', '/requests/:id/proposals', ({ me, params, body }) => {
  const u = needSeller(me);
  const r = reqById(params[0]!);
  if (r.buyer_id === u.id) fail(403, 'own_request', 'You cannot answer your own request');
  if (!reqOpen(r)) fail(409, 'not_open', 'This request is no longer taking proposals');
  let price = Number(body.priceCents);
  let hours = Number(body.deliveryHours);
  let listingId: string | null = null;
  if (body.offerId) {
    const f = state.offers.find((x) => x.id === body.offerId && x.seller_id === u.id && listed(x)) ?? fail(404, 'not_found', 'Listing not found');
    if (f.game.toLowerCase() !== r.game.toLowerCase() || f.category_slug !== r.category_slug) fail(400, 'listing_mismatch', 'That listing is for a different game or category');
    price = effectivePrice(f);
    hours = f.delivery_mode === 'auto' ? 1 : f.delivery_hours;
    listingId = f.id;
  }
  if (!(price > 0) || !(hours >= 1 && hours <= 168)) fail(400, 'validation_error', 'Enter a price and a delivery time between 1 and 168 hours');
  let p = state.proposals.find((x) => x.request_id === r.id && x.seller_id === u.id);
  if (p && !['pending', 'withdrawn'].includes(p.status)) fail(409, 'proposal_closed', 'Your proposal on this request can no longer be changed');
  if (!p) state.proposals.push((p = { id: rid(), request_id: r.id, seller_id: u.id, created_at: now(), offer_id: null }));
  Object.assign(p, { price_cents: price, delivery_hours: hours, message: String(body.message ?? '').trim(), status: 'pending', listing_offer_id: listingId, updated_at: now() });
  return reqView(r, u.id);
});
route('DELETE', '/requests/:id/proposals/mine', ({ me, params }) => {
  const u = need(me);
  const p = state.proposals.find((x) => x.request_id === params[0] && x.seller_id === u.id && x.status === 'pending') ?? fail(404, 'not_found', 'Proposal not found');
  Object.assign(p, { status: 'withdrawn', updated_at: now() });
  return reqView(reqById(params[0]!), u.id);
});
route('POST', '/requests/:id/proposals/:pid/accept', ({ me, params }) => {
  const u = need(me);
  const r = reqById(params[0]!);
  if (r.buyer_id !== u.id) fail(404, 'not_found', 'Request not found');
  if (!reqOpen(r)) fail(409, 'not_open', 'This request is no longer open');
  const p = state.proposals.find((x) => x.id === params[1] && x.request_id === r.id && x.status === 'pending') ?? fail(404, 'not_found', 'Proposal not found');
  if (p.listing_offer_id) {
    Object.assign(p, { status: 'accepted', offer_id: p.listing_offer_id, updated_at: now() });
    for (const x of state.proposals) if (x.request_id === r.id && x.id !== p.id && x.status === 'pending') Object.assign(x, { status: 'declined', updated_at: now() });
    Object.assign(r, { status: 'accepted', accepted_proposal_id: p.id, updated_at: now() });
    return { offerId: p.listing_offer_id, request: reqView(r, u.id) };
  }
  const offer = {
    id: `offer-r-${rid().slice(0, 8)}`, seller_id: p.seller_id, category_slug: r.category_slug, category_kind: CATEGORIES.find((c) => c.slug === r.category_slug)!.kind, game: r.game,
    title: r.title, description: [r.description, p.message].filter(Boolean).join('\n\n'), price_cents: p.price_cents, currency: r.currency, delivery_mode: 'manual' as const,
    delivery_hours: p.delivery_hours, stock: 1, inventory: [] as string[], price_tiers: [], review_reasons: [] as string[], bundle: null, sale_price_cents: null, sale_starts_at: null, sale_ends_at: null, status: 'active', owner_proof_status: 'none', attributes: r.attributes ?? {}, version: 1, created_at: now(),
    reserved_for: u.id, request_id: r.id, warranty_days: 0, expired_reason: null as string | null, featured_until: null as string | null, linked_account_id: null,
  };
  state.offers.push(offer);
  Object.assign(p, { status: 'accepted', offer_id: offer.id, updated_at: now() });
  for (const x of state.proposals) if (x.request_id === r.id && x.id !== p.id && x.status === 'pending') Object.assign(x, { status: 'declined', updated_at: now() });
  Object.assign(r, { status: 'accepted', accepted_proposal_id: p.id, updated_at: now() });
  notify(p.seller_id, 'selling', 'request_accepted', `Proposal accepted: ${r.title}`, 'The buyer accepted your proposal. You’ll get the usual new-order notice when they pay.', `/requests/${r.id}`);
  return { offerId: offer.id, request: reqView(r, u.id) };
});
// --- Watchlist & price alerts ------------------------------------------------------------
const RATES: Record<string, number> = { USD: 1, EUR: 0.92, EGP: 48.5 };
const onSale = (o: any) => listed(o) && availableOf(o) > 0;
const cheapestFor = (w: any) =>
  state.offers
    .filter((o) => onSale(o) && o.game.toLowerCase() === w.game.toLowerCase() && (!w.category || o.category_slug === w.category))
    .filter((o) => Object.entries(w.attributes ?? {}).every(([k, v]) => String(o.attributes?.[k] ?? '').toLowerCase() === String(v).toLowerCase()))
    .sort((a, b) => buyerPrice(a) - buyerPrice(b))[0];
/** What a buyer pays for one unit of a listing (seller price plus their commission). */
const buyerPrice = (o: any) => gross(o.seller_id, effectivePrice(o));
function watchView(w: any) {
  const conv = (c: number | null | undefined) => (c == null ? null : Math.round(c * (RATES[w.currency] ?? 1)));
  if (w.kind === 'offer') {
    const o = state.offers.find((x) => x.id === w.offer_id);
    const ok = !!o && onSale(o);
    return {
      id: w.id, kind: 'offer', currency: w.currency, targetCents: w.targetCents, createdAt: w.createdAt,
      offer: o ? { id: o.id, title: o.title, game: o.game, category_slug: o.category_slug, seller_name: userById(o.seller_id)?.display_name ?? 'Seller', attributes: o.attributes } : null,
      currentCents: o ? conv(buyerPrice(o)) : null, startCents: conv(w.start), available: ok, reached: ok && w.targetCents != null && conv(buyerPrice(o!))! <= w.targetCents,
    };
  }
  const low = cheapestFor(w);
  return {
    id: w.id, kind: 'game', currency: w.currency, targetCents: w.targetCents, createdAt: w.createdAt, game: w.game, category: w.category, attributes: w.attributes,
    cheapest: low ? { id: low.id, title: low.title, seller_name: userById(low.seller_id)?.display_name ?? 'Seller' } : null,
    currentCents: low ? conv(buyerPrice(low)) : null, startCents: conv(w.start), available: !!low, reached: !!low && w.targetCents != null && conv(buyerPrice(low))! <= w.targetCents,
  };
}
const fmt = (c: number, cur: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(c / 100);
/**
 * Stand-in for the worker's price check. So the demo shows an alert, a target below the current
 * price is met a few seconds later by a seller dropping the price to it.
 */
function simulateAlert(w: any) {
  setTimeout(() => {
    const v = watchView(w);
    if (w.targetCents == null || !v.available) return;
    if (!v.reached && w.kind === 'offer') {
      const o = state.offers.find((x) => x.id === w.offer_id)!;
      // The seller drops their price so the buyer price lands on the target.
      const rate = tierOf(o.seller_id).rateBps;
      o.price_cents = Math.max(1, Math.floor((Math.floor(w.targetCents / (RATES[w.currency] ?? 1)) * (10_000 - rate)) / 10_000));
      o.version++;
    }
    const after = watchView(w);
    if (!after.reached) return;
    const title = w.kind === 'offer' ? after.offer!.title : `${w.game}${w.category ? ` ${w.category}` : ''}`;
    const link = `/offers/${w.kind === 'offer' ? w.offer_id : after.cheapest!.id}`;
    notify(w.user_id, 'alerts', 'watch_price_drop', `Price drop: ${title} is now ${fmt(after.currentCents!, w.currency)}`, `At or below your target of ${fmt(w.targetCents, w.currency)}. (Demo: a seller just lowered the price.)`, link);
    save();
  }, 5000);
}
route('GET', '/me/watches', ({ me }) => state.watches.filter((w) => w.user_id === need(me).id).map(watchView));
route('POST', '/me/watches', ({ me, body }) => {
  const u = need(me);
  const currency = String(body.currency ?? 'USD').toUpperCase();
  if (!RATES[currency]) fail(400, 'unknown_currency', 'Unsupported currency');
  let w: any;
  if (body.offerId) {
    const o = state.offers.find((x) => x.id === body.offerId) ?? fail(404, 'not_found', 'Listing not found');
    if (o.seller_id === u.id) fail(400, 'own_offer', 'You can’t watch your own listing');
    if (state.watches.some((x) => x.user_id === u.id && x.offer_id === o.id)) fail(409, 'already_watching', 'You’re already watching this listing');
    w = { id: rid(), user_id: u.id, kind: 'offer', offer_id: o.id, targetCents: body.targetCents ?? null, currency, start: buyerPrice(o), createdAt: now() };
  } else {
    if (!body.game) fail(400, 'invalid_watch', 'Give an offer or a game to watch');
    if (body.attributes && Object.keys(body.attributes).length && !body.category) fail(400, 'invalid_watch', 'Pick a category to watch specific fields');
    w = { id: rid(), user_id: u.id, kind: 'game', game: body.game, category: body.category ?? null, attributes: body.attributes ?? {}, targetCents: body.targetCents ?? null, currency, createdAt: now() };
    const low0 = cheapestFor(w);
    w.start = low0 ? buyerPrice(low0) : null;
  }
  state.watches.unshift(w);
  simulateAlert(w);
  return watchView(w);
});
route('PATCH', '/me/watches/:id', ({ me, params, body }) => {
  const w = state.watches.find((x) => x.id === params[0] && x.user_id === need(me).id) ?? fail(404, 'not_found', 'Watch not found');
  w.targetCents = body.targetCents ?? null;
  if (body.currency && RATES[String(body.currency).toUpperCase()]) w.currency = String(body.currency).toUpperCase();
  simulateAlert(w);
  return watchView(w);
});
route('DELETE', '/me/watches/:id', ({ me, params }) => {
  const u = need(me);
  if (!state.watches.some((x) => x.id === params[0] && x.user_id === u.id)) fail(404, 'not_found', 'Watch not found');
  state.watches = state.watches.filter((x) => x.id !== params[0]);
});

route('GET', '/push/config', () => ({ enabled: false, vapidPublicKey: null }));
const PUSH_CATS: Array<[string, string]> = [['orders', 'Orders'], ['selling', 'Sales & payouts'], ['disputes', 'Disputes'], ['security', 'Security'], ['reminders', 'Reminders'], ['alerts', 'Price alerts']];
route('GET', '/me/push-subscriptions', ({ me }) => (need(me), []));
route('GET', '/me/push-preferences', ({ me }) => {
  const u = need(me);
  return PUSH_CATS.map(([category, label]) => ({ category, label, enabled: state.pushPrefs[u.id]?.[category] !== false }));
});
route('PATCH', '/me/push-preferences', ({ me, body }) => {
  const u = need(me);
  state.pushPrefs[u.id] = { ...state.pushPrefs[u.id], ...body };
  return PUSH_CATS.map(([category, label]) => ({ category, label, enabled: state.pushPrefs[u.id]![category] !== false }));
});

// --- Operations console --------------------------------------------------------------------
route('GET', '/admin/disputes', ({ me }) => {
  needStaff(me);
  return state.orders
    .filter((o) => o.dispute?.status === 'open')
    .map((o) => ({ id: o.dispute.id, order_id: o.id, ticket_id: o.dispute.ticket_id ?? null, reason: o.dispute.reason, category: o.dispute.category ?? 'other', statements: o.dispute.statements?.length ?? 0, amount_cents: o.amount_cents, currency: o.currency, created_at: o.dispute.created_at, title: o.offer_title, offer_title: o.offer_title }));
});
route('GET', '/admin/disputes/:id/case', ({ me, params }) => {
  needPerm(me, 'disputes.manage');
  const o = state.orders.find((x) => x.dispute?.id === params[0]) ?? fail(404, 'not_found', 'Dispute not found');
  const who = (id: string | null) => (!id ? 'system' : id === o.buyer_id ? 'buyer' : id === o.seller_id ? 'seller' : 'staff');
  const msgs = state.messages.filter((m) => m.room_id === o.room_id);
  const party = (id: string) => {
    const u = userById(id);
    return { id, display_name: u?.display_name ?? 'User', created_at: u?.created_at, kyc_tier: u?.kyc_tier, trust_level: state.trust[id] ?? 'new', offplatform_strikes: state.chatFlags.filter((f) => f.user_id === id && f.status !== 'dismissed' && f.strike !== false).length,
      orders_as_buyer: state.orders.filter((x) => x.buyer_id === id && x.status !== 'awaiting_payment').length, completed_sales: sellerStats(id).completed,
      disputes_opened: state.orders.filter((x) => x.dispute?.opened_by === id).length, disputes_against_as_seller: state.orders.filter((x) => x.dispute && x.seller_id === id).length, disputes_lost_as_seller: 0, chargebacks_filed: 0 };
  };
  const timeline = [
    ...o.events.map((e: any) => ({ at: e.created_at, type: 'status', who: 'system', text: `${e.from_status ?? 'created'} → ${e.to_status}`, meta: { reason: e.reason } })),
    ...msgs.map((m) => ({ at: m.created_at, type: 'message', who: m.kind === 'text' ? who(m.sender_id) : 'system', text: m.body, meta: { seq: m.seq, kind: m.kind } })),
    ...(o.dispute.statements ?? []).map((s: any) => ({ at: s.created_at, type: 'statement', who: s.role, text: s.body, meta: {} })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const lastSeller = msgs.filter((m) => m.sender_id === o.seller_id).at(-1);
  return {
    dispute: { id: o.dispute.id, status: o.dispute.status, category: o.dispute.category ?? 'other', reason: o.dispute.reason, opened_by: who(o.dispute.opened_by), created_at: o.dispute.created_at },
    order: { id: o.id, status: o.status, title: o.offer_title, quantity: o.quantity, amount_cents: o.amount_cents, currency: o.currency, protection: o.protection, created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at, protection_ends_at: o.protection_ends_at },
    snapshot: { offer: { title: o.offer_title }, captured_at: o.created_at },
    payment: { avs_result: 'pass/pass', cvv_result: 'pass', card_brand: 'visa', card_last4: '4242', billing_country: 'US', ip_country: 'US' },
    risk: [], checklist: null, buyer: party(o.buyer_id), seller: { ...party(o.seller_id), rates: { onTimePct: 96, disputePct: 0.8, chargebackPct: 0.1 } },
    statements: o.dispute.statements ?? [],
    facts: { deliveredLate: false, sellerLastMessageAt: lastSeller?.created_at ?? null, sellerRepliedAfterDispute: msgs.some((m) => m.sender_id === o.seller_id && m.created_at > o.dispute.created_at), listingChangedSincePurchase: false, cardCountryMatchesIp: true, chatChainIntact: true, checklistCompleted: null },
    chain: { valid: true, messages: msgs.length },
    timeline,
  };
});
route('POST', '/admin/disputes/:id/resolve', ({ me, params, body }) => {
  const staff = needStaff(me);
  const o = state.orders.find((x) => x.dispute?.id === params[0]) ?? fail(404, 'not_found', 'Dispute not found');
  if (o.amount_cents > 200_00) needPerm(me, 'orders.lead'); // above $200: the Support Lead decides
  if (body.outcome === 'split' && !(body.refundCents > 0 && body.refundCents < o.amount_cents)) fail(400, 'validation_error', 'refundCents must be between 1 and the order amount');
  o.dispute.status = body.outcome === 'buyer' ? 'resolved_buyer' : body.outcome === 'split' ? 'resolved_split' : 'resolved_seller';
  if (body.outcome === 'buyer') {
    // Refunds go to the buyer's Bullizard balance (no on-chain refund).
    transition(o, 'refunded', 'dispute_resolved_buyer');
    state.platform.escrow -= o.amount_cents;
    state.credit[o.buyer_id] = (state.credit[o.buyer_id] ?? 0) + o.amount_cents;
    notify(o.buyer_id, 'orders', 'order.refunded', 'Refunded to your balance', `${o.offer_title}: $${(o.amount_cents / 100).toFixed(2)} is back in your Bullizard balance.`, '/account/wallet');
    live(appendMessage(o.room_id, null, 'system', 'Dispute closed: refunded to the buyer.', [], { code: 'dispute_buyer', params: { note: body.note } }));
  } else if (body.outcome === 'split') {
    o.dispute.refund_cents = body.refundCents;
    state.platform.escrow -= body.refundCents;
    state.credit[o.buyer_id] = (state.credit[o.buyer_id] ?? 0) + body.refundCents;
    const keep = o.amount_cents - body.refundCents;
    o.seller_net_cents = Math.round((o.seller_net_cents * keep) / o.amount_cents);
    o.amount_cents = keep;
    releaseOrder(o, 'dispute_resolved_split');
    live(appendMessage(o.room_id, null, 'system', 'Dispute closed: part refunded to the buyer, the rest released to the seller.', [], { code: 'dispute_buyer', params: { split: true, refund_cents: body.refundCents, note: body.note } }));
  } else {
    live(appendMessage(o.room_id, null, 'system', 'Dispute closed: released to the seller.', [], { code: 'dispute_seller', params: { note: body.note } }));
    releaseOrder(o, 'dispute_resolved_seller');
  }
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: staff.display_name, actor_role: staff.role, ip: '203.0.113.7', action: 'dispute.resolved', target_type: 'dispute', target_id: params[0], details: { outcome: body.outcome } });
  return { disputeId: params[0], outcome: body.outcome };
});
route('GET', '/admin/risk-flags', ({ me }) => (needStaff(me), state.riskFlags.filter((f) => f.status === 'open')));
route('POST', '/admin/risk-flags/:id/review', ({ me, params, body }) => {
  needStaff(me);
  const f = state.riskFlags.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Flag not found');
  f.status = body.decision === 'clear' ? 'cleared' : 'confirmed';
  return f;
});
route('GET', '/admin/owner-proofs', ({ me }) => {
  needStaff(me);
  return state.ownerProofs.filter((p) => p.status === 'pending').map((p) => {
    const o = state.offers.find((x) => x.id === p.offer_id);
    const la = o?.linked_account_id ? state.linkedAccounts.find((a) => a.id === o.linked_account_id && !a.unlinked_at) : null;
    return { ...p, linked_platform: la?.provider ?? null, linked_name: la?.display_name ?? null, linked_profile_url: la?.profile_url ?? null, linked_account_created_at: la?.account_created_at ?? null, linked_at: la?.linked_at ?? null };
  });
});
route('POST', '/admin/owner-proofs/:id/review', ({ me, params, body }) => {
  needStaff(me);
  const p = state.ownerProofs.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Proof not found');
  p.status = body.approve ? 'verified' : 'rejected';
  const o = state.offers.find((x) => x.id === p.offer_id);
  if (o) o.owner_proof_status = p.status;
  return p;
});
route('GET', '/admin/chargebacks', ({ me }) => (needStaff(me), state.chargebacks));
route('GET', '/admin/ledger/summary', ({ me }) => {
  needStaff(me);
  const sellers = Object.values(state.balances).reduce((s, b) => s + b, 0);
  return [
    { kind: 'gateway_clearing', currency: 'USD', balance_cents: state.platform.gateway_clearing - state.platform.escrow },
    { kind: 'escrow', currency: 'USD', balance_cents: state.platform.escrow },
    { kind: 'treasury', currency: 'USD', balance_cents: state.platform.treasury },
    { kind: 'reserve', currency: 'USD', balance_cents: state.platform.reserve },
    { kind: 'seller_available', currency: 'USD', balance_cents: sellers },
  ];
});
route('GET', '/admin/reconciliation', ({ me }) => (needStaff(me), state.reconRuns));
route('POST', '/admin/reconciliation/run', ({ me }) => {
  needStaff(me);
  const run = { id: rid(), status: 'ok', started_at: now(), report: { issues: [], warnings: [], note: 'Demo run: books balanced.' } };
  state.reconRuns.unshift(run);
  return run;
});
route('GET', '/admin/audit', ({ me }) => (needStaff(me), state.audit));

// --- Status page ------------------------------------------------------------------------------
const COMPONENTS: Array<[string, string]> = [
  ['website', 'Website and app'], ['checkout', 'Card and crypto checkout'], ['delivery', 'Instant delivery and escrow release'],
  ['chat', 'Order chat and live updates'], ['payouts', 'Seller payouts'], ['notifications', 'Email and push notifications'],
];
const RANK: Record<string, number> = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };
const IMPACT: Record<string, string> = { none: 'operational', minor: 'degraded', major: 'partial_outage', critical: 'major_outage' };
route('GET', '/status', () => {
  const open = state.incidents.filter((i) => !i.resolved_at);
  const components = COMPONENTS.map(([id, name]) => {
    let status = 'operational';
    for (const i of open.filter((x) => x.components.includes(id))) {
      const s = i.kind === 'maintenance' ? (i.status === 'in_progress' ? 'maintenance' : 'operational') : IMPACT[i.impact] ?? 'degraded';
      if (RANK[s]! > RANK[status]!) status = s;
    }
    return { id, name, status, measured: 'operational' };
  });
  const top = components.reduce((a, c) => (RANK[c.status]! > RANK[a]! ? c.status : a), 'operational');
  return {
    status: top,
    description: top === 'operational' ? 'All systems operational' : top === 'maintenance' ? 'Scheduled maintenance in progress' : top === 'degraded' ? 'Some systems are slower than usual' : 'Some systems are having problems',
    components,
    incidents: open.filter((i) => i.kind === 'incident'),
    maintenance: open.filter((i) => i.kind === 'maintenance'),
    recent: state.incidents.filter((i) => i.resolved_at && Date.parse(i.resolved_at) > Date.now() - 14 * day),
    updatedAt: now(),
  };
});
route('GET', '/status/incidents/:id', ({ params }) => state.incidents.find((i) => i.id === params[0]) ?? fail(404, 'not_found', 'Incident not found'));
route('POST', '/status/subscribe', ({ body }) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email ?? ''))) fail(400, 'invalid_email', 'Enter a valid email address');
  if (!state.subscribers.includes(body.email)) state.subscribers.push(body.email);
  return { ok: true };
});
route('POST', '/status/confirm', () => ({ confirmed: true }));
route('POST', '/status/unsubscribe', () => ({ unsubscribed: true }));
route('GET', '/admin/incidents', ({ me }) => (needStaff(me), { components: COMPONENTS.map(([id, name]) => ({ id, name })), incidents: [...state.incidents].sort((a, b) => b.created_at.localeCompare(a.created_at)) }));
route('POST', '/admin/incidents', ({ me, body }) => {
  const u = needStaff(me);
  if (!body.title || String(body.title).length < 5) fail(400, 'validation_error', 'Give it a title');
  const maint = body.kind === 'maintenance';
  if (maint && (!body.scheduledStart || !body.scheduledEnd || body.scheduledEnd <= body.scheduledStart)) fail(400, 'invalid_schedule', 'Maintenance needs a start and a later end');
  const status = maint ? 'scheduled' : 'investigating';
  const i = {
    id: rid(), kind: maint ? 'maintenance' : 'incident', title: body.title, impact: maint ? 'none' : body.impact ?? 'minor', status, components: body.components ?? [],
    scheduled_start: body.scheduledStart ?? null, scheduled_end: body.scheduledEnd ?? null, created_at: now(), resolved_at: null,
    updates: [{ status, body: body.body, at: now() }],
  };
  state.incidents.unshift(i);
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: u.display_name, actor_role: u.role, ip: '203.0.113.7', action: 'status.incident_created', target_type: 'incident', target_id: i.id, details: { title: i.title } });
  return i;
});
route('POST', '/admin/incidents/:id/updates', ({ me, params, body }) => {
  needStaff(me);
  const i = state.incidents.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Incident not found');
  if (i.resolved_at) fail(400, 'incident_closed', 'This incident is already closed');
  i.status = body.status;
  if (body.impact && i.kind === 'incident') i.impact = body.impact;
  if (['resolved', 'completed'].includes(body.status)) i.resolved_at = now();
  i.updates.unshift({ status: body.status, body: body.body, at: now() });
  return i;
});

// --- Seller debts, currency top-ups, fraud model, privacy --------------------------------------
route('GET', '/admin/debts', ({ me, query }) => {
  needStaff(me);
  const open = (query.get('status') ?? 'open') === 'open';
  return state.debts.filter((d) => (open ? !d.closed_at : !!d.closed_at)).map((d) => ({ ...d, display_name: userById(d.seller_id)?.display_name, email: userById(d.seller_id)?.email }));
});
route('GET', '/seller/debts', ({ me }) => state.debts.filter((d) => d.seller_id === needSeller(me).id && !d.closed_at));
route('POST', '/seller/debts/:id/pay', ({ me, params }) => {
  const u = needSeller(me);
  const d = state.debts.find((x) => x.id === params[0] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Debt not found');
  // The hosted checkout is simulated: the repayment succeeds straight away.
  state.balances[u.id] = (state.balances[u.id] ?? 0) + d.owed_cents;
  Object.assign(d, { owed_cents: 0, closed_at: now(), closed_reason: 'repaid' });
  return { paymentId: rid(), amountCents: d.peak_cents, currency: d.currency, checkoutUrl: '/sell/money?repaid=1' };
});
// Round 25 (B6): exact rates; the price a buyer sees in EUR at checkout is the price charged (held 15 minutes).
const FX_TTL_MS = 15 * 60_000;
route('GET', '/fx/rates', () => {
  const asOf = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
  return {
    base: 'USD', settlement: 'USD', spreadBps: 0, quote_ttl_seconds: FX_TTL_MS / 1000, as_of: asOf,
    exact: { EGP: RATES.EGP!.toFixed(8), EUR: RATES.EUR!.toFixed(8) },
    rates: (['EUR', 'EGP'] as const).map((c) => ({ currency: c, rate: RATES[c]!.toFixed(8), fetched_at: asOf, as_of: asOf, source: 'static' })),
  };
});
// Round 25 (B5): payment methods for the viewer's currency (only crypto for the beta).
route('GET', '/payment-methods', ({ query }) => {
  const cur = String(query.get('currency') ?? 'USD').toUpperCase();
  if (!RATES[cur]) fail(400, 'unsupported_currency', 'Unsupported currency');
  return [{ id: 'crypto', currencies: ['USD', 'EUR'], enabled: true, pay_currency: cur === 'EUR' ? 'EUR' : 'USD' }];
});
route('GET', '/admin/fx/position', ({ me }) => {
  needStaff(me);
  return {
    positions: [
      { currency: 'USD', positionCents: 0, sellerBalancesCents: Object.values(state.balances).reduce((s, b) => s + b, 0), pspExpectedCents: Object.values(state.balances).reduce((s, b) => s + b, 0) + state.platform.treasury, shortfallCents: 0 },
      { currency: 'EUR', positionCents: -2_310_00, sellerBalancesCents: 2_310_00, pspExpectedCents: 2_400_00, shortfallCents: 0 },
      { currency: 'EGP', positionCents: -41_710_00, sellerBalancesCents: 41_710_00, pspExpectedCents: 0, shortfallCents: 41_710_00 },
    ],
    conversions: [],
  };
});
route('GET', '/admin/fx/topups', ({ me }) => (needStaff(me), { provider: 'mock', autoApproveCents: 0, topups: state.fxTopups }));
route('POST', '/admin/fx/topups/plan', ({ me }) => (needStaff(me), []));
route('POST', '/admin/fx/topups/:id/decide', ({ me, params, body }) => {
  const u = needStaff(me);
  const t = state.fxTopups.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Top-up not found');
  if (t.status !== 'proposed') fail(409, 'already_decided', `This top-up is ${t.status}`);
  Object.assign(t, body.approve ? { status: 'completed', from_cents: Math.round(t.to_cents / 0.79 / 0.995), decided_by_name: u.display_name } : { status: 'rejected', decided_by_name: u.display_name });
  return t;
});
route('GET', '/admin/fraud/model-report', ({ me, query }) => {
  needStaff(me);
  return {
    windowDays: Number(query.get('days') ?? 180), mode: 'shadow', threshold: 0.5, scored: 1_284, modelScored: 1_262, labelled: 913, unlabelled: 371,
    heuristicOnly: { orders: 913, fraud: 21, auc: 0.87, flagged: 30, caught: 15, precision: 0.5, recall: 0.7143 },
    models: [{
      modelVersion: '3f9a1c0e7b21', orders: 902, fraud: 21,
      heuristic: { auc: 0.871, flagged: 29, caught: 15, precision: 0.5172, recall: 0.7143 },
      model: { auc: 0.934, flagged: 24, caught: 18, precision: 0.75, recall: 0.8571 },
      combined: { auc: 0.941, flagged: 35, caught: 19, precision: 0.5429, recall: 0.9048 },
      onlyModelFlagged: { fraud: 4, legit: 2 }, onlyHeuristicFlagged: { fraud: 1, legit: 9 },
    }],
  };
});
route('POST', '/admin/users/:id/erase-chat', ({ me, params, body }) => {
  const u = needStaff(me);
  if (!userById(params[0]!)) fail(404, 'not_found', 'User not found');
  if (!body.reason || String(body.reason).length < 5) fail(400, 'validation_error', 'Give a reason');
  const open = state.orders.some((o) => (o.buyer_id === params[0] || o.seller_id === params[0]) && o.status === 'disputed');
  if (open) fail(409, 'legal_hold', 'Can’t erase while there is an open dispute; the messages are evidence');
  let n = 0;
  for (const m of state.messages) if (m.sender_id === params[0] && m.body !== null) (m.body = null, (m.erased = true), n++);
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: u.display_name, actor_role: u.role, ip: '203.0.113.7', action: 'chat.erased', target_type: 'user', target_id: params[0], details: { reason: body.reason } });
  return { erased: true, alreadyErased: n === 0 };
});

// --- Support tickets ---------------------------------------------------------------------------
const TICKET_CATS = ['order', 'payment', 'account', 'selling', 'report', 'other'];
function ticketOrder(id: string | null) {
  const o = id ? state.orders.find((x) => x.id === id) : null;
  return o ? { id: o.id, status: o.status, amount_cents: o.amount_cents, currency: o.currency, offer_title: o.offer_title, game: o.game, buyer_name: userById(o.buyer_id)?.display_name, seller_name: userById(o.seller_id)?.display_name } : null;
}
function ticketView(t: any, staff: boolean) {
  const u = userById(t.user_id);
  const o = t.dispute_id ? state.orders.find((x) => x.dispute?.id === t.dispute_id) : null;
  const dispute = o ? { id: o.dispute.id, order_id: o.id, status: o.dispute.status, category: o.dispute.category, reason: o.dispute.reason, created_at: o.dispute.created_at } : null;
  const base = { ...t, messages: undefined, user_name: u?.display_name, order: ticketOrder(t.order_id), dispute_id: t.dispute_id ?? null, dispute };
  const messages = t.messages
    .filter((m: any) => staff || !m.internal)
    .map((m: any) => ({ ...m, author_name: m.staff && !staff ? 'Bullizard Support' : userById(m.author_id)?.display_name ?? 'Support' }));
  if (!staff) return { ...base, assigned_to: undefined, messages: messages.map(({ internal: _i, author_id: _a, ...m }: any) => m) };
  return { ...base, user_email: u?.email, assignee_name: t.assigned_to ? userById(t.assigned_to)?.display_name : null, messages };
}
const myTicket = (me: DemoUser | null, id: string) => state.tickets.find((t) => t.id === id && t.user_id === need(me).id) ?? fail(404, 'not_found', 'Ticket not found');
route('GET', '/support/tickets', ({ me }) => {
  const u = need(me);
  return state.tickets.filter((t) => t.user_id === u.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((t) => ({ ...ticketView(t, false), messages: undefined, last_from_staff: t.messages.filter((m: any) => !m.internal).at(-1)?.staff ?? false }));
});
route('POST', '/support/tickets', ({ me, body }) => ticketView(createTicketRecord(need(me), body), false));
function createTicketRecord(u: DemoUser, body: any) {
  if (!TICKET_CATS.includes(body.category)) fail(400, 'validation_error', 'Choose a topic');
  if (String(body.subject ?? '').trim().length < 3 || String(body.body ?? '').trim().length < 2) fail(400, 'validation_error', 'Add a subject and some details');
  if (state.tickets.filter((t) => t.user_id === u.id && t.status !== 'resolved').length >= 5) fail(400, 'too_many_tickets', 'You have 5 open requests. Reply on one of those before opening another.');
  let priority = 'normal';
  if (body.orderId) {
    const o = state.orders.find((x) => x.id === body.orderId && (x.buyer_id === u.id || x.seller_id === u.id)) ?? fail(404, 'not_found', 'Order not found');
    if (['order', 'payment'].includes(body.category) && ['paid', 'delivered', 'disputed'].includes(o.status)) priority = 'high';
  }
  const t = {
    id: rid(), number: 10001 + state.tickets.length, user_id: u.id, order_id: body.orderId ?? null, category: body.category, subject: String(body.subject).trim(), status: 'open', priority,
    assigned_to: null, created_at: now(), updated_at: now(), first_response_at: null, resolved_at: null,
    messages: [{ id: rid(), author_id: u.id, staff: false, internal: false, body: String(body.body).trim(), created_at: now() }],
  };
  state.tickets.unshift(t);
  notify(u.id, 'support', 'support_received', `We got your request #${t.number}`, `Thanks for getting in touch about "${t.subject}". You'll get a notification when support replies.`, `/support/${t.id}`);
  // Stand-in for a support agent, so the demo shows a reply arriving.
  setTimeout(() => {
    const admin = state.users.find((x) => x.role === 'admin')!;
    t.messages.push({ id: rid(), author_id: admin.id, staff: true, internal: false, body: `Hi ${u.display_name}, thanks for the details. We're looking into this now and will update you here. (Demo: this reply is simulated.)`, created_at: now() });
    Object.assign(t, { status: 'pending', first_response_at: now(), assigned_to: admin.id, updated_at: now() });
    notify(u.id, 'support', 'support_reply', `New reply on request #${t.number}`, 'Bullizard Support replied to your request.', `/support/${t.id}`);
    save();
  }, 6000);
  return t;
}
route('GET', '/support/tickets/:id', ({ me, params }) => ticketView(myTicket(me, params[0]!), false));
route('POST', '/support/tickets/:id/messages', ({ me, params, body }) => {
  const t = myTicket(me, params[0]!);
  if (String(body.body ?? '').trim().length < 2) fail(400, 'validation_error', 'Write a reply');
  t.messages.push({ id: rid(), author_id: t.user_id, staff: false, internal: false, body: String(body.body).trim(), created_at: now() });
  Object.assign(t, { status: 'open', resolved_at: null, updated_at: now() });
  return ticketView(t, false);
});
route('POST', '/support/tickets/:id/resolve', ({ me, params }) => {
  const t = myTicket(me, params[0]!);
  Object.assign(t, { status: 'resolved', resolved_at: now(), updated_at: now() });
  return ticketView(t, false);
});
route('GET', '/admin/support/tickets', ({ me, query }) => {
  const u = needPerm(me, 'support.manage');
  const status = query.get('status') ?? 'active';
  return state.tickets
    .filter((t) => (status === 'active' ? t.status !== 'resolved' : t.status === status) && (query.get('mine') !== 'true' || t.assigned_to === u.id))
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || Number(b.priority === 'high') - Number(a.priority === 'high') || a.updated_at.localeCompare(b.updated_at))
    .map((t) => ({ ...ticketView(t, true), messages: t.messages.filter((m: any) => !m.internal).length }));
});
const staffTicket = (me: DemoUser | null, id: string) => (needPerm(me, 'support.manage'), state.tickets.find((t) => t.id === id) ?? fail(404, 'not_found', 'Ticket not found'));
route('GET', '/admin/support/tickets/:id', ({ me, params }) => ticketView(staffTicket(me, params[0]!), true));
route('POST', '/admin/support/tickets/:id/messages', ({ me, params, body }) => {
  const t = staffTicket(me, params[0]!);
  const u = me!;
  t.messages.push({ id: rid(), author_id: u.id, staff: true, internal: !!body.internal, body: String(body.body ?? '').trim(), created_at: now() });
  if (!body.internal) {
    Object.assign(t, { status: body.resolve ? 'resolved' : 'pending', resolved_at: body.resolve ? now() : null, first_response_at: t.first_response_at ?? now(), assigned_to: t.assigned_to ?? u.id });
    notify(t.user_id, 'support', 'support_reply', body.resolve ? `Request #${t.number} resolved` : `New reply on request #${t.number}`, 'Bullizard Support replied to your request.', `/support/${t.id}`);
  }
  t.updated_at = now();
  audit(u, body.internal ? 'support.note' : 'support.reply', 'support_ticket', t.id, {});
  return ticketView(t, true);
});
/** Round 24, as the API: staff who decide disputes open one from the ticket (the order page has no dispute form). */
route('POST', '/admin/support/tickets/:id/dispute', ({ me, params, body }) => {
  needPerm(me, 'disputes.manage');
  const t = state.tickets.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Ticket not found');
  if (t.dispute_id) fail(409, 'ticket_has_dispute', 'A dispute was already opened from this ticket');
  const orderId = t.order_id ?? body.orderId ?? fail(400, 'order_required', 'This ticket names no order; pick the customer’s order first');
  const o = state.orders.find((x) => x.id === orderId) ?? fail(404, 'not_found', 'Order not found');
  if (o.buyer_id !== t.user_id && o.seller_id !== t.user_id) fail(403, 'not_ticket_order', 'The order does not belong to the customer who wrote this ticket');
  const customer = userById(t.user_id)!;
  const first = t.messages.find((m: any) => !m.staff);
  const d = openDisputeRecord(customer, o, String(body.reason ?? t.subject), body.category ?? 'other', first?.body ?? t.subject, { ticket_id: t.id });
  Object.assign(t, { dispute_id: d.id, order_id: o.id, priority: 'high', updated_at: now() });
  t.messages.push({ id: rid(), author_id: me!.id, staff: true, internal: true, body: `Dispute opened on order ${o.ref ?? o.id} from this ticket.`, created_at: now() });
  audit(me!, 'dispute.open_from_ticket', 'dispute', d.id, { ticketId: t.id });
  return { dispute: { ...d, statements: undefined, lead_review: o.amount_cents > 200_00 }, ticket: permsOf(me!).has('support.manage') ? ticketView(t, true) : null };
});
route('PATCH', '/admin/support/tickets/:id', ({ me, params, body }) => {
  const t = staffTicket(me, params[0]!);
  if (body.status) Object.assign(t, { status: body.status, resolved_at: body.status === 'resolved' ? now() : null });
  if (body.priority) t.priority = body.priority;
  if (body.assignedTo !== undefined) t.assigned_to = body.assignedTo;
  t.updated_at = now();
  audit(me!, 'support.update', 'support_ticket', t.id, body);
  return ticketView(t, true);
});

// --- Analytics -------------------------------------------------------------------------------
/** Deterministic pseudo-random numbers, so the demo charts look the same on every visit. */
function rng(seedText: string) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100_000) / 100_000;
  };
}
const ANALYTICS_DAYS = [7, 30, 90, 365];
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Daily history for the current and previous period, ending today (UTC). */
function history(days: number, seedText: string, perDay: (r: () => number, i: number, date: string) => Record<string, number>) {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const r = rng(seedText);
  return Array.from({ length: days * 2 }, (_, k) => {
    const t = today - (days * 2 - 1 - k) * day;
    const date = dayKey(t);
    return { date, ...perDay(r, k, date) };
  });
}
/** Sum days into buckets (weeks for a year, else days). */
function bucketed<T extends { date: string }>(rows: T[], days: number, keys: string[]) {
  if (days <= 90) return rows;
  const out: any[] = [];
  for (let i = 0; i < rows.length; i += 7) {
    const chunk = rows.slice(i, i + 7);
    out.push({ date: chunk[0]!.date, ...Object.fromEntries(keys.map((k) => [k, chunk.reduce((s, x: any) => s + (x[k] ?? 0), 0)])) });
  }
  return out;
}
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 100 : null);
const wave = (i: number) => 1 + 0.18 * Math.sin((i / 7) * 2 * Math.PI) + 0.002 * i;

route('GET', '/seller/analytics', ({ me, query }) => {
  const u = needSeller(me);
  const days = Number(query.get('days') ?? 30);
  if (!ANALYTICS_DAYS.includes(days)) fail(400, 'validation_error', 'days must be 7, 30, 90 or 365');
  const mine = state.offers.filter((o) => o.seller_id === u.id);
  const avg = mine.length ? mine.reduce((s, o) => s + o.price_cents, 0) / mine.length : 30_00;
  const real = state.orders.filter((o) => o.seller_id === u.id && o.paid_at);
  const rows = history(days, `seller:${u.id}`, (r, i, date) => {
    const views = Math.round((60 + r() * 50) * wave(i));
    const orders = Math.round(views * (0.035 + r() * 0.03));
    const returning = Math.round(orders * (0.3 + r() * 0.15));
    const gross = Math.round(orders * avg * (0.7 + r() * 0.6));
    const extra = real.filter((o) => o.paid_at.slice(0, 10) === date);
    return {
      views: views + extra.length * 3,
      orders: orders + extra.length,
      gross_cents: gross + extra.reduce((s, o) => s + o.amount_cents, 0),
      net_cents: Math.round(gross * 0.9) + extra.reduce((s, o) => s + o.seller_net_cents, 0),
      new_buyers: orders - returning + extra.length,
      returning_buyers: returning,
      refunded: r() < 0.25 ? 1 : 0,
      disputed: r() < 0.12 ? 1 : 0,
    };
  });
  const totals = (xs: any[]) => {
    const sum = (k: string) => xs.reduce((s, x) => s + x[k], 0);
    const buyers = sum('new_buyers') + sum('returning_buyers');
    return {
      orders: sum('orders'), grossCents: sum('gross_cents'), netCents: sum('net_cents'), avgOrderCents: sum('orders') ? Math.round(sum('gross_cents') / sum('orders')) : null,
      views: sum('views'), conversionPct: pctOf(sum('orders'), sum('views')), buyers, repeatBuyers: sum('returning_buyers'), repeatBuyerPct: pctOf(sum('returning_buyers'), buyers),
      refundRatePct: pctOf(sum('refunded'), sum('orders')), disputeRatePct: pctOf(sum('disputed'), sum('orders')),
    };
  };
  const cur = rows.slice(days);
  const t = totals(cur);
  const weights = mine.map((o, k) => ({ o, w: rng(o.id)() + (k < 3 ? 1 : 0.2) }));
  const wsum = weights.reduce((s, x) => s + x.w, 0) || 1;
  const offers = weights
    .map(({ o, w }) => {
      const views = Math.round((t.views * w) / wsum);
      const orders = Math.round((t.orders * w) / wsum);
      return { id: o.id, title: o.title, game: o.game, category_slug: o.category_slug, status: o.status, views, orders, gross_cents: orders * o.price_cents, conversion_pct: pctOf(orders, views) };
    })
    .filter((o) => o.views > 0 || o.orders > 0)
    .sort((a, b) => b.gross_cents - a.gross_cents)
    .slice(0, 20);
  return {
    days, bucket: days > 90 ? 'week' : 'day', totals: t, previous: totals(rows.slice(0, days)),
    series: bucketed(cur, days, ['views', 'orders', 'gross_cents', 'net_cents', 'new_buyers', 'returning_buyers']),
    offers,
  };
});

// Retention: synthetic but consistent cohorts (each cohort's later months are what the series sums).
route('GET', '/admin/analytics/retention', ({ me, query }) => {
  needPerm(me, 'analytics.view');
  const months = Number(query.get('months') ?? 12);
  if (![6, 12, 24].includes(months)) fail(400, 'validation_error', 'months must be 6, 12 or 24');
  const today = new Date();
  // Cohorts start 24 months back so 6- and 12-month views show the same recent months.
  const all = Array.from({ length: 25 }, (_, i) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 24 + i, 1)).toISOString().slice(0, 7));
  const list = all.slice(-months);
  const build = (key: string, base: number, first: number, decay: number) => {
    const r = rng(`retention:${key}`);
    return all.map((c, i) => {
      const size = Math.round((base + i * base * 0.03) * (0.85 + r() * 0.3) * (all.length - 1 === i ? today.getUTCDate() / 30 : 1));
      // The current month is still running: later-month activity is partial too.
      const part = (k: number) => (i + k === all.length - 1 ? today.getUTCDate() / 30 : 1);
      const retained = all.slice(i).map((_, k) => (k === 0 ? size : Math.round(size * first * decay ** (k - 1) * (0.85 + r() * 0.3) * part(k))));
      return { cohort: c, size, retained };
    });
  };
  const buyersAll = build('buyers', 420, 0.31, 0.88);
  const sellersAll = build('sellers', 38, 0.62, 0.93);
  const activeIn = (cs: typeof buyersAll, m: number) => cs.slice(0, m + 1).reduce((t, c, i) => t + (c.retained[m - i] ?? 0), 0);
  const series = all.map((month, m) => {
    const activeBuyers = activeIn(buyersAll, m);
    const activeSellers = activeIn(sellersAll, m);
    const last = m > 0 ? activeIn(sellersAll, m - 1) : 0;
    const churned = m > 0 ? Math.max(0, Math.round(last - (activeSellers - sellersAll[m]!.size))) : 0;
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return {
      month, active_buyers: activeBuyers, returning_buyers: activeBuyers - buyersAll[m]!.size, returning_pct: pct(activeBuyers - buyersAll[m]!.size, activeBuyers),
      active_sellers: activeSellers, new_sellers: sellersAll[m]!.size, sellers_last_month: last,
      partial: m === all.length - 1, churned_sellers: m === all.length - 1 ? null : churned, seller_churn_pct: m === all.length - 1 ? null : pct(churned, last),
    };
  });
  const r = rng('retention:repeat');
  const repeat = all.map((c, i) => {
    const buyers = buyersAll[i]!.size;
    const complete = Date.parse(`${c}-01T00:00:00Z`) + 120 * 86_400_000 < Date.now();
    const share = complete ? 0.27 + r() * 0.08 : 0.12 + r() * 0.08;
    const n = Math.round(buyers * share);
    return { cohort: c, buyers, repeat_90d: n, repeat_pct: buyers ? Math.round((n / buyers) * 1000) / 10 : null, complete };
  });
  const keep = (x: { cohort: string }) => list.includes(x.cohort);
  const done = repeat.filter((x) => keep(x) && x.complete);
  const sum = (k: 'buyers' | 'repeat_90d') => done.reduce((t, x) => t + x[k], 0);
  const trim = (cs: typeof buyersAll) => cs.filter(keep).map((c) => ({ ...c, retained: c.retained.slice(0, list.length - list.indexOf(c.cohort)) }));
  return {
    months, buyerCohorts: trim(buyersAll), sellerCohorts: trim(sellersAll), series: series.filter((x) => list.includes(x.month)),
    repeat: repeat.filter(keep), repeat90dPct: sum('buyers') ? Math.round((sum('repeat_90d') / sum('buyers')) * 1000) / 10 : null,
  };
});
route('GET', '/admin/analytics', ({ me, query }) => {
  needPerm(me, 'analytics.view');
  const days = Number(query.get('days') ?? 30);
  if (!ANALYTICS_DAYS.includes(days)) fail(400, 'validation_error', 'days must be 7, 30, 90 or 365');
  const rows = history(days, 'business', (r, i) => {
    const orders = Math.round((340 + r() * 120) * wave(i));
    const gmv = Math.round(orders * (38_00 + r() * 14_00));
    const card = Math.round(orders * 0.86);
    return {
      orders, gmv_cents: gmv, take_cents: Math.round(gmv * (0.088 + r() * 0.014)), card_orders: card,
      disputes: Math.round(orders * (0.009 + r() * 0.009)), chargebacks: Math.round(card * (0.002 + r() * 0.004)),
      refunds: Math.round(orders * (0.012 + r() * 0.01)), new_buyers: Math.round(orders * 0.22), new_sellers: Math.round(2 + r() * 5),
    };
  });
  const totals = (xs: any[]) => {
    const sum = (k: string) => xs.reduce((s, x) => s + x[k], 0);
    return {
      orders: sum('orders'), gmvCents: sum('gmv_cents'), takeCents: sum('take_cents'), takeRatePct: pctOf(sum('take_cents'), sum('gmv_cents')),
      avgOrderCents: Math.round(sum('gmv_cents') / Math.max(1, sum('orders'))), refunds: sum('refunds'), refundedCents: Math.round(sum('refunds') * 41_00),
      refundRatePct: pctOf(sum('refunds'), sum('orders')), disputes: sum('disputes'), disputeRatePct: pctOf(sum('disputes'), sum('orders')),
      chargebacks: sum('chargebacks'), chargebackRatePct: pctOf(sum('chargebacks'), sum('card_orders')),
      buyers: Math.round(sum('orders') * 0.61), sellers: Math.min(4_800, Math.round(sum('orders') * 0.09)), newBuyers: sum('new_buyers'), newSellers: sum('new_sellers'),
    };
  };
  const cur = rows.slice(days);
  const t = totals(cur);
  const series = bucketed(cur, days, ['orders', 'gmv_cents', 'take_cents', 'disputes', 'chargebacks', 'card_orders']).map((x: any) => ({
    date: x.date, orders: x.orders, gmv_cents: x.gmv_cents, take_cents: x.take_cents, take_rate_pct: pctOf(x.take_cents, x.gmv_cents),
    dispute_rate_pct: pctOf(x.disputes, x.orders), chargeback_rate_pct: pctOf(x.chargebacks, x.card_orders),
  }));
  const share: Record<string, [number, number, number]> = {
    accounts: [0.24, 0.112, 0.021], currency: [0.2, 0.099, 0.012], items: [0.15, 0.099, 0.014], keys: [0.13, 0.08, 0.006], boosting: [0.1, 0.099, 0.017],
    'gift-cards': [0.09, 0.0499, 0.004], 'top-ups': [0.06, 0.0499, 0.005], 'video-games': [0.03, 0.0499, 0.004],
  };
  const games = [...new Set(state.offers.map((o) => o.game))].map((g) => ({ g, w: rng(g)() })).sort((a, b) => b.w - a.w).slice(0, 10);
  const gw = games.reduce((s, x) => s + x.w, 0);
  return {
    days, bucket: days > 90 ? 'week' : 'day', totals: t, previous: totals(rows.slice(0, days)), series,
    money: {
      promoCents: Math.round(t.gmvCents * 0.004), referralCents: Math.round(t.takeCents * 0.06), creatorCents: Math.round(t.takeCents * 0.02),
      pspFeeCents: Math.round(t.gmvCents * 0.005), payoutFeeCents: Math.round(t.gmvCents * 0.0008),
      buyerCreditOutstandingCents: 1_842_00, withdrawalsPendingCents: 12_460_00, withdrawalsPending: 9, medianReleaseHours: 7.5,
    },
    categories: Object.entries(share).map(([slug, [w, tr, dr]]) => ({
      category_slug: slug, orders: Math.round(t.orders * w), gmv_cents: Math.round(t.gmvCents * w), take_cents: Math.round(t.gmvCents * w * tr), take_rate_pct: tr * 100, dispute_rate_pct: dr * 100,
    })),
    games: games.map(({ g, w }) => ({ game: g, orders: Math.round((t.orders * 0.7 * w) / gw), gmv_cents: Math.round((t.gmvCents * 0.7 * w) / gw) })),
  };
});

// --- Staff permissions, compliance, treasury, tax, staff ------------------------------------
const ALL_PERMS = [
  'orders.lead', 'controls.manage', 'withdrawals.second_approve',
  'orders.view_any', 'disputes.manage', 'owner_proofs.review', 'reviews.moderate', 'risk.review', 'users.suspend', 'aml.review', 'aml.sar',
  'chargebacks.manage', 'orders.refund_after_release', 'orders.release', 'reconciliation.run', 'promos.manage', 'treasury.request', 'treasury.approve', 'ledger.view',
  'ledger.adjust', 'payout_holds.set', 'fx.manage', 'tax.manage', 'invoices.manage', 'keys.manage', 'retention.manage', 'audit.view', 'staff.manage', 'status.manage',
  'analytics.view', 'support.manage', 'moderation.manage', 'ranks.manage', 'leagues.manage', 'rules.manage', 'newsletter.export',
];
const ROLE_PERMS: Record<string, string[]> = {
  arbiter: ['orders.view_any', 'disputes.manage', 'owner_proofs.review', 'reviews.moderate', 'orders.refund_after_release', 'orders.release', 'moderation.manage'],
  support: ['orders.view_any', 'reviews.moderate', 'ledger.view', 'status.manage', 'support.manage', 'moderation.manage', 'orders.release', 'leagues.manage', 'rules.manage'],
  lead: ['orders.view_any', 'reviews.moderate', 'ledger.view', 'status.manage', 'support.manage', 'moderation.manage', 'orders.release', 'leagues.manage', 'rules.manage', 'disputes.manage', 'owner_proofs.review', 'orders.refund_after_release', 'orders.lead', 'users.suspend', 'audit.view', 'withdrawals.second_approve'],
  finance: ['controls.manage', 'chargebacks.manage', 'orders.refund_after_release', 'reconciliation.run', 'promos.manage', 'treasury.request', 'treasury.approve', 'ledger.view', 'ledger.adjust', 'payout_holds.set', 'fx.manage', 'tax.manage', 'invoices.manage', 'analytics.view'],
  compliance: ['orders.view_any', 'risk.review', 'users.suspend', 'aml.review', 'aml.sar', 'payout_holds.set', 'ledger.view', 'audit.view', 'retention.manage', 'analytics.view'],
  marketing: ['newsletter.export'],
  admin: ALL_PERMS,
};
const permsOf = (u: DemoUser) => new Set([u.role, ...(u.staff_roles ?? [])].flatMap((r) => ROLE_PERMS[r] ?? []));
const needPerm = (me: DemoUser | null, p: string) => {
  const u = need(me);
  if (!permsOf(u).has(p)) fail(403, 'insufficient_permission', `Needs the ${p} permission`);
  return u;
};
const audit = (u: DemoUser, action: string, target_type: string, target_id: string, details: object) =>
  state.audit.unshift({ id: rid(), created_at: now(), actor_name: u.display_name, actor_role: u.role, ip: '203.0.113.7', action, target_type, target_id, details });
route('GET', '/me/permissions', ({ me }) => ({ permissions: [...permsOf(need(me))] }));

const caseView = (c: any) => ({ ...c, display_name: userById(c.user_id)?.display_name ?? 'Unknown user' });
route('GET', '/admin/aml/cases', ({ me, query }) => {
  needPerm(me, 'aml.review');
  const status = query.get('status');
  return state.amlCases.filter((c) => !status || c.status === status).map(caseView);
});
route('GET', '/admin/aml/cases/:id', ({ me, params }) => {
  needPerm(me, 'aml.review');
  const c = state.amlCases.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Case not found');
  const u = userById(c.user_id)!;
  const since = Date.now() - 90 * day;
  const sum = (xs: any[]) => xs.filter((o) => Date.parse(o.created_at) > since).reduce((s, o) => s + (o.amount_cents ?? 0), 0);
  return {
    case: caseView(c),
    user: { display_name: u.display_name, email: u.email, legal_name: u.legal_name, kyc_tier: u.kyc_tier, wallet_address: null },
    money: {
      sales_90d_cents: sum(state.orders.filter((o) => o.seller_id === u.id)) + (state.monthlySales[u.id] ?? 0) * 2,
      purchases_90d_cents: sum(state.orders.filter((o) => o.buyer_id === u.id)),
      withdrawn_90d_cents: sum(state.withdrawals.filter((w) => w.user_id === u.id)) + Math.round((state.monthlySales[u.id] ?? 0) * 1.6),
    },
  };
});
route('POST', '/admin/aml/cases/:id/notes', ({ me, params, body }) => {
  const u = needPerm(me, 'aml.review');
  const c = state.amlCases.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Case not found');
  c.notes.push({ note: body.note, at: now(), by: u.display_name });
  return caseView(c);
});
route('POST', '/admin/aml/cases/:id/decide', ({ me, params, body }) => {
  const u = needPerm(me, body.decision === 'report' ? 'aml.sar' : 'aml.review');
  const c = state.amlCases.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Case not found');
  if (body.decision === 'report' && !body.sarReference) fail(400, 'validation_error', 'Enter the SAR reference from the FIU');
  c.status = { clear: 'cleared', escalate: 'escalated', hold: c.status, report: 'reported' }[body.decision as string] ?? c.status;
  if (body.decision === 'hold') c.holds_payouts = true;
  if (body.decision === 'clear') c.holds_payouts = false;
  if (body.decision === 'report') c.sar_reference = body.sarReference;
  c.notes.push({ decision: body.decision, note: body.note, at: now(), by: u.display_name });
  audit(u, `aml.${body.decision}`, 'aml_case', c.id, { rule: c.rule });
  return caseView(c);
});

route('GET', '/admin/treasury', ({ me }) => {
  needPerm(me, 'treasury.request');
  const p = state.platform;
  return {
    balance: { currency: 'USD', availableCents: p.treasury, reserveCents: p.reserve, taxPayableCents: p.tax_payable, withdrawnToDateCents: p.withdrawn },
    withdrawals: state.treasury,
  };
});
route('POST', '/admin/treasury/withdrawals', ({ me, body }) => {
  const u = needPerm(me, 'treasury.request');
  const pool = body.source === 'tax_payable' ? state.platform.tax_payable : state.platform.treasury;
  if (!(body.amountCents > 0) || body.amountCents > pool) fail(400, 'insufficient_funds', 'More than is available in that account');
  if (!body.note || String(body.note).length < 3) fail(400, 'validation_error', 'Say what the money is for');
  const w = { id: rid(), amount_cents: body.amountCents, currency: 'USD', note: body.note, source: body.source ?? 'treasury', status: 'pending_approval', requested_by: u.id, requested_by_name: u.display_name, decided_by_name: null, created_at: now() };
  state.treasury.unshift(w);
  audit(u, 'treasury.requested', 'treasury_withdrawal', w.id, { amountCents: w.amount_cents });
  return w;
});
route('POST', '/admin/treasury/withdrawals/:id/decide', ({ me, params, body }) => {
  const u = needPerm(me, 'treasury.approve');
  const w = state.treasury.find((x) => x.id === params[0]) ?? fail(404, 'not_found', 'Withdrawal not found');
  if (w.requested_by === u.id) fail(403, 'four_eyes', 'Another admin must approve your own request');
  if (w.status !== 'pending_approval') fail(409, 'already_decided', 'Already decided');
  w.status = body.approve ? 'paid' : 'rejected';
  w.decided_by_name = u.display_name;
  if (body.approve) {
    if (w.source === 'tax_payable') state.platform.tax_payable -= w.amount_cents;
    else state.platform.treasury -= w.amount_cents;
    state.platform.withdrawn += w.amount_cents;
  }
  audit(u, body.approve ? 'treasury.approved' : 'treasury.rejected', 'treasury_withdrawal', w.id, { amountCents: w.amount_cents });
  return w;
});

const TAX_ROWS = [
  ['DE', 'standard', 1900, 214, 3, 2_684_10], ['DE', 'reverse_charge', 0, 61, 0, 912_40], ['FR', 'standard', 2000, 132, 1, 1_540_75],
  ['GB', 'standard', 2000, 97, 2, 1_102_30], ['US', 'outside_scope', 0, 388, 4, 4_870_55], ['NL', 'reverse_charge', 0, 18, 0, 240_00],
] as const;
function taxRows(from: string, to: string) {
  // Scale the sample to the length of the period so the report reacts to the dates.
  const k = Math.max(0.05, Math.min(3, (Date.parse(to) - Date.parse(from)) / (30 * day)));
  return TAX_ROWS.map(([country, treatment, rate_bps, orders, credit_notes, gross]) => {
    const commission_gross_cents = Math.round(gross * k);
    return { country, treatment, rate_bps, orders: Math.round(orders * k), credit_notes: Math.round(credit_notes * k), currency: 'USD', commission_gross_cents, tax_cents: Math.round((commission_gross_cents * rate_bps) / (10_000 + rate_bps)) };
  });
}
route('GET', '/admin/newsletter/status', ({ me }) => (needPerm(me, 'newsletter.export'), { subscribers: state.users.filter((u) => u.news_opt_in && u.status === 'active').length, brevoSync: false }));
route('GET', '/admin/tax/report', ({ me, query }) => (needPerm(me, 'tax.manage'), taxRows(query.get('from') ?? '', query.get('to') ?? '')));

route('GET', '/admin/staff', ({ me }) => {
  needPerm(me, 'staff.manage');
  const real = state.users.filter((u) => u.role !== 'user' || u.staff_roles?.length).map((u) => ({ id: u.id, email: u.email, display_name: u.display_name, role: u.role, staff_roles: u.staff_roles ?? [], totp_enabled: u.totp_enabled }));
  return [...real, ...state.staff.filter((s) => s.staff_roles.length)];
});
route('PUT', '/admin/staff/:id', ({ me, params, body }) => {
  const u = needPerm(me, 'staff.manage');
  if (params[0] === u.id) fail(403, 'self_change', 'You can’t change your own roles');
  if (!body.reason || String(body.reason).length < 3) fail(400, 'validation_error', 'Give a reason; it goes in the audit log');
  const roles = (body.roles as string[]).filter((r) => r in ROLE_PERMS);
  const real = userById(params[0]!);
  if (real) {
    real.staff_roles = roles.filter((r) => r !== real.role);
  } else {
    const s = state.staff.find((x) => x.id === params[0]);
    if (s) s.staff_roles = roles;
    else state.staff.push({ id: params[0], email: `${params[0]!.slice(0, 8)}@example.test`, display_name: `User ${params[0]!.slice(0, 8)}`, role: 'user', staff_roles: roles, totp_enabled: false });
  }
  audit(u, 'staff.roles_changed', 'user', params[0]!, { roles, reason: body.reason });
  return { id: params[0], roles };
});

// --- Files (CSV exports, PDFs) ---------------------------------------------------------------
const csv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return 'no rows in this period\n';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
};
/** A one-page PDF with a few lines of text, standing in for server-rendered documents. */
function pdf(lines: string[]) {
  const esc = (t: string) => t.replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7e]/g, '-');
  const text = lines.map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 56 ${780 - i * 22} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: 'application/pdf' });
}
function blobRoute(me: DemoUser | null, path: string, query: URLSearchParams): Blob {
  const from = query.get('from') ?? '1970-01-01';
  const to = query.get('to') ?? '2999-01-01';
  const inRange = (iso: string) => iso >= from && iso < to;
  let m = /^\/seller\/invoices\/([^/]+)\/pdf$/.exec(path);
  if (m) {
    const u = needSeller(me);
    const i = state.invoices.find((x) => x.id === m![1] && x.seller_id === u.id) ?? fail(404, 'not_found', 'Invoice not found');
    return pdf([`Bullizard commission invoice ${i.number}`, `Seller: ${u.display_name}`, `Period from ${i.period_start.slice(0, 10)}`, `Commission: $${(i.gross_cents / 100).toFixed(2)} ${i.currency}`, `Tax: $${(i.tax_cents / 100).toFixed(2)}`, 'Demo document - not a real invoice.']);
  }
  m = /^\/chat\/attachments\/([^/]+)$/.exec(path);
  if (m) {
    const u = need(me);
    const a = state.attachments.find((x) => x.id === m![1]) ?? fail(404, 'not_found', 'Attachment not found');
    const room = state.rooms.find((x) => x.id === a.room_id)!;
    if (room.buyer_id !== u.id && room.seller_id !== u.id && u.role === 'user') fail(403, 'not_participant', 'Not your order');
    const bin = atob(a.data_url.slice(a.data_url.indexOf(',') + 1));
    return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: a.mime });
  }
  if (path === '/seller/listings/export.csv') {
    const u = needSeller(me);
    const rows = state.offers.filter((o) => o.seller_id === u.id && o.status !== 'removed' && !o.reserved_for).map((o) => ({
      id: o.id, game: o.game, category: o.category_slug, title: o.title, description: o.description, price: (o.price_cents / 100).toFixed(2), currency: o.currency,
      delivery: o.delivery_mode === 'auto' ? 'instant' : 'manual', stock: o.delivery_mode === 'manual' ? o.stock : '', delivery_hours: o.delivery_hours ?? '', status: o.status,
      attributes: Object.entries(o.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join('; '), warranty_days: o.warranty_days ?? 0,
    }));
    return new Blob([csv(rows)], { type: 'text/csv' });
  }
  m = /^\/seller\/exports\/([a-z_]+)$/.exec(path);
  if (m) {
    const u = needSeller(me);
    const mine = state.orders.filter((o) => o.seller_id === u.id && inRange(o.created_at));
    const kinds: Record<string, () => Array<Record<string, unknown>>> = {
      sales: () => mine.map((o) => ({ order_id: o.id, created_at: o.created_at, title: o.offer_title, status: o.status, amount_cents: o.amount_cents, commission_bps: o.commission_bps, commission_cents: o.amount_cents - o.seller_net_cents, credited_cents: o.seller_net_cents, currency: o.currency })),
      statement: () => mine.filter((o) => o.status === 'completed').map((o) => ({ at: o.completed_at, kind: 'sale_released', reference: o.id, amount_cents: o.seller_net_cents, currency: 'USD' })),
      payouts: () => state.withdrawals.filter((w) => w.user_id === u.id && inRange(w.created_at)).map((w) => ({ id: w.id, created_at: w.created_at, amount_cents: w.amount_cents, currency: w.currency, status: w.status })),
      invoices: () => state.invoices.filter((i) => i.seller_id === u.id).map((i) => ({ number: i.number, period_start: i.period_start, gross_cents: i.gross_cents, tax_cents: i.tax_cents, currency: i.currency })),
      credit_notes: () => state.creditNotes.filter((c) => c.seller_id === u.id).map((c) => ({ number: c.number, issued_at: c.issued_at, gross_cents: c.gross_cents, currency: c.currency, reason: c.reason })),
    };
    const rows = (kinds[m[1]!] ?? fail(404, 'not_found', 'Unknown export'))();
    return new Blob([csv(rows)], { type: 'text/csv' });
  }
  if (path === '/admin/newsletter.csv') {
    needPerm(me, 'newsletter.export');
    const rows = state.users.filter((u) => u.news_opt_in && u.status === 'active').map((u) => ({
      email: u.email, name: u.display_name, language: u.locale === 'ar' ? 'ar' : 'en', list: u.locale === 'ar' ? 'Newsletter AR' : 'Newsletter EN', opted_in_at: u.news_opt_in_at ?? '',
    }));
    return new Blob([rows.length ? csv(rows) : 'email,name,language,list,opted_in_at\n'], { type: 'text/csv' });
  }
  if (path === '/admin/tax/report') {
    needPerm(me, 'tax.manage');
    return new Blob([csv(taxRows(from, to))], { type: 'text/csv' });
  }
  m = /^\/admin\/chargebacks\/([^/]+)\/packet\.pdf$/.exec(path) ?? /^\/admin\/chargebacks\/([^/]+)\/(?:pdf|packet)$/.exec(path);
  if (m) {
    needStaff(me);
    return pdf([`Chargeback representment ${m[1]}`, 'Order record, delivery proof and chat transcript.', 'Demo document.']);
  }
  return fail(404, 'not_found', `This preview doesn't include ${path} (no backend).`);
}
export async function demoBlob(pathWithQuery: string, token: string | null): Promise<Blob> {
  await new Promise((r) => setTimeout(r, 150));
  const [path, qs] = pathWithQuery.split('?') as [string, string | undefined];
  const me = token?.startsWith('demo:') ? (userById(token.slice(5)) ?? null) : null;
  try {
    return blobRoute(me, path, new URLSearchParams(qs ?? ''));
  } catch (err) {
    const { ApiError } = await import('../api');
    if (err instanceof HttpError) throw new ApiError(err.status, err.code, err.message, err.details);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point used by api.ts in demo builds
// ---------------------------------------------------------------------------
export async function demoFetch(method: string, pathWithQuery: string, body: unknown, token: string | null): Promise<{ status: number; data: unknown }> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180)); // feel like a network
  const [path, qs] = pathWithQuery.split('?') as [string, string | undefined];
  const me = token?.startsWith('demo:') ? (userById(token.slice(5)) ?? null) : null;
  viewer = me?.id ?? null;
  for (const [m, re, h] of routes) {
    const match = m === method ? re.exec(path) : null;
    if (!match) continue;
    try {
      const data = h({ me, body: body ?? {}, query: new URLSearchParams(qs ?? ''), params: match.slice(1).map(decodeURIComponent) });
      save();
      return { status: data === undefined ? 204 : method === 'POST' && /\/(orders|offers)$/.test(path) ? 201 : 200, data };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, data: { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } } };
      console.error(err);
      return { status: 500, data: { error: { code: 'internal', message: 'Demo error' } } };
    }
  }
  return { status: 404, data: { error: { code: 'not_found', message: `This preview doesn't include ${method} ${path} (no backend).` } } };
}

export const DEMO_ACCOUNTS = [
  { email: 'buyer@demo.test', label: 'Buyer', who: 'Pixel Pat' },
  { email: 'seller@demo.test', label: 'Seller', who: 'NorthWind Keys' },
  { email: 'admin@demo.test', label: 'Admin', who: 'Arbiter Ada' },
];
