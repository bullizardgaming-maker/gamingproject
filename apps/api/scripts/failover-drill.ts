/**
 * Failover drill: runs steady marketplace traffic against a real API + worker and breaks
 * dependencies one at a time, measuring what users see and checking the books afterwards.
 *
 *   DATABASE_URL=postgres://.../market_drill REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/failover-drill.ts
 *
 * Phases (each ~PHASE_SECONDS): baseline, Redis down, Redis back, read replica down, replica back,
 * database connections killed, payment provider failing payouts, recovery.
 * Redis is stopped/started with DRILL_REDIS_STOP / DRILL_REDIS_START (default: `service redis-server stop|start`).
 * The read replica is simulated by a TCP proxy to the primary that the drill cuts.
 * Run against a disposable database: it creates users, orders and payouts.
 */
import { execSync } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { migrate } from '../src/db.js';
import { checkIntegrity } from '../src/domain/integrity.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { hashPassword } from '../src/lib/crypto.js';
import { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { buildApp } from '../src/server.js';
import { startWorker } from '../src/worker.js';

const PHASE_MS = Number(process.env.PHASE_SECONDS ?? 12) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const PORT = 4300;
const PROXY_PORT = 55433;
const REDIS_STOP = process.env.DRILL_REDIS_STOP ?? 'service redis-server stop';
const REDIS_START = process.env.DRILL_REDIS_START ?? 'service redis-server start';

// --- A cuttable TCP proxy standing in for the read replica --------------------------------
let proxy: Server | null = null;
const sockets = new Set<Socket>();
function startProxy(targetPort: number) {
  proxy = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const drop = () => (client.destroy(), upstream.destroy(), sockets.delete(client), sockets.delete(upstream));
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
  }).listen(PROXY_PORT);
}
function cutProxy() {
  proxy?.close();
  proxy = null;
  for (const s of sockets) s.destroy();
  sockets.clear();
}

const dbUrl = new URL(process.env.DATABASE_URL ?? 'postgres://market:market@localhost:5432/market_drill');
const readUrl = new URL(dbUrl);
readUrl.port = String(PROXY_PORT);
startProxy(Number(dbUrl.port || 5432));

const cfg = loadConfig({
  DATABASE_URL: dbUrl.toString(),
  DATABASE_READ_URL: readUrl.toString(),
  REPLICA_MAX_LAG_SECONDS: '10',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  RATE_LIMIT_PER_MINUTE: '1000000',
  AUTH_RATE_LIMIT_PER_MINUTE: '1000000',
  TRUST_PROXY: 'true',
  PORT: String(PORT),
  LOG_LEVEL: 'error',
} as any);
const errors: string[] = [];
const log = { info() {}, warn() {}, error: (o: any, m?: string) => errors.push(`${m ?? ''} ${o?.err?.message ?? o?.err ?? JSON.stringify(o)}`.slice(0, 200)) };
const ctx = createContext(cfg, log);
const mock = ctx.payments as MockPaymentProvider;
let crashes = 0;
process.on('uncaughtException', (err) => {
  crashes++;
  errors.push(`UNCAUGHT ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  crashes++;
  errors.push(`UNHANDLED ${(err as Error)?.message ?? err}`);
});

// --- Traffic ---------------------------------------------------------------------------------
const BASE = `http://127.0.0.1:${PORT}`;
interface Sample { ok: boolean; ms: number; kind: string; status: number }
let samples: Sample[] = [];

async function call(kind: string, method: string, path: string, token?: string, body?: unknown) {
  const t = performance.now();
  let status = 0;
  let json: any = null;
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-token-delivery': 'body', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    status = 0; // network error or timeout
  }
  const ms = performance.now() - t;
  samples.push({ ok: status > 0 && status < 500, ms, kind, status });
  return { status, json };
}

async function setupData() {
  await migrate(ctx.db);
  const pw = await hashPassword('drill-password-1');
  const run = Date.now();
  const mk = async (i: string, tier: number) =>
    (await ctx.db.query(
      `INSERT INTO users (email, password_hash, display_name, kyc_tier, email_verified_at, phone_verified_at, legal_name, stripe_account_id, payouts_enabled, payout_hold_days)
       VALUES ($1, $2, $3, $4, now(), now(), $3, 'acct_drill', true, 0) RETURNING id, email`,
      [`drill-${i}-${run}@example.test`, pw, `Drill ${i}`, tier],
    )).rows[0];
  const seller = await mk('seller', 2);
  const { rows: [offer] } = await ctx.db.query(
    `INSERT INTO offers (seller_id, category_slug, game, title, price_cents, delivery_mode, stock) VALUES ($1, 'boosting', 'Drill Game', 'Drill boost', 5_00, 'manual', 1000000) RETURNING id`,
    [seller.id],
  );
  const buyers = [];
  for (let i = 0; i < CONCURRENCY; i++) buyers.push(await mk(`buyer${i}`, 1));
  const login = async (u: { email: string }) => (await call('login', 'POST', '/v1/auth/login', undefined, { email: u.email, password: 'drill-password-1' })).json.token as string;
  const out = { seller: { ...seller, token: await login(seller) }, offerId: offer.id, buyers: await Promise.all(buyers.map(async (b) => ({ ...b, token: await login(b) }))) };
  // A few completed sales so the seller has a balance for the payout-outage check.
  for (const b of out.buyers.slice(0, 3)) {
    const o = await call('setup', 'POST', '/v1/orders', b.token, { offerId: out.offerId, acceptTos: true });
    await call('setup', 'POST', `/v1/payments/mock/checkout/${o.json.order.payment_ref}/pay`, undefined, {});
    await call('setup', 'POST', `/v1/orders/${o.json.order.id}/deliver`, out.seller.token, { payload: 'done' });
    await call('setup', 'POST', `/v1/orders/${o.json.order.id}/confirm`, b.token);
  }
  return out;
}

/** One "user session" step: browse (replica path), buy and pay (primary + PSP webhook + Redis publish), check the bell. */
async function userStep(buyer: { token: string }, offerId: string) {
  await call('search', 'GET', '/v1/offers?q=drill', buyer.token);
  const o = await call('order', 'POST', '/v1/orders', buyer.token, { offerId, acceptTos: true });
  if (o.status === 201) {
    const ref = o.json.order.payment_ref;
    await call('pay', 'POST', `/v1/payments/mock/checkout/${ref}/pay`, undefined, {});
  }
  await call('inbox', 'GET', '/v1/me/notifications/unread-count', buyer.token);
}

async function runPhase(name: string, data: Awaited<ReturnType<typeof setupData>>, during?: () => Promise<void>) {
  samples = [];
  const end = Date.now() + PHASE_MS;
  const loops = data.buyers.map(async (b) => {
    while (Date.now() < end) await userStep(b, data.offerId);
  });
  if (during) await during();
  await Promise.all(loops);
  const s = samples;
  const lat = s.map((x) => x.ms).sort((a, b) => a - b);
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]!.toFixed(0) : '-');
  const failed = s.filter((x) => !x.ok);
  const byKind = Object.fromEntries([...new Set(failed.map((f) => f.kind))].map((k) => [k, failed.filter((f) => f.kind === k).length]));
  return { phase: name, requests: s.length, failed: failed.length, errorRate: s.length ? ((failed.length / s.length) * 100).toFixed(1) + '%' : '-', p50: p(0.5), p95: p(0.95), max: lat.length ? lat[lat.length - 1]!.toFixed(0) : '-', failedByKind: byKind };
}

async function main() {
  const app = await buildApp(ctx);
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const stopWorker = startWorker(ctx, 500);
  const data = await setupData();
  const results = [];

  results.push(await runPhase('baseline', data));
  results.push(
    await runPhase('redis down', data, async () => {
      execSync(REDIS_STOP, { stdio: 'ignore' });
    }),
  );
  execSync(REDIS_START, { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  results.push(await runPhase('redis back', data));

  results.push(await runPhase('read replica down', data, async () => cutProxy()));
  startProxy(Number(dbUrl.port || 5432));
  await new Promise((r) => setTimeout(r, 6000)); // replica health is re-checked every 5s
  results.push(await runPhase('read replica back', data));

  results.push(
    await runPhase('db connections killed', data, async () => {
      await new Promise((r) => setTimeout(r, PHASE_MS / 3));
      const admin = (await import('pg')).default;
      const c = new admin.Client({ connectionString: dbUrl.toString() });
      await c.connect();
      await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
      await c.end();
    }),
  );

  // PSP outage for payouts: every withdrawal must fail cleanly and leave the balance intact.
  const before = (await call('balance', 'GET', '/v1/seller/dashboard', data.seller.token)).json?.balances?.availableCents;
  mock.faults.payout = 'psp_unavailable';
  const payoutResults = await Promise.all(Array.from({ length: 10 }, () => call('payout', 'POST', '/v1/seller/withdrawals', data.seller.token, { amountCents: 1 })));
  mock.faults = {};
  const after = (await call('balance', 'GET', '/v1/seller/dashboard', data.seller.token)).json?.balances?.availableCents;
  results.push(await runPhase('recovery', data));

  stopWorker();
  await new Promise((r) => setTimeout(r, 1500));
  const integrity = await checkIntegrity(ctx.db, { chatSample: 200 });
  const recon = await runReconciliation(ctx);
  const oversold = (await ctx.db.query(`SELECT count(*)::int AS n FROM offers WHERE stock < 0`)).rows[0].n;

  console.log('\n| Phase | Requests | Failed | Error rate | p50 ms | p95 ms | max ms | Failed by kind |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.phase} | ${r.requests} | ${r.failed} | ${r.errorRate} | ${r.p50} | ${r.p95} | ${r.max} | ${JSON.stringify(r.failedByKind)} |`);
  console.log(`\nPSP payout outage: ${payoutResults.map((r) => r.status).join(',')} — balance before ${before}, after ${after}`);
  console.log(`Process crashes/unhandled errors: ${crashes}`);
  console.log(`Integrity: ${integrity.ok ? 'OK' : 'FAILED ' + JSON.stringify(integrity.checks.filter((c) => !c.ok))}; reconciliation: ${recon.status}; oversold offers: ${oversold}`);
  const distinct = [...new Set(errors.map((e) => e.replace(/[0-9a-f-]{36}/g, '<id>')))].slice(0, 15);
  if (distinct.length) console.log(`\nLogged errors (distinct, first 15):\n- ${distinct.join('\n- ')}`);
  await app.close();
  cutProxy();
  await ctx.pubsub.close();
  await ctx.db.end();
  process.exit(integrity.ok && recon.status === 'ok' && oversold === 0 && before === after ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
