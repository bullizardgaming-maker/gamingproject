/**
 * Search load test.
 *
 *   DATABASE_URL=<same DB as the API> BASE_URL=http://localhost:4000 LISTINGS=5000 REQUESTS=2000 CONCURRENCY=50 npx tsx scripts/loadtest-search.ts
 *
 * Start the API with RATE_LIMIT_PER_MINUTE raised. Adds LISTINGS listings across 50 sellers and
 * 20 games (most with manual stock, some with instant inventory), then sends REQUESTS market
 * searches over real HTTP: text and typo'd text, game and category pages, price and rating
 * sorts, rating and delivery filters, and the game directory. Reports latency per kind and fails
 * on any error, or when MAX_SEARCH_P95_MS (optional) is exceeded. Run against a disposable database.
 */
import { performance } from 'node:perf_hooks';
import { Agent, setGlobalDispatcher } from 'undici';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { addInventory } from '../src/domain/inventory.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const LISTINGS = Number(process.env.LISTINGS ?? 5000);
const REQUESTS = Number(process.env.REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const MAX_P95 = Number(process.env.MAX_SEARCH_P95_MS ?? Infinity);
setGlobalDispatcher(new Agent({ connections: CONCURRENCY * 2, pipelining: 1 }));

const GAMES = ['Elden Ring', 'Valorant', 'Counter-Strike 2', 'League of Legends', 'Fortnite', 'Minecraft', 'Old School RuneScape', 'World of Warcraft',
  'Apex Legends', 'Genshin Impact', 'Rocket League', 'Dota 2', 'Path of Exile 2', 'Diablo IV', 'EA Sports FC 26', 'Roblox', 'Clash of Clans', 'Baldur’s Gate 3', 'Cyberpunk 2077', 'Hogwarts Legacy'];
const CATEGORIES = ['keys', 'currency', 'items'];

const cfg = loadConfig();
const quiet = { info() {}, warn() {}, error: (o: unknown, m?: string) => console.error(m, o) };
const ctx = createContext(cfg, quiet);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : 0;
};

async function seed(run: number) {
  const { rows: sellers } = await ctx.db.query(
    `INSERT INTO users (email, password_hash, display_name, kyc_tier, email_verified_at, phone_verified_at, legal_name)
     SELECT 'search-seller-' || $1 || '-' || i || '@example.test', 'x', 'Seller ' || i, 2, now(), now(), 'Seller ' || i FROM generate_series(1, 50) i
     RETURNING id`,
    [run],
  );
  // Ratings come from reviews; seeding orders for them is out of scope here, so set the counters directly.
  await ctx.db.query(`UPDATE users SET rating_avg = 3.5 + random() * 1.5, review_count = (random() * 200)::int, completed_orders = (random() * 2000)::int WHERE id = ANY($1)`, [sellers.map((s) => s.id)]);
  const manual = Math.floor(LISTINGS * 0.95);
  await ctx.db.query(
    `INSERT INTO offers (seller_id, category_slug, game, title, description, price_cents, delivery_mode, stock)
     SELECT ($1::uuid[])[1 + i % 50], ($2::text[])[1 + i % 3], ($3::text[])[1 + (i / 3) % 20],
            ($3::text[])[1 + (i / 3) % 20] || ' ' || (ARRAY['bundle', 'pack', 'gold', 'starter', 'deluxe', 'skin'])[1 + i % 6] || ' #' || i,
            'Search load test listing', 100 + (random() * 20000)::int, 'manual', CASE WHEN i % 10 = 0 THEN 0 ELSE 1 + i % 25 END
       FROM generate_series(1, $4) i`,
    [sellers.map((s) => s.id), CATEGORIES, GAMES, manual],
  );
  const instant = LISTINGS - manual;
  for (let i = 0; i < instant; i++) {
    const seller = sellers[i % sellers.length]!.id;
    const { rows: [o] } = await ctx.db.query(
      `INSERT INTO offers (seller_id, category_slug, game, title, price_cents, delivery_mode) VALUES ($1, 'keys', $2, $3, $4, 'auto') RETURNING id`,
      [seller, GAMES[i % GAMES.length], `${GAMES[i % GAMES.length]} instant key #${i}`, 500 + i],
    );
    await addInventory(ctx, ctx.db, seller, o.id, Array.from({ length: 5 }, (_, k) => `S-${run}-${i}-${k}`));
  }
  await ctx.db.query('ANALYZE offers; ANALYZE users; ANALYZE inventory_items');
}

const slug = (g: string) => encodeURIComponent(g);
const KINDS: Array<[string, (i: number) => string]> = [
  ['text', (i) => `/v1/offers?q=${slug(GAMES[i % 20]!.split(' ')[0]!)}`],
  ['typo', (i) => `/v1/offers?q=${['eldn', 'valornt', 'minecrft', 'runescap', 'fortnte'][i % 5]}`],
  ['game page', (i) => `/v1/offers?game=${slug(GAMES[i % 20]!)}&category=${CATEGORIES[i % 3]}&sort=price_asc`],
  ['newest', (i) => `/v1/offers?page=${1 + (i % 5)}`],
  ['rating', (i) => `/v1/offers?sort=rating&minRating=4.5&category=${CATEGORIES[i % 3]}`],
  ['instant', () => `/v1/offers?delivery=instant&sort=best_selling`],
  ['directory', () => `/v1/catalog/games`],
  ['suggest', (i) => `/v1/games?q=${['el', 'val', 'mine', 'old', 'fort'][i % 5]}`],
];

async function main() {
  const run = Date.now();
  console.log(`Seeding ${LISTINGS} listings…`);
  await seed(run);

  const latency: Record<string, number[]> = {};
  const errors: string[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < REQUESTS) {
        const i = next++;
        const [kind, path] = KINDS[i % KINDS.length]!;
        const s = performance.now();
        const res = await fetch(BASE + path(i));
        await res.arrayBuffer();
        (latency[kind] ??= []).push(performance.now() - s);
        if (res.status !== 200) errors.push(`${res.status} ${path(i)}`);
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  const all = Object.values(latency).flat();

  console.log(`\n${REQUESTS} searches in ${seconds.toFixed(1)}s — ${(REQUESTS / seconds).toFixed(0)}/s at concurrency ${CONCURRENCY}`);
  for (const [kind, xs] of Object.entries(latency)) console.log(`${kind.padEnd(10)} p50 ${pct(xs, 50)}ms  p95 ${pct(xs, 95)}ms  max ${pct(xs, 100)}ms`);
  console.log(`${'all'.padEnd(10)} p50 ${pct(all, 50)}ms  p95 ${pct(all, 95)}ms`);

  const failures: string[] = [];
  if (errors.length) failures.push(`${errors.length} failed requests, e.g. ${errors.slice(0, 3).join('; ')}`);
  if (pct(all, 95) > MAX_P95) failures.push(`search p95 ${pct(all, 95)}ms over ${MAX_P95}ms`);
  console.log(failures.length ? `\nFAILED:\n - ${failures.join('\n - ')}` : '\nPASSED');
  await ctx.db.end();
  await ctx.pubsub.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
