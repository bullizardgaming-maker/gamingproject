/**
 * In-browser stand-in for the API, used when the app is built with VITE_DEMO=true (e.g. Vercel
 * previews, which have no backend). It implements the endpoints the web app calls with the same
 * request and response shapes, keeps state in localStorage, and simulates the parts that happen
 * elsewhere in production: the hosted card checkout, auto-delivery, the seller replying in chat,
 * and identity verification. Nothing here talks to a server.
 */
import { CATEGORIES, DEMO_CODE, seed, type DemoState, type DemoUser } from './seed';

const KEY = 'bz.demo.v2';
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
  const completed = (state.completedBefore[sellerId] ?? 0) + state.orders.filter((o) => o.seller_id === sellerId && o.status === 'completed').length;
  const rating = reviews.length ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 : null;
  return { completed, rating, count: reviews.length };
}

function offerView(o: any) {
  const s = sellerStats(o.seller_id);
  return {
    ...o,
    inventory: undefined,
    stock: o.delivery_mode === 'auto' ? o.inventory.length : o.stock,
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

const OFF_PLATFORM = /(discord|telegram|whatsapp|skype|paypal|venmo|cash ?app|\+?\d[\d\s-]{8,}\d)/i;

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
  if (offer.delivery_mode === 'auto') o.items = offer.inventory.splice(0, o.quantity);
  else if (payload) o.items = [payload];
  o.delivered_at = now();
  o.protection_ends_at = new Date(Date.now() + (o.protection === 'insurance_14d' ? 14 * day : 3 * day)).toISOString();
  transition(o, 'delivered', offer.delivery_mode === 'auto' ? 'auto_delivery' : 'manual_delivery');
  live(appendMessage(o.room_id, null, 'delivery', offer.delivery_mode === 'auto' ? 'Delivered automatically. Your codes are on this order page.' : 'The seller marked this order as delivered.'));
}

function releaseOrder(o: any, reason: string) {
  transition(o, 'completed', reason);
  o.completed_at = now();
  state.balances[o.seller_id] = (state.balances[o.seller_id] ?? 0) + o.seller_net_cents;
  state.monthlySales[o.seller_id] = (state.monthlySales[o.seller_id] ?? 0) + o.amount_cents;
  state.platform.escrow -= o.amount_cents;
  state.platform.treasury += o.amount_cents - o.seller_net_cents;
  live(appendMessage(o.room_id, null, 'system', `Order completed. $${(o.seller_net_cents / 100).toFixed(2)} released to the seller (fee ${(o.commission_bps / 100).toFixed(2)}%).`));
}

/** Demo stand-in for the hosted card checkout: pays the order and runs what the PSP webhook triggers. */
export function payDemoOrder(orderId: string) {
  const o = state.orders.find((x) => x.id === orderId);
  if (!o || o.status !== 'awaiting_payment') return o;
  transition(o, 'paid', 'payment_captured');
  o.paid_at = now();
  state.platform.escrow += o.amount_cents;
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

function createOrderRecord(buyer: DemoUser, offer: any, quantity: number, rail: 'fiat' | 'crypto') {
  const amount = offer.price_cents * quantity;
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
  };
  state.users.push(u);
  return { token: `demo:${u.id}`, user: publicUser(u) };
});
route('POST', '/auth/logout', () => undefined);
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
  let items = state.offers.filter((o) => o.status === 'active').map(offerView);
  if (q) items = items.filter((o) => `${o.title} ${o.game} ${o.description}`.toLowerCase().includes(q) || q.split(/\s+/).every((w) => `${o.title} ${o.game}`.toLowerCase().includes(w)));
  const facets = { categories: CATEGORIES.map((c) => ({ category_slug: c.slug, count: items.filter((o) => o.category_slug === c.slug).length })) };
  if (query.get('category')) items = items.filter((o) => o.category_slug === query.get('category'));
  if (query.get('delivery') === 'instant') items = items.filter((o) => o.delivery_mode === 'auto');
  if (query.get('ownerVerified') === 'true') items = items.filter((o) => o.category_kind !== 'account' || o.owner_proof_status === 'verified');
  if (query.get('maxPrice')) items = items.filter((o) => o.price_cents <= Number(query.get('maxPrice')));
  if (query.get('seller')) items = items.filter((o) => o.seller_id === query.get('seller'));
  const sort = query.get('sort') ?? (q ? 'relevance' : 'newest');
  const by: Record<string, (a: any, b: any) => number> = {
    newest: (a, b) => b.created_at.localeCompare(a.created_at),
    price_asc: (a, b) => a.price_cents - b.price_cents,
    price_desc: (a, b) => b.price_cents - a.price_cents,
    rating: (a, b) => (b.seller_rating ?? 0) - (a.seller_rating ?? 0),
    best_selling: (a, b) => b.seller_completed_orders - a.seller_completed_orders,
  };
  if (by[sort]) items.sort(by[sort]);
  const page = Math.max(1, Number(query.get('page') ?? 1));
  const pageSize = Number(query.get('pageSize') ?? 12);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, hasMore: page * pageSize < items.length, facets };
});
route('GET', '/offers/:id', ({ params }) => {
  const o = state.offers.find((x) => x.id === params[0]);
  if (!o) fail(404, 'not_found', 'Listing not found');
  return offerView(o);
});

// --- Orders ----------------------------------------------------------------------------
route('POST', '/orders', ({ me, body }) => {
  const u = need(me);
  if (u.kyc_tier < 1) fail(403, 'kyc_required', 'Verify your email and phone before purchasing');
  const offer = state.offers.find((x) => x.id === body.offerId) ?? fail(404, 'not_found', 'Listing not found');
  if (offer.seller_id === u.id) fail(400, 'own_listing', 'You can’t buy your own listing');
  const qty = Number(body.quantity ?? 1);
  const available = offer.delivery_mode === 'auto' ? offer.inventory.length : offer.stock;
  if (available < qty) fail(409, 'out_of_stock', 'Not enough stock for this order');
  const o = createOrderRecord(u, offer, qty, body.rail ?? 'fiat');
  return { order: orderDetail(o), checkoutUrl: o.rail === 'fiat' ? `/demo-checkout/${o.id}` : null };
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
  o.dispute = { id: rid(), reason: body.reason, status: 'open', opened_by: u.id, created_at: now() };
  transition(o, 'disputed', 'dispute_opened');
  live(appendMessage(o.room_id, null, 'system', 'A dispute was opened. Escrow is frozen until an arbiter reviews this chat.'));
  return orderDetail(o);
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
  const flagged = OFF_PLATFORM.test(text);
  const m = appendMessage(r.id, u.id, 'text', text, flagged ? ['off_platform'] : []);
  if (flagged) {
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
route('GET', '/seller/dashboard', ({ me }) => {
  const u = needSeller(me);
  const t = tierOf(u.id);
  const mine = state.orders.filter((o) => o.seller_id === u.id);
  return {
    tier: t.tier,
    monthlySalesCents: t.sales,
    next: t.next ? { tier: t.next, remainingCents: t.next.minMonthlySalesCents - t.sales } : null,
    tiers: TIERS,
    balances: { availableCents: state.balances[u.id] ?? 0, pendingEscrowCents: mine.filter((o) => ['paid', 'delivered', 'disputed'].includes(o.status)).reduce((s, o) => s + o.seller_net_cents, 0) },
    withdrawalsFrozen: u.withdrawals_frozen,
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
    .map((o) => ({ ...offerView(o), available: o.delivery_mode === 'auto' ? o.inventory.length : o.stock }));
});
route('POST', '/offers', ({ me, body }) => {
  const u = needSeller(me);
  const cat = CATEGORIES.find((c) => c.slug === body.categorySlug) ?? fail(400, 'invalid_category', 'Unknown category');
  if (!body.title || String(body.title).length < 3) fail(400, 'validation_error', 'Give the listing a title');
  if (!(body.priceCents > 0)) fail(400, 'validation_error', 'Set a price');
  const o = {
    id: `offer-${rid().slice(0, 8)}`, seller_id: u.id, category_slug: cat.slug, category_kind: cat.kind, game: body.game, title: body.title,
    description: body.description ?? '', price_cents: body.priceCents, currency: 'USD', delivery_mode: body.deliveryMode,
    stock: body.deliveryMode === 'manual' ? Number(body.stock ?? 1) : 0, inventory: [] as string[], status: 'active', owner_proof_status: 'none', version: 1, created_at: now(),
  };
  state.offers.unshift(o);
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
  if (!(body.amountCents > 0) || body.amountCents > available) fail(400, 'insufficient_funds', `Available balance is ${available} cents`);
  state.balances[u.id] = available - body.amountCents;
  const w = { id: rid(), amount_cents: body.amountCents, currency: 'USD', status: 'paid', created_at: now() };
  state.withdrawals.push({ ...w, user_id: u.id });
  return w;
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
    .map((o) => ({ id: o.dispute.id, order_id: o.id, reason: o.dispute.reason, amount_cents: o.amount_cents, currency: o.currency, created_at: o.dispute.created_at, title: o.offer_title }));
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

// ---------------------------------------------------------------------------
// Entry point used by api.ts in demo builds
// ---------------------------------------------------------------------------
export async function demoFetch(method: string, pathWithQuery: string, body: unknown, token: string | null): Promise<{ status: number; data: unknown }> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180)); // feel like a network
  const [path, qs] = pathWithQuery.split('?') as [string, string | undefined];
  const me = token?.startsWith('demo:') ? (userById(token.slice(5)) ?? null) : null;
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
