/**
 * League-start load test against staging, over HTTP through Cloudflare (workflow staging-load.yml).
 *
 *   API_URL=https://api-staging.bullizard.com STAGING_TEST_TOKEN=... BUYER_EMAIL=... BUYER_PASSWORD=... \
 *   SELLER_EMAIL=... SELLER_PASSWORD=... DURATION_SECONDS=120 RPS=4 npx tsx scripts/loadtest-staging.ts
 *
 * Traffic mix of a league start: mostly market search (league currency and items, typos, sorts, game suggest),
 * some checkouts (order → mock payment → buyer confirms) and pre-sale chat (send + read). Every request goes
 * through one global pacer, so the rate never exceeds RPS (default 4/s, capped at 4.5/s). Why the cap:
 *   - the API limits each client IP to RATE_LIMIT_PER_MINUTE (300 on staging): 4.5/s = 270/min stays under it,
 *     and a GitHub runner is one IP;
 *   - Cloudflare's rate-limit rule covers the auth and withdrawal paths (HANDOFF, Round 23a): this test signs in
 *     twice at the start and never calls them again, so the rule should never fire.
 * Any 429 therefore means a limit was hit that the plan says should not be (the test fails and says which one
 * answered: a JSON body is the API, Cloudflare answers with its own HTML page). A Cloudflare block or challenge
 * (403 without a JSON body) fails the test too: staging must not challenge API clients.
 *
 * Fails when: any 5xx, any 429 or Cloudflare challenge, more than MAX_ERROR_PCT (default 1) % other errors, or a
 * p95 above MAX_P95_MS (default 1500 ms) for search / 3000 ms for checkout and chat steps.
 */
import { API, api, call, need, payMock, signIn, type Api } from './staging-client.js';

const DURATION_MS = Math.min(Number(process.env.DURATION_SECONDS ?? 120), 600) * 1000;
const RPS = Math.min(Number(process.env.RPS ?? 4), 4.5);
const USERS = Math.max(1, Math.min(Number(process.env.VIRTUAL_USERS ?? 4), 8));
const CHECKOUT_SHARE = Number(process.env.CHECKOUT_SHARE ?? 0.1);
const CHAT_SHARE = Number(process.env.CHAT_SHARE ?? 0.15);
const MAX_ERROR_PCT = Number(process.env.MAX_ERROR_PCT ?? 1);
const MAX_P95: Record<string, number> = { search: Number(process.env.MAX_P95_MS ?? 1500), checkout: 3000, chat: 3000 };

// One pacer for every request: a slot every 1000/RPS ms.
let nextSlot = Date.now();
async function slot() {
  const at = Math.max(nextSlot, Date.now());
  nextSlot = at + 1000 / RPS;
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

type Kind = 'search' | 'checkout' | 'chat';
const stats: Record<Kind, { ms: number[]; ok: number; errors: Record<string, number> }> = {
  search: { ms: [], ok: 0, errors: {} },
  checkout: { ms: [], ok: 0, errors: {} },
  chat: { ms: [], ok: 0, errors: {} },
};
let limited = 0;
let blocked = 0; // 403 without an API error body: a Cloudflare block or challenge
let fiveXX = 0;

async function timed(kind: Kind, label: string, fn: () => Promise<{ status: number; body: any; ms: number }>, okStatus = [200, 201]) {
  await slot();
  let r: { status: number; body: any; ms: number };
  try {
    r = await fn();
  } catch {
    stats[kind].errors[`${label}: network`] = (stats[kind].errors[`${label}: network`] ?? 0) + 1;
    return null;
  }
  stats[kind].ms.push(r.ms);
  if (okStatus.includes(r.status)) {
    stats[kind].ok++;
    return r;
  }
  if (r.status === 429) limited++;
  if (r.status === 403 && r.body === null) blocked++;
  if (r.status >= 500) fiveXX++;
  const key = `${label}: ${r.status} ${r.body ? (r.body.error?.code ?? r.body.error ?? 'API') : '(no JSON body: Cloudflare)'}`;
  stats[kind].errors[key] = (stats[kind].errors[key] ?? 0) + 1;
  return null;
}

const SEARCHES = [
  () => '/offers?game=path-of-exile-2&category=currency&sort=price_asc',
  () => '/offers?game=path-of-exile-2&category=items',
  () => `/offers?q=${['divine', 'exalted', 'chaos orb', 'mirror'][Math.floor(Math.random() * 4)]}`,
  () => `/offers?q=${['divne', 'exalt', 'poe2 currncy'][Math.floor(Math.random() * 3)]}`,
  () => '/offers?game=path-of-exile&category=currency&sort=rating',
  () => `/offers?page=${1 + Math.floor(Math.random() * 3)}`,
  () => `/games?q=${['pa', 'path', 'poe'][Math.floor(Math.random() * 3)]}`,
  () => '/offers?game=albion-online&category=currency&sort=price_asc',
];

async function main() {
  const seller = api(await signIn('seller', need('SELLER_EMAIL'), need('SELLER_PASSWORD')));
  const buyer = api(await signIn('buyer', need('BUYER_EMAIL'), need('BUYER_PASSWORD')));
  await seller.post('/sandbox/verify-me');
  await buyer.post('/sandbox/verify-me');
  const run = Date.now().toString(36);
  const offer = (await seller.post('/offers', { categorySlug: 'currency', game: 'Albion Online', title: `Load test ${run}`, priceCents: 2_00, deliveryMode: 'manual', stock: 10_000, unitLabel: 'M', unitSize: 1_000_000, minQty: 1, attributes: { server: 'Europe' } })).body;
  if (!offer?.id) throw new Error('could not create the load-test listing');
  const room = (await buyer.post('/chat/rooms', { offerId: offer.id })).body;
  if (!room?.id) throw new Error('could not open the pre-sale chat');
  console.log(`load test: ${API}, ${DURATION_MS / 1000}s at ≤ ${RPS} req/s with ${USERS} virtual users`);

  const checkout = async (b: Api) => {
    const o = await timed('checkout', 'create order', () => b.post('/orders', { offerId: offer.id, quantity: 1, acceptTos: true, characterName: 'LoadTest' }));
    if (!o) return;
    const order = o.body.order;
    await timed('checkout', 'pay', async () => {
      const started = performance.now();
      const status = await payMock(order);
      return { status, body: null, ms: performance.now() - started };
    });
    await timed('checkout', 'confirm', () => b.post(`/orders/${order.id}/confirm`, {}));
  };
  const chat = async (b: Api) => {
    await timed('chat', 'send', () => b.post(`/chat/rooms/${room.id}/messages`, { body: `Still in stock for the new league? (${Math.floor(Math.random() * 1000)})` }));
    await timed('chat', 'read', () => b.get(`/chat/rooms/${room.id}/messages?limit=50`));
  };

  const deadline = Date.now() + DURATION_MS;
  await Promise.all(
    Array.from({ length: USERS }, async () => {
      while (Date.now() < deadline) {
        const roll = Math.random();
        if (roll < CHECKOUT_SHARE) await checkout(buyer);
        else if (roll < CHECKOUT_SHARE + CHAT_SHARE) await chat(buyer);
        else await timed('search', 'search', () => call('GET', SEARCHES[Math.floor(Math.random() * SEARCHES.length)]!()));
      }
    }),
  );
  await seller.patch(`/offers/${offer.id}`, { version: offer.version, status: 'removed' }).catch(() => {}); // tidy up

  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : 0;
  };
  let failed = false;
  let total = 0;
  let errors = 0;
  for (const [kind, s] of Object.entries(stats) as Array<[Kind, (typeof stats)[Kind]]>) {
    const n = s.ms.length;
    const errN = Object.values(s.errors).reduce((a, b) => a + b, 0);
    total += s.ok + errN;
    errors += errN;
    const p95 = pct(s.ms, 95);
    console.log(`${kind.padEnd(9)} ${String(n).padStart(5)} req  p50 ${pct(s.ms, 50)} ms  p95 ${p95} ms  p99 ${pct(s.ms, 99)} ms  errors ${errN}`);
    for (const [k, v] of Object.entries(s.errors)) console.log(`          ${v} × ${k}`);
    if (n && p95 > MAX_P95[kind]!) {
      failed = true;
      console.log(`FAIL  ${kind} p95 ${p95} ms > ${MAX_P95[kind]} ms`);
    }
  }
  const errPct = total ? (100 * errors) / total : 0;
  console.log(`total ${total} requests in ${DURATION_MS / 1000}s (${(total / (DURATION_MS / 1000)).toFixed(1)}/s), errors ${errPct.toFixed(2)}%`);
  if (limited) console.log(`FAIL  ${limited} × 429: a rate limit fired (see the error lines: an API code or Cloudflare)`);
  if (blocked) console.log(`FAIL  ${blocked} × 403 from Cloudflare (WAF/bot rule challenged the runner)`);
  if (fiveXX) console.log(`FAIL  ${fiveXX} × 5xx`);
  if (errPct > MAX_ERROR_PCT) console.log(`FAIL  error rate ${errPct.toFixed(2)}% > ${MAX_ERROR_PCT}%`);
  failed ||= limited > 0 || blocked > 0 || fiveXX > 0 || errPct > MAX_ERROR_PCT;
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
