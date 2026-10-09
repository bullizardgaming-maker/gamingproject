/**
 * In-browser stand-in for the API, used when the app is built with VITE_DEMO=true (e.g. Vercel
 * previews, which have no backend). It implements the endpoints the web app calls with the same
 * request and response shapes, keeps state in localStorage, and simulates the parts that happen
 * elsewhere in production: the hosted card checkout, auto-delivery, the seller replying in chat,
 * and identity verification. Nothing here talks to a server.
 */
import { CATEGORIES, DEMO_CODE, seed, type DemoState, type DemoUser } from './seed';
import { CATEGORY_DEFAULTS, GAME_SETS, attributesFor, cleanAttributes } from '../../../api/src/domain/attributeSets';
import { checkTiers, effectivePrice, unitPriceFor } from '../../../api/src/domain/priceTiers';
import { detectOffPlatform, matchTerms } from '../../../api/src/domain/safety';

const KEY = 'bz.demo.v13';
const day = 86_400_000;
const now = () => new Date().toISOString();
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));

let state: DemoState = load();

function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
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
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TIERS = [
  { name: 'Normal', minMonthlySalesCents: 0, accountRateBps: 1299, otherRateBps: 999 },
  { name: 'Common', minMonthlySalesCents: 300_00, accountRateBps: 1199, otherRateBps: 899 },
  { name: 'Uncommon', minMonthlySalesCents: 1_000_00, accountRateBps: 1099, otherRateBps: 799 },
  { name: 'Rare', minMonthlySalesCents: 5_000_00, accountRateBps: 999, otherRateBps: 699 },
  { name: 'Epic', minMonthlySalesCents: 10_000_00, accountRateBps: 899, otherRateBps: 599 },
  { name: 'Legendary', minMonthlySalesCents: 20_000_00, accountRateBps: 799, otherRateBps: 499 },
];
const FLAT = new Set(['gift-cards', 'top-ups', 'video-games']);

function tierOf(sellerId: string) {
  const sales = state.monthlySales[sellerId] ?? 0;
  let i = 0;
  TIERS.forEach((t, k) => sales >= t.minMonthlySalesCents && (i = k));
  return { tier: TIERS[i]!, next: TIERS[i + 1] ?? null, sales };
}
function rateFor(offer: any) {
  if (FLAT.has(offer.category_slug)) return 499;
  const t = tierOf(offer.seller_id).tier;
  return offer.category_kind === 'account' ? t.accountRateBps : t.otherRateBps;
}

const userById = (id: string) => state.users.find((u) => u.id === id);
const publicUser = (u: DemoUser) => {
  const { password: _p, legal_name: _l, ...rest } = u;
  return rest;
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
/** Units buyable now: manual stock, instant inventory, or a bundle's complete sets (0 if a part isn't active). */
function availableOf(o: any): number {
  if (o.bundle?.length) {
    const parts = o.bundle.map((b: any) => ({ b, f: state.offers.find((x) => x.id === b.offer_id) }));
    if (parts.some((p: any) => !p.f || p.f.status !== 'active')) return 0;
    return Math.min(...parts.map((p: any) => Math.floor(p.f.inventory.length / p.b.quantity)));
  }
  return o.delivery_mode === 'auto' ? o.inventory.length : o.stock;
}
function offerView(o: any) {
  const s = sellerStats(o.seller_id);
  const pr = presenceOf(o.seller_id);
  const price = effectivePrice(o);
  return {
    ...o,
    price_cents: price,
    regular_price_cents: o.price_cents,
    sale_ends_at: price < o.price_cents ? o.sale_ends_at : null,
    seller_online: pr.online,
    seller_trust_level: state.trust[o.seller_id] ?? 'new',
    seller_response_minutes: pr.response_minutes,
    inventory: undefined,
    stock: availableOf(o),
    is_bundle: !!o.bundle?.length,
    bundle: o.bundle?.map((b: any) => {
      const f = state.offers.find((x) => x.id === b.offer_id);
      return { offer_id: b.offer_id, quantity: b.quantity, title: f?.title, game: f?.game, currency: f?.currency, price_cents: f ? effectivePrice(f) : 0 };
    }),
    seller_name: userById(o.seller_id)?.display_name ?? 'Seller',
    high_risk_secondary: o.category_kind === 'account' && o.owner_proof_status !== 'verified',
    seller_completed_orders: s.completed,
    seller_rating: s.rating,
    seller_review_count: s.count,
  };
}

function hash(prev: string, body: string) {
  let h = 2166136261;
  for (const c of prev + body) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

function appendMessage(roomId: string, senderId: string | null, kind: string, body: string, flags: string[] = []) {
  const room = state.rooms.find((r) => r.id === roomId)!;
  const prev = state.messages.filter((m) => m.room_id === roomId).at(-1);
  const m = { id: rid(), room_id: roomId, seq: (prev?.seq ?? 0) + 1, sender_id: senderId, kind, body, flags, hash: hash(prev?.hash ?? '0', body), created_at: now() };
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

function transition(o: any, to: string, reason: string) {
  o.events.push({ from_status: o.status, to_status: to, reason, created_at: now() });
  o.status = to;
}

function deliverOrder(o: any, payload?: string) {
  const offer = state.offers.find((f) => f.id === o.offer_id)!;
  if (offer.bundle?.length) o.items = offer.bundle.flatMap((b: any) => state.offers.find((x) => x.id === b.offer_id)!.inventory.splice(0, o.quantity * b.quantity));
  else if (offer.delivery_mode === 'auto') o.items = offer.inventory.splice(0, o.quantity);
  else if (payload) o.items = [payload];
  o.delivered_at = now();
  o.protection_ends_at = new Date(Date.now() + (o.protection === 'insurance_14d' ? 14 * day : 3 * day)).toISOString();
  transition(o, 'delivered', offer.delivery_mode === 'auto' ? 'auto_delivery' : 'manual_delivery');
  notify(o.buyer_id, 'orders', 'order.delivered', 'Your order was delivered', `${o.offer_title}: check it within your protection window.`, `/orders/${o.id}`);
  live(appendMessage(o.room_id, null, 'delivery', offer.delivery_mode === 'auto' ? 'Delivered automatically. Your codes are on this order page.' : 'The seller marked this order as delivered.'));
}

function releaseOrder(o: any, reason: string) {
  transition(o, 'completed', reason);
  o.completed_at = now();
  state.balances[o.seller_id] = (state.balances[o.seller_id] ?? 0) + o.seller_net_cents;
  state.monthlySales[o.seller_id] = (state.monthlySales[o.seller_id] ?? 0) + o.amount_cents;
  state.platform.escrow -= o.amount_cents;
  state.platform.treasury += o.amount_cents - o.seller_net_cents;
  notify(o.seller_id, 'selling', 'order.released', 'Payment released', `$${(o.seller_net_cents / 100).toFixed(2)} from “${o.offer_title}” was added to your balance.`, '/sell/money');
  live(appendMessage(o.room_id, null, 'system', `Order completed. $${(o.seller_net_cents / 100).toFixed(2)} released to the seller (fee ${(o.commission_bps / 100).toFixed(2)}%).`));
}

/** Demo stand-in for the hosted card checkout: pays the order and runs what the PSP webhook triggers. */
export function payDemoOrder(orderId: string) {
  const o = state.orders.find((x) => x.id === orderId);
  if (!o || o.status !== 'awaiting_payment') return o;
  transition(o, 'paid', 'payment_captured');
  o.paid_at = now();
  state.platform.escrow += o.amount_cents;
  notify(o.seller_id, 'selling', 'order.paid', 'New order', `${o.offer_title}: the buyer has paid. Deliver from the order page.`, `/orders/${o.id}`);
  live(appendMessage(o.room_id, null, 'system', `Payment received: $${(o.amount_cents / 100).toFixed(2)} is locked in escrow.`));
  const offer = state.offers.find((f) => f.id === o.offer_id)!;
  if (offer.delivery_mode === 'auto') deliverOrder(o);
  else scheduleReply(o.room_id, o.seller_id);
  save();
  return o;
}

function orderSummary(o: any, as: 'buyer' | 'seller') {
  return {
    id: o.id, offer_title: o.offer_title, game: o.game, amount_cents: o.amount_cents, currency: o.currency, status: o.status, created_at: o.created_at,
    counterparty: userById(as === 'buyer' ? o.seller_id : o.buyer_id)?.display_name,
  };
}

function orderDetail(o: any) {
  const review = state.reviews.find((r) => r.order_id === o.id);
  return {
    ...o,
    items: undefined,
    buyer_name: userById(o.buyer_id)?.display_name,
    seller_name: userById(o.seller_id)?.display_name,
    review: review ? { rating: review.rating, comment: review.comment, seller_reply: review.seller_reply } : null,
  };
}

function seedOrdersFor(buyer: DemoUser) {
  // Give the buyer a history the first time they sign in: one completed, one in its window.
  if (state.orders.some((o) => o.buyer_id === buyer.id)) return;
  const pick = (title: string) => state.offers.find((f) => f.title.startsWith(title))!;
  const make = (offer: any, ageMs: number) => {
    const o = createOrderRecord(buyer, offer, 1, 'fiat');
    o.created_at = new Date(Date.now() - ageMs).toISOString();
    payDemoOrder(o.id);
    return o;
  };
  const done = make(pick('Elden Ring'), 9 * day);
  releaseOrder(done, 'buyer_confirmed');
  state.reviews.push({ id: rid(), order_id: done.id, seller_id: done.seller_id, rating: 5, comment: 'Instant and worked first try.', seller_reply: null, created_at: now() });
  make(pick('Steam Wallet'), 4 * 3_600_000);
  const acct = make(pick('Lvl 80 Warrior'), day);
  deliverOrder(acct, 'Login: arthas-2009@example.com\nPassword: ••••••••• (change it now)\nOriginal registration email included.');
  save();
}

function createOrderRecord(buyer: DemoUser, offer: any, quantity: number, rail: 'fiat' | 'crypto', sellerDiscount = 0) {
  const amount = unitPriceFor({ price_cents: effectivePrice(offer), price_tiers: offer.price_tiers }, quantity) * quantity - sellerDiscount;
  // (a cart sets checkout_id on the orders it creates)
  const bps = rateFor(offer);
  const commission = Math.round((amount * bps) / 10_000);
  const isAccount = offer.category_kind === 'account';
  const id = rid();
  const room = { id: rid(), order_id: id, offer_id: offer.id, buyer_id: buyer.id, seller_id: offer.seller_id, last_seq: 0 };
  state.rooms.push(room);
  const o: any = {
    id, buyer_id: buyer.id, seller_id: offer.seller_id, offer_id: offer.id, offer_title: offer.title, game: offer.game,
    category_kind: offer.category_kind, delivery_mode: offer.delivery_mode, quantity, amount_cents: amount, currency: 'USD',
    commission_bps: bps, seller_net_cents: amount - commission, seller_tier: tierOf(offer.seller_id).tier.name, rail,
    status: 'awaiting_payment', protection: isAccount ? 'insurance_14d' : 'inspection_72h', protection_ends_at: null, delivered_at: null,
    escrow_frozen: false, seller_protected: !isAccount || offer.owner_proof_status === 'verified', room_id: room.id,
    checklist: isAccount ? { items: CHECKLIST.map(([key, label]) => ({ key, label, done: false })), completed_at: null } : null,
    dispute: null, events: [{ from_status: null, to_status: 'awaiting_payment', reason: 'order_created', created_at: now() }],
    created_at: now(), items: [],
  };
  state.orders.push(o);
  if (offer.delivery_mode === 'manual') offer.stock -= quantity;
  appendMessage(room.id, null, 'system', `Order placed for "${offer.title}". Keep every message about this trade here: it's the record an arbiter reads if anything goes wrong.`);
  return o;
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
route('POST', '/auth/login', ({ body }) => {
  const u = state.users.find((x) => x.email.toLowerCase() === String(body.email ?? '').toLowerCase());
  if (!u || u.password !== body.password) fail(401, 'unauthorized', 'Invalid email or password');
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
  if (!/^\S+@\S+\.\S+$/.test(body.email ?? '') || String(body.password ?? '').length < 10) fail(400, 'validation_error', 'Invalid request');
  if (state.users.some((x) => x.email === body.email)) fail(409, 'email_taken', 'An account with this email already exists');
  const u: DemoUser = {
    id: rid(), email: body.email, password: body.password, display_name: body.displayName ?? 'New user', role: 'user', kyc_tier: 0, status: 'active',
    email_verified_at: null, phone_verified_at: null, withdrawals_frozen: false, totp_enabled: false, payouts_enabled: false, legal_name: null, created_at: now(),
    locale: ['ar', 'es', 'fr', 'de', 'pt'].includes(body.locale) ? body.locale : 'en',
  };
  state.users.push(u);
  return { token: `demo:${u.id}`, user: publicUser(u) };
});
route('POST', '/auth/logout', () => undefined);
route('PUT', '/me/locale', ({ me, body }) => {
  const u = need(me);
  if (!['en', 'ar', 'es', 'fr', 'de', 'pt'].includes(body.locale)) fail(400, 'validation_error', 'Unknown language');
  u.locale = body.locale;
  return { locale: body.locale };
});
route('POST', '/auth/refresh', () => fail(401, 'unauthorized', 'Sign in again'));
route('POST', '/auth/password/forgot', () => ({ message: 'If an account uses this email, a reset link is on its way.' }));
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
  if (u.email_verified_at && u.phone_verified_at) u.kyc_tier = Math.max(u.kyc_tier, 1);
  return { user: publicUser(u) };
});
route('POST', '/kyc/start', ({ me }) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email and phone first');
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
  if (body.currentPassword !== u.password) fail(401, 'unauthorized', 'Current password is incorrect');
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
route('GET', '/categories', () => CATEGORIES);
route('GET', '/offers', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase().trim();
  let items = state.offers.filter(listed).map(offerView);
  if (q) items = items.filter((o) => `${o.title} ${o.game} ${o.description}`.toLowerCase().includes(q) || q.split(/\s+/).every((w) => `${o.title} ${o.game}`.toLowerCase().includes(w)));
  if (query.get('delivery') === 'instant') items = items.filter((o) => o.delivery_mode === 'auto');
  if (query.get('ownerVerified') === 'true') items = items.filter((o) => o.category_kind !== 'account' || o.owner_proof_status === 'verified');
  if (query.get('maxPrice')) items = items.filter((o) => o.price_cents <= Number(query.get('maxPrice')));
  if (query.get('minRating')) items = items.filter((o) => (o.seller_rating ?? 0) >= Number(query.get('minRating')));
  if (query.get('seller')) items = items.filter((o) => o.seller_id === query.get('seller'));
  if (query.get('game')) items = items.filter((o) => o.game.toLowerCase() === query.get('game')!.toLowerCase());
  if (query.get('inStock') !== 'false') items = items.filter((o) => o.stock > 0);
  // Game-specific fields: attr.<key>=<value>, exact and case-insensitive.
  const attrs = [...query.entries()].filter(([k]) => k.startsWith('attr.')).map(([k, v]) => [k.slice(5), v.toLowerCase()] as const);
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
    price_asc: (a, b) => a.price_cents - b.price_cents,
    price_desc: (a, b) => b.price_cents - a.price_cents,
    rating: (a, b) => (b.seller_rating ?? 0) - (a.seller_rating ?? 0),
    best_selling: (a, b) => b.seller_completed_orders - a.seller_completed_orders,
    trust: (a, b) => TRUST_ORDER.indexOf(a.seller_trust_level) - TRUST_ORDER.indexOf(b.seller_trust_level) || (b.seller_rating ?? 0) - (a.seller_rating ?? 0),
  };
  if (by[sort]) items.sort(by[sort]);
  const page = Math.max(1, Number(query.get('page') ?? 1));
  const pageSize = Number(query.get('pageSize') ?? 12);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, hasMore: page * pageSize < items.length, facets };
});
route('GET', '/catalog/attributes', ({ query }) => {
  const game = query.get('game');
  const category = query.get('category');
  return game && category ? { game, category, fields: attributesFor(game, category) } : { defaults: CATEGORY_DEFAULTS, games: GAME_SETS };
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
      return { ...r, buyer_name: o ? userById(o.buyer_id)?.display_name : ['Mira_K', 'zed.plays', 'Hollowfang', 'nyx', 'BaguetteBandit', 'TomTheTank'][r.id.length % 6], offer_title: o?.offer_title ?? r.game ?? null };
    });
  const before = state.reviewsBefore[u.id];
  return {
    id: u.id, display_name: u.display_name, member_since: u.created_at, identity_verified: u.kyc_tier >= 2, completed_orders: s.completed,
    active_listings: state.offers.filter((o) => o.seller_id === u.id && listed(o)).length,
    on_time_delivery_pct: before ? Math.min(100, 93 + (before.count % 7)) : null, shop_paused: false, shop_paused_until: null, shop_pause_message: null,
    ...presenceOf(u.id),
    trust_level: state.trust[u.id] ?? 'new',
    rating: { average: s.rating, count: s.count, positive_pct: s.count ? Math.round(((s.rating ?? 0) / 5) * 1000) / 10 : null },
    reviews: reviews.slice(offset, offset + limit),
  };
});
route('GET', '/offers/:id', ({ me, params }) => {
  const o = state.offers.find((x) => x.id === params[0]);
  // A listing agreed on a buyer request is only for that buyer (and its seller and staff); one in review only for its seller and staff.
  if (o && o.status === 'review' && o.seller_id !== me?.id && (!me || (me.role === 'user' && !me.staff_roles?.length))) fail(404, 'not_found', 'Listing not found');
  if (!o || (o.reserved_for && ![o.reserved_for, o.seller_id].includes(me?.id ?? '') && (!me || (me.role === 'user' && !me.staff_roles?.length)))) fail(404, 'not_found', 'Listing not found');
  return offerView(o);
});

// --- Orders ----------------------------------------------------------------------------
route('POST', '/orders', ({ me, body }) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email and phone before purchasing');
  const offer = state.offers.find((x) => x.id === body.offerId && (!x.reserved_for || x.reserved_for === u.id)) ?? fail(404, 'not_found', 'Listing not found');
  if (offer.seller_id === u.id) fail(400, 'own_listing', 'You can’t buy your own listing');
  const qty = Number(body.quantity ?? 1);
  const available = availableOf(offer);
  if (available < qty) fail(409, 'out_of_stock', 'Not enough stock for this order');
  const code = body.sellerCode ? sellerCodeQuote(offer, u, qty, body.sellerCode) : null;
  const o = createOrderRecord(u, offer, qty, body.rail ?? 'fiat', code?.discount ?? 0);
  if (code) Object.assign(o, { seller_code_id: code.c.id, seller_discount_cents: code.discount });
  return { order: orderDetail(o), checkoutUrl: o.rail === 'fiat' ? `/demo-checkout/${o.id}` : null };
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
  const subtotal = unitPriceFor({ price_cents: effectivePrice(offer), price_tiers: offer.price_tiers }, qty) * qty;
  const amount = subtotal - (code?.discount ?? 0);
  return { listingCurrency: offer.currency, amountCents: amount, chargedCents: amount, sellerDiscountCents: code?.discount ?? 0, discountCents: 0, creditCents: 0, presentmentCurrency: offer.currency, presentmentAmountCents: amount };
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
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email and phone before purchasing');
  const items: Array<{ offerId: string; quantity: number }> = body.items ?? [];
  if (!items.length || items.length > 20) fail(400, 'invalid_cart', 'A cart holds 1 to 20 listings');
  if (new Set(items.map((i) => i.offerId)).size !== items.length) fail(400, 'invalid_cart', 'Each listing can appear once; change its quantity instead');
  // Check everything first so a cart either fully goes through or not at all.
  const lines = items.map((i) => {
    const offer = state.offers.find((x) => x.id === i.offerId && (!x.reserved_for || x.reserved_for === u.id) && x.status === 'active') ?? fail(404, 'not_found', 'Listing not found');
    if (offer.seller_id === u.id) fail(403, 'own_offer', 'You cannot buy your own offer');
    const qty = Number(i.quantity ?? 1);
    if (availableOf(offer) < qty) fail(409, 'out_of_stock', `Not enough stock for "${offer.title}"`);
    return { offer, qty };
  });
  const checkout = { id: `cart-${rid().slice(0, 8)}`, buyer_id: u.id, order_ids: lines.map(({ offer, qty }) => createOrderRecord(u, offer, qty, 'fiat').id), created_at: now() };
  for (const id of checkout.order_ids) state.orders.find((o) => o.id === id)!.checkout_id = checkout.id;
  state.checkouts.push(checkout);
  return { ...checkoutView(checkout), checkoutUrl: `/demo-checkout/${checkout.id}`, replayed: false };
});
const checkoutView = (c: any) => {
  const orders = c.order_ids.map((id: string) => state.orders.find((o) => o.id === id)!);
  return {
    checkout: { id: c.id, status: orders.every((o: any) => o.status !== 'awaiting_payment') ? 'paid' : 'awaiting_payment', presentment_amount_cents: orders.reduce((s: number, o: any) => s + o.amount_cents, 0), presentment_currency: 'USD', created_at: c.created_at },
    orders: orders.map((o: any) => ({ id: o.id, status: o.status, seller_id: o.seller_id, offer_id: o.offer_id, offer_title: o.offer_title, quantity: o.quantity, amount_cents: o.amount_cents, currency: o.currency, seller_name: userById(o.seller_id)?.display_name })),
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
route('GET', '/orders/:id', ({ me, params }) => orderDetail(orderFor(need(me), params[0]!)));
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
  deliverOrder(o, body.payload);
  notifyOrder(o.id);
  return orderDetail(o);
});
route('POST', '/orders/:id/confirm', ({ me, params }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (o.buyer_id !== u.id) fail(403, 'not_buyer', 'Only the buyer can confirm');
  if (o.status !== 'delivered') fail(409, 'invalid_state', `Cannot confirm an order that is ${o.status}`);
  if (o.checklist && !o.checklist.completed_at) fail(409, 'checklist_incomplete', 'Finish the security changeover first');
  releaseOrder(o, 'buyer_confirmed');
  return orderDetail(o);
});
route('PATCH', '/orders/:id/checklist', ({ me, params, body }) => {
  const o = orderFor(need(me), params[0]!);
  const item = o.checklist?.items.find((i: any) => i.key === body.key) ?? fail(400, 'unknown_item', 'Unknown checklist item');
  item.done = !!body.done;
  o.checklist.completed_at = o.checklist.items.every((i: any) => i.done) ? now() : null;
  return o.checklist;
});
route('POST', '/orders/:id/dispute', ({ me, params, body }) => {
  const u = need(me);
  const o = orderFor(u, params[0]!);
  if (!['paid', 'delivered'].includes(o.status)) fail(409, 'invalid_state', `Cannot dispute an order that is ${o.status}`);
  const role = u.id === o.buyer_id ? 'buyer' : 'seller';
  o.dispute = { id: rid(), reason: body.reason, category: body.category ?? 'other', status: 'open', opened_by: u.id, created_at: now(),
    statements: [{ id: rid(), role, body: body.reason, author_name: u.display_name, created_at: now() }] };
  transition(o, 'disputed', 'dispute_opened');
  live(appendMessage(o.room_id, null, 'system', 'A dispute was opened. Escrow is frozen until an arbiter reviews this chat.'));
  return o.dispute;
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
  live(appendMessage(o.room_id, null, 'system', `The ${role} added a statement to the dispute.`));
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
  const reasons = detectOffPlatform(text);
  const flagged = reasons.length > 0;
  const m = appendMessage(r.id, u.id, 'text', text, reasons.map((x) => `offplatform:${x}`));
  if (flagged) {
    state.chatFlags.unshift({ id: rid(), room_id: r.id, seq: m.seq, user_id: u.id, reasons, status: 'open', note: null, created_at: now() });
    live(appendMessage(r.id, null, 'warning', 'Contact details or outside payment apps were detected. Trades moved off the platform lose escrow protection, and repeated attempts suspend accounts.'));
  }
  scheduleReply(r.id, u.id === r.buyer_id ? r.seller_id : r.buyer_id);
  return m;
});

// --- Selling ---------------------------------------------------------------------------
const needSeller = (me: DemoUser | null) => {
  const u = need(me);
  if (u.kyc_tier < 2) fail(403, 'kyc_required', 'Tier 2 identity verification is required to sell');
  return u;
};
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
    monthlySalesCents: t.sales,
    next: t.next ? { tier: t.next, remainingCents: t.next.minMonthlySalesCents - t.sales } : null,
    tiers: TIERS,
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
    .map((o) => ({ ...offerView(o), available: availableOf(o) }));
});
route('POST', '/offers', ({ me, body }) => {
  const u = needSeller(me);
  const cat = CATEGORIES.find((c) => c.slug === body.categorySlug) ?? fail(400, 'invalid_category', 'Unknown category');
  if (!body.title || String(body.title).length < 3) fail(400, 'validation_error', 'Give the listing a title');
  if (!(body.priceCents > 0)) fail(400, 'validation_error', 'Set a price');
  const attrs = cleanAttributes(String(body.game ?? ''), cat.slug, body.attributes);
  if (!attrs.ok) fail(400, 'invalid_attributes', attrs.error);
  const tiers = checkTiers(Number(body.priceCents), body.priceTiers, cat.kind);
  if (!tiers.ok) fail(400, 'invalid_tiers', tiers.error);
  // Same screening as the API: block terms refuse, review terms and contact details hold for a moderator.
  const text = `${body.title}\n${body.description ?? ''}`;
  const hits = matchTerms(text, state.modTerms);
  if (hits.some((h) => h.action === 'block')) fail(400, 'listing_blocked', 'This listing breaks the rules on prohibited goods and can’t be published');
  const reviewReasons = [...hits.map((h) => `term:${h.term}`), ...detectOffPlatform(text).map((x) => `contact:${x}`)];
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
  };
  state.offers.unshift(o);
  if (reviewReasons.length) notify(u.id, 'selling', 'listing_review', 'Your listing is being reviewed', 'It mentions something our rules ask us to check, so it’s hidden until a moderator looks at it.', '/sell');
  return offerView(o);
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
route('POST', '/seller/payout-account', ({ me }) => {
  const u = needSeller(me);
  u.payouts_enabled = true; // the payment partner's onboarding completes instantly in the demo
  return { url: '/sell?payouts=1' };
});
route('GET', '/seller/payout-account', ({ me }) => {
  const u = need(me);
  return { connected: u.payouts_enabled, payoutsEnabled: u.payouts_enabled };
});
route('POST', '/seller/withdrawals', ({ me, body }) => {
  const u = needSeller(me);
  const available = state.balances[u.id] ?? 0;
  const { withdrawableCents } = holdOf(u.id);
  if (!(body.amountCents > 0) || body.amountCents > withdrawableCents) fail(400, 'insufficient_funds', `You can withdraw up to ${withdrawableCents} cents right now`);
  state.balances[u.id] = available - body.amountCents;
  const w = { id: rid(), amount_cents: body.amountCents, currency: 'USD', status: 'paid', created_at: now() };
  state.withdrawals.push({ ...w, user_id: u.id });
  notify(u.id, 'selling', 'payout.paid', 'Payout sent', `$${(body.amountCents / 100).toFixed(2)} is on its way to your bank.`, '/sell/money');
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
  if (!['USD', 'EUR', 'GBP'].includes(body.currency)) fail(400, 'unsupported_currency', 'Choose USD, EUR or GBP');
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
        ...f, user_name: u?.display_name ?? f.user_name ?? 'User', user_email: u?.email ?? f.user_email ?? '', offplatform_strikes: state.chatFlags.filter((x) => x.user_id === f.user_id && x.status !== 'dismissed').length,
        user_status: 'active', order_id: room?.order_id ?? null, offer_id: room?.offer_id, role: room?.seller_id === f.user_id ? 'seller' : 'buyer',
        confirmed_before: state.chatFlags.filter((x) => x.user_id === f.user_id && x.status === 'confirmed' && x.id !== f.id).length,
        context: state.messages.filter((m) => m.room_id === f.room_id && m.seq <= f.seq && m.seq >= f.seq - 2).sort((a, b) => a.seq - b.seq).map((m) => ({ ...m, erased: false })),
      };
    });
});
route('POST', '/admin/moderation/chats/:id', ({ me, params, body }) => {
  const u = needPerm(me, 'moderation.manage');
  const f = state.chatFlags.find((x) => x.id === params[0] && x.status === 'open') ?? fail(404, 'not_found', 'Open flag not found');
  Object.assign(f, { status: body.confirm ? 'confirmed' : 'dismissed', note: body.note ?? null, reviewed_by: u.id });
  return { id: f.id, status: f.status, user_id: f.user_id };
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
  return { ...p, seller_name: userById(p.seller_id)?.display_name ?? 'Seller', seller_completed_orders: s.completed, seller_rating: s.rating };
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
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email and phone (Tier 1) before posting a request');
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
    reserved_for: u.id, request_id: r.id,
  };
  state.offers.push(offer);
  Object.assign(p, { status: 'accepted', offer_id: offer.id, updated_at: now() });
  for (const x of state.proposals) if (x.request_id === r.id && x.id !== p.id && x.status === 'pending') Object.assign(x, { status: 'declined', updated_at: now() });
  Object.assign(r, { status: 'accepted', accepted_proposal_id: p.id, updated_at: now() });
  notify(p.seller_id, 'selling', 'request_accepted', `Proposal accepted: ${r.title}`, 'The buyer accepted your proposal. You’ll get the usual new-order notice when they pay.', `/requests/${r.id}`);
  return { offerId: offer.id, request: reqView(r, u.id) };
});
// --- Watchlist & price alerts ------------------------------------------------------------
const RATES: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79 };
const onSale = (o: any) => listed(o) && availableOf(o) > 0;
const cheapestFor = (w: any) =>
  state.offers
    .filter((o) => onSale(o) && o.game.toLowerCase() === w.game.toLowerCase() && (!w.category || o.category_slug === w.category))
    .filter((o) => Object.entries(w.attributes ?? {}).every(([k, v]) => String(o.attributes?.[k] ?? '').toLowerCase() === String(v).toLowerCase()))
    .sort((a, b) => a.price_cents - b.price_cents)[0];
function watchView(w: any) {
  const conv = (c: number | null | undefined) => (c == null ? null : Math.round(c * (RATES[w.currency] ?? 1)));
  if (w.kind === 'offer') {
    const o = state.offers.find((x) => x.id === w.offer_id);
    const ok = !!o && onSale(o);
    return {
      id: w.id, kind: 'offer', currency: w.currency, targetCents: w.targetCents, createdAt: w.createdAt,
      offer: o ? { id: o.id, title: o.title, game: o.game, category_slug: o.category_slug, seller_name: userById(o.seller_id)?.display_name ?? 'Seller', attributes: o.attributes } : null,
      currentCents: o ? conv(o.price_cents) : null, startCents: conv(w.start), available: ok, reached: ok && w.targetCents != null && conv(o!.price_cents)! <= w.targetCents,
    };
  }
  const low = cheapestFor(w);
  return {
    id: w.id, kind: 'game', currency: w.currency, targetCents: w.targetCents, createdAt: w.createdAt, game: w.game, category: w.category, attributes: w.attributes,
    cheapest: low ? { id: low.id, title: low.title, seller_name: userById(low.seller_id)?.display_name ?? 'Seller' } : null,
    currentCents: low ? conv(low.price_cents) : null, startCents: conv(w.start), available: !!low, reached: !!low && w.targetCents != null && conv(low.price_cents)! <= w.targetCents,
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
      o.price_cents = Math.max(1, Math.floor(w.targetCents / (RATES[w.currency] ?? 1)));
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
    w = { id: rid(), user_id: u.id, kind: 'offer', offer_id: o.id, targetCents: body.targetCents ?? null, currency, start: o.price_cents, createdAt: now() };
  } else {
    if (!body.game) fail(400, 'invalid_watch', 'Give an offer or a game to watch');
    if (body.attributes && Object.keys(body.attributes).length && !body.category) fail(400, 'invalid_watch', 'Pick a category to watch specific fields');
    w = { id: rid(), user_id: u.id, kind: 'game', game: body.game, category: body.category ?? null, attributes: body.attributes ?? {}, targetCents: body.targetCents ?? null, currency, createdAt: now() };
    w.start = cheapestFor(w)?.price_cents ?? null;
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

// --- Developers --------------------------------------------------------------------------
route('GET', '/developer/api-keys', ({ me }) => state.apiKeys.filter((k) => k.user_id === needSeller(me).id));
route('POST', '/developer/api-keys', ({ me, body }) => {
  const u = needSeller(me);
  const prefix = rid().slice(0, 8);
  const k = { id: rid(), user_id: u.id, name: body.name, prefix, scopes: body.scopes, created_at: now(), revoked_at: null };
  state.apiKeys.push(k);
  return { ...k, key: `mk_${prefix}_demo${rid().replace(/-/g, '')}` };
});
route('DELETE', '/developer/api-keys/:id', ({ params }) => {
  const k = state.apiKeys.find((x) => x.id === params[0]);
  if (k) k.revoked_at = now();
});
route('GET', '/developer/webhooks', ({ me }) => state.webhooks.filter((h) => h.user_id === needSeller(me).id));
route('POST', '/developer/webhooks', ({ me, body }) => {
  const u = needSeller(me);
  if (!/^https:\/\//.test(body.url ?? '')) fail(400, 'invalid_url', 'Webhook URL must use https');
  const h = { id: rid(), user_id: u.id, url: body.url, events: body.events, active: true, created_at: now() };
  state.webhooks.push(h);
  return { ...h, secret: `whsec_demo${rid().replace(/-/g, '')}` };
});
route('DELETE', '/developer/webhooks/:id', ({ params }) => {
  const h = state.webhooks.find((x) => x.id === params[0]);
  if (h) h.active = false;
});
route('POST', '/developer/webhooks/:id/test', () => ({ queued: true }));

// --- Operations console --------------------------------------------------------------------
route('GET', '/admin/disputes', ({ me }) => {
  needStaff(me);
  return state.orders
    .filter((o) => o.dispute?.status === 'open')
    .map((o) => ({ id: o.dispute.id, order_id: o.id, reason: o.dispute.reason, category: o.dispute.category ?? 'other', statements: o.dispute.statements?.length ?? 0, amount_cents: o.amount_cents, currency: o.currency, created_at: o.dispute.created_at, title: o.offer_title, offer_title: o.offer_title }));
});
route('GET', '/admin/disputes/:id/case', ({ me, params }) => {
  needPerm(me, 'disputes.manage');
  const o = state.orders.find((x) => x.dispute?.id === params[0]) ?? fail(404, 'not_found', 'Dispute not found');
  const who = (id: string | null) => (!id ? 'system' : id === o.buyer_id ? 'buyer' : id === o.seller_id ? 'seller' : 'staff');
  const msgs = state.messages.filter((m) => m.room_id === o.room_id);
  const party = (id: string) => {
    const u = userById(id);
    return { id, display_name: u?.display_name ?? 'User', created_at: u?.created_at, kyc_tier: u?.kyc_tier, trust_level: state.trust[id] ?? 'new', offplatform_strikes: state.chatFlags.filter((f) => f.user_id === id && f.status !== 'dismissed').length,
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
  o.dispute.status = body.outcome === 'buyer' ? 'resolved_buyer' : 'resolved_seller';
  if (body.outcome === 'buyer') {
    transition(o, 'refunded', 'dispute_resolved_buyer');
    state.platform.escrow -= o.amount_cents;
    live(appendMessage(o.room_id, null, 'system', `Arbiter decision: refunded to the buyer. “${body.note}”`));
  } else {
    live(appendMessage(o.room_id, null, 'system', `Arbiter decision: released to the seller. “${body.note}”`));
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
route('GET', '/admin/owner-proofs', ({ me }) => (needStaff(me), state.ownerProofs.filter((p) => p.status === 'pending')));
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
  ['website', 'Website and app'], ['api', 'Seller API and webhooks'], ['checkout', 'Card and crypto checkout'], ['delivery', 'Instant delivery and escrow release'],
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
route('GET', '/fx/rates', () => ({ settlement: 'USD', spreadBps: 100, rates: [{ currency: 'EUR', rate: 0.92, fetched_at: now() }, { currency: 'GBP', rate: 0.79, fetched_at: now() }] }));
route('GET', '/admin/fx/position', ({ me }) => {
  needStaff(me);
  return {
    positions: [
      { currency: 'USD', positionCents: 0, sellerBalancesCents: Object.values(state.balances).reduce((s, b) => s + b, 0), pspExpectedCents: Object.values(state.balances).reduce((s, b) => s + b, 0) + state.platform.treasury, shortfallCents: 0 },
      { currency: 'EUR', positionCents: -2_310_00, sellerBalancesCents: 2_310_00, pspExpectedCents: 2_400_00, shortfallCents: 0 },
      { currency: 'GBP', positionCents: -860_00, sellerBalancesCents: 860_00, pspExpectedCents: 0, shortfallCents: 860_00 },
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
  const base = { ...t, messages: undefined, user_name: u?.display_name, order: ticketOrder(t.order_id) };
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
route('POST', '/support/tickets', ({ me, body }) => {
  const u = need(me);
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
  return ticketView(t, false);
});
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
    categories: Object.entries(share).map(([slug, [w, tr, dr]]) => ({
      category_slug: slug, orders: Math.round(t.orders * w), gmv_cents: Math.round(t.gmvCents * w), take_cents: Math.round(t.gmvCents * w * tr), take_rate_pct: tr * 100, dispute_rate_pct: dr * 100,
    })),
    games: games.map(({ g, w }) => ({ game: g, orders: Math.round((t.orders * 0.7 * w) / gw), gmv_cents: Math.round((t.gmvCents * 0.7 * w) / gw) })),
  };
});

// --- Staff permissions, compliance, treasury, tax, staff ------------------------------------
const ALL_PERMS = [
  'orders.view_any', 'disputes.manage', 'owner_proofs.review', 'reviews.moderate', 'risk.review', 'users.suspend', 'aml.review', 'aml.sar',
  'chargebacks.manage', 'orders.refund_after_release', 'reconciliation.run', 'promos.manage', 'treasury.request', 'treasury.approve', 'ledger.view',
  'ledger.adjust', 'payout_holds.set', 'fx.manage', 'tax.manage', 'invoices.manage', 'keys.manage', 'retention.manage', 'audit.view', 'staff.manage', 'status.manage',
  'analytics.view', 'support.manage', 'moderation.manage',
];
const ROLE_PERMS: Record<string, string[]> = {
  arbiter: ['orders.view_any', 'disputes.manage', 'owner_proofs.review', 'reviews.moderate', 'orders.refund_after_release', 'moderation.manage'],
  support: ['orders.view_any', 'reviews.moderate', 'ledger.view', 'status.manage', 'support.manage', 'moderation.manage'],
  finance: ['chargebacks.manage', 'orders.refund_after_release', 'reconciliation.run', 'promos.manage', 'treasury.request', 'treasury.approve', 'ledger.view', 'ledger.adjust', 'payout_holds.set', 'fx.manage', 'tax.manage', 'invoices.manage', 'analytics.view'],
  compliance: ['orders.view_any', 'risk.review', 'users.suspend', 'aml.review', 'aml.sar', 'payout_holds.set', 'ledger.view', 'audit.view', 'retention.manage', 'analytics.view'],
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
    if (err instanceof HttpError) throw new ApiError(err.status, err.code, err.message);
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
      return { status: data === undefined ? 204 : method === 'POST' && /\/(orders|offers|developer\/api-keys|developer\/webhooks)$/.test(path) ? 201 : 200, data };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, data: { error: { code: err.code, message: err.message } } };
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
