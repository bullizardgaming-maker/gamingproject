/**
 * Flash-sale load test.
 *
 *   DATABASE_URL=<same DB as the API> BASE_URL=http://localhost:4000 BUYERS=500 STOCK=50 CONCURRENCY=100 npx tsx scripts/loadtest-flash-sale.ts
 *
 * Start the API with RATE_LIMIT_PER_MINUTE / AUTH_RATE_LIMIT_PER_MINUTE raised, or
 * the per-IP limits will reject most of the simulated buyers.
 *
 * Creates one listing with STOCK codes and BUYERS verified buyers, then has all of
 * them try to buy (and pay for) the listing at once over real HTTP. Reports
 * latency and outcomes, and checks the database afterwards:
 *   - no item sold twice and no more orders paid than stock
 *   - every ledger transaction balances, escrow matches order states
 * Run against a disposable database: it creates users and orders.
 */
import { performance } from 'node:perf_hooks';
import { Agent, setGlobalDispatcher } from 'undici';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { hashPassword } from '../src/lib/crypto.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { MockPaymentProvider } from '../src/providers/payments/mock.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const BUYERS = Number(process.env.BUYERS ?? 300);
const STOCK = Number(process.env.STOCK ?? 50);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 100);
setGlobalDispatcher(new Agent({ connections: CONCURRENCY * 2, pipelining: 1 }));

const cfg = loadConfig();
const quiet = { info() {}, warn() {}, error: (o: unknown, m?: string) => console.error(m, o) };
const ctx = createContext(cfg, quiet);
const mock = ctx.payments as MockPaymentProvider;

async function http(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-token-delivery': 'body', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: json };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(0) : '-';
};

async function main() {
  const run = Date.now();
  const pw = await hashPassword('load-test-password');
  const { rows: [seller] } = await ctx.db.query(
    `INSERT INTO users (email, password_hash, display_name, kyc_tier, email_verified_at, phone_verified_at, legal_name)
     VALUES ($1, $2, 'Load seller', 2, now(), now(), 'Load seller') RETURNING id`,
    [`load-seller-${run}@example.test`, pw],
  );
  const { rows: [offer] } = await ctx.db.query(
    `INSERT INTO offers (seller_id, category_slug, game, title, price_cents, delivery_mode) VALUES ($1, 'keys', 'Load Test', 'Flash sale key', 999, 'auto') RETURNING id`,
    [seller.id],
  );
  const { addInventory } = await import('../src/domain/inventory.js');
  await addInventory(ctx, ctx.db, seller.id, offer.id, Array.from({ length: STOCK }, (_, i) => `FLASH-${run}-${i}`));

  console.log(`Creating ${BUYERS} buyers…`);
  const buyers: Array<{ token: string }> = [];
  for (let i = 0; i < BUYERS; i++) {
    await ctx.db.query(
      `INSERT INTO users (email, password_hash, display_name, kyc_tier, email_verified_at, phone_verified_at) VALUES ($1, $2, $3, 1, now(), now())`,
      [`load-buyer-${run}-${i}@example.test`, pw, `Buyer ${i}`],
    );
  }
  // Sign buyers in over HTTP (exercises auth too), a batch at a time.
  for (let i = 0; i < BUYERS; i += CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, BUYERS - i) }, (_, j) =>
        http('POST', '/v1/auth/login', undefined, { email: `load-buyer-${run}-${i + j}@example.test`, password: 'load-test-password' }, { 'x-device-fingerprint': `dev-${run}-${i + j}` }),
      ),
    );
    for (const b of batch) {
      if (b.status !== 200) throw new Error(`login failed: ${b.status} ${JSON.stringify(b.body)}`);
      buyers.push({ token: b.body.token });
    }
  }

  console.log(`Flash sale: ${BUYERS} buyers, ${STOCK} in stock, concurrency ${CONCURRENCY}`);
  const orderLatency: number[] = [];
  const payLatency: number[] = [];
  const outcomes: Record<string, number> = {};
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < buyers.length) {
        const b = buyers[next++]!;
        const s = performance.now();
        const o = await http('POST', '/v1/orders', b.token, { offerId: offer.id, acceptTos: true });
        orderLatency.push(performance.now() - s);
        const key = o.status === 201 ? 'ordered' : `${o.status} ${o.body?.error?.code ?? ''}`.trim();
        outcomes[key] = (outcomes[key] ?? 0) + 1;
        if (o.status !== 201) continue;
        const p0 = performance.now();
        const raw = JSON.stringify({
          type: 'payment.captured', ref: o.body.order.payment_ref, orderId: o.body.order.id,
          amountCents: o.body.order.presentment_amount_cents, currency: o.body.order.presentment_currency,
          details: { avsResult: 'pass', cvvResult: 'pass', cardBrand: 'visa', cardLast4: '4242' },
        });
        const paid = await fetch(`${BASE}/v1/payments/webhook/mock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': mock.sign(raw) }, body: raw });
        payLatency.push(performance.now() - p0);
        const pk = paid.ok ? 'paid' : `payment ${paid.status}`;
        outcomes[pk] = (outcomes[pk] ?? 0) + 1;
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;

  const { rows: [inv] } = await ctx.db.query(
    `SELECT count(*) FILTER (WHERE status IN ('reserved', 'delivered'))::int AS sold, count(DISTINCT order_id)::int AS orders,
            count(*) FILTER (WHERE status = 'available')::int AS left FROM inventory_items WHERE offer_id = $1`,
    [offer.id],
  );
  const { rows: [dup] } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM (SELECT order_id FROM inventory_items WHERE offer_id = $1 AND order_id IS NOT NULL GROUP BY order_id HAVING count(*) > 1) x`,
    [offer.id],
  );
  const { rows: [paidOrders] } = await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE offer_id = $1 AND status IN ('paid', 'delivered')`, [offer.id]);
  const recon = await runReconciliation(ctx);
  const ledgerIssues = recon.report.issues.filter((i) => i.check !== 'psp_balance_mismatch');

  console.log(`\nDone in ${seconds.toFixed(1)}s — ${(BUYERS / seconds).toFixed(0)} checkout attempts/s`);
  console.log('Outcomes:', outcomes);
  console.log(`Create order latency ms  p50 ${pct(orderLatency, 50)}  p95 ${pct(orderLatency, 95)}  p99 ${pct(orderLatency, 99)}  max ${pct(orderLatency, 100)}`);
  console.log(`Payment+delivery ms      p50 ${pct(payLatency, 50)}  p95 ${pct(payLatency, 95)}  p99 ${pct(payLatency, 99)}  max ${pct(payLatency, 100)}`);
  console.log(`Inventory: ${inv.sold} sold to ${inv.orders} orders, ${inv.left} left; paid/delivered orders ${paidOrders.n}`);

  const failures: string[] = [];
  if (inv.sold > STOCK) failures.push(`OVERSOLD: ${inv.sold} > ${STOCK}`);
  if (dup.n > 0) failures.push(`${dup.n} orders received more than one item`);
  if (paidOrders.n > STOCK) failures.push(`${paidOrders.n} orders paid for ${STOCK} items`);
  if (ledgerIssues.length) failures.push(`reconciliation: ${JSON.stringify(ledgerIssues).slice(0, 500)}`);
  if (Object.keys(outcomes).some((k) => /^5\d\d/.test(k))) failures.push('server errors during the sale');
  console.log(failures.length ? `\nFAILED:\n - ${failures.join('\n - ')}` : '\nPASSED: no oversell, no double delivery, books balanced');
  await ctx.db.end();
  await ctx.pubsub.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
