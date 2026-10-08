import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rocAuc } from '../src/domain/fraud.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
let gnn: Server;
// What the stand-in graph model answers: a fixed score, or an HTTP error when null.
let gnnScore: number | null = 0.95;

beforeAll(async () => {
  gnn = createServer((req, res) => {
    if (gnnScore === null) return res.writeHead(500).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ score: gnnScore, model_version: 'v-test' }));
  });
  await new Promise<void>((r) => gnn.listen(0, '127.0.0.1', r));
  h = await setup({ FRAUD_GNN_URL: `http://127.0.0.1:${(gnn.address() as AddressInfo).port}` });
});
afterAll(async () => {
  await h.close();
  gnn.close();
});

const scoreRow = async (orderId: string) => (await h.ctx.db.query('SELECT * FROM fraud_scores WHERE order_id = $1', [orderId])).rows[0];
const frozen = async (orderId: string) => (await h.ctx.db.query('SELECT escrow_frozen FROM orders WHERE id = $1', [orderId])).rows[0].escrow_frozen;

async function sale() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1, priceCents: 30_00 });
  const order = await buyAndPay(h, buyer, offer.id);
  return { seller, buyer, order };
}

describe('fraud model shadow mode', () => {
  it('records the model score without acting on it, labels outcomes, and reports both side by side', async () => {
    expect(h.ctx.cfg.FRAUD_GNN_MODE).toBe('shadow');
    const fraudSale = await sale();
    const legitSale = await sale();

    for (const { order } of [fraudSale, legitSale]) {
      const row = await scoreRow(order.id);
      expect(row).toMatchObject({ mode: 'shadow', gnn_score: 0.95, model_version: 'v-test' });
      expect(Number(row.used_score)).toBe(Number(row.heuristic_score));
      expect(Number(row.used_score)).toBeLessThan(h.ctx.cfg.FRAUD_REVIEW_THRESHOLD);
      expect(await frozen(order.id)).toBe(false); // the model's 0.95 didn't freeze anything
    }

    // Outcomes: one buyer turns out to be a confirmed fraudster; the other order completed long ago.
    await h.ctx.db.query(`UPDATE users SET suspension_reason = 'fraud_confirmed' WHERE id = $1`, [fraudSale.buyer.id]);
    await h.ctx.db.query(`UPDATE orders SET status = 'completed', paid_at = now() - interval '200 days' WHERE id = $1`, [legitSale.order.id]);

    const support = await makeUser(h, { role: 'support' });
    expect((await support.api.get('/v1/admin/fraud/model-report')).status).toBe(403);
    const compliance = await makeUser(h, { role: 'compliance' });
    const report = (await compliance.api.get('/v1/admin/fraud/model-report?days=30')).body;
    expect(report).toMatchObject({ mode: 'shadow', scored: 2, modelScored: 2, labelled: 2, unlabelled: 0 });
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({
      modelVersion: 'v-test',
      orders: 2,
      fraud: 1,
      model: { flagged: 2, caught: 1, precision: 0.5, recall: 1 },
      heuristic: { flagged: 0, caught: 0, recall: 0 },
      onlyModelFlagged: { fraud: 1, legit: 1 },
      onlyHeuristicFlagged: { fraud: 0, legit: 0 },
    });
    expect((await scoreRow(fraudSale.order.id)).label).toBe('fraud');
    expect((await scoreRow(legitSale.order.id)).label).toBe('legit');
  });

  it('acts on the higher score in enforce mode, and falls back to the heuristic when the model is down', async () => {
    h.ctx.cfg.FRAUD_GNN_MODE = 'enforce';
    try {
      const { order } = await sale();
      expect(await scoreRow(order.id)).toMatchObject({ mode: 'enforce', used_score: 0.95 });
      expect(await frozen(order.id)).toBe(true);

      gnnScore = null;
      const down = await sale();
      const row = await scoreRow(down.order.id);
      expect(row).toMatchObject({ mode: 'off', gnn_score: null });
      expect(Number(row.used_score)).toBe(Number(row.heuristic_score));
      expect(await frozen(down.order.id)).toBe(false);
    } finally {
      h.ctx.cfg.FRAUD_GNN_MODE = 'shadow';
      gnnScore = 0.95;
    }
  });

  it('computes AUC as the chance a fraud case outscores a legit one', () => {
    expect(rocAuc([{ score: 0.9, fraud: true }, { score: 0.1, fraud: false }])).toBe(1);
    expect(rocAuc([{ score: 0.2, fraud: true }, { score: 0.8, fraud: false }])).toBe(0);
    expect(rocAuc([{ score: 0.5, fraud: true }, { score: 0.5, fraud: false }])).toBe(0.5);
    expect(rocAuc([{ score: 0.5, fraud: true }])).toBeNull();
  });
});
