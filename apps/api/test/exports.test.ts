import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/domain/exports.js';
import { parseCsv } from '../src/domain/aml.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('accounting exports', () => {
  it('escapes CSV and neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('-42')).toBe('-42');
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(toCsv(['a', 'b'], [{ a: 1, b: null }])).toBe('a,b\r\n1,\r\n');
  });

  it('gives sellers sales, a reconciled statement, payouts and invoices for their books', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET stripe_account_id = 'acct_e', payouts_enabled = true, payout_hold_days = 0 WHERE id = $1`, [seller.id]);
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 3, priceCents: 25_00, title: '=cmd|calc' });
    const orders = [];
    for (let i = 0; i < 2; i++) {
      const o = await buyAndPay(h, buyer, offer.id);
      await seller.api.post(`/v1/orders/${o.id}/deliver`, { payload: 'done' });
      await buyer.api.post(`/v1/orders/${o.id}/confirm`);
      orders.push(o);
    }
    await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 });

    const sales = await seller.api.get('/v1/seller/exports/sales');
    expect(sales.headers['content-type']).toMatch(/text\/csv/);
    expect(sales.headers['content-disposition']).toMatch(/bullizard-sales-/);
    const [header, ...rows] = parseCsv(sales.body);
    expect(header).toContain('commission_tax_cents');
    expect(rows).toHaveLength(2);
    expect(rows[0]![header!.indexOf('offer')]).toBe(`'=cmd|calc`); // formula neutralised

    const st = (await seller.api.get('/v1/seller/exports/statement?format=json')).body;
    const movements = st.rows.slice(1, -1);
    expect(st.rows[0]).toMatchObject({ description: 'Opening balance', balance_cents: 0 });
    expect(movements.map((r: any) => r.description)).toEqual(['Sale released from escrow', 'Sale released from escrow', 'Payout to your account']);
    const closing = st.rows.at(-1);
    expect(closing.balance_cents).toBe(movements.reduce((s: number, r: any) => s + Number(r.amount_cents), 0));
    expect(closing.balance_cents).toBe(Number((await seller.api.get('/v1/seller/dashboard')).body.balances.availableCents));

    expect((await seller.api.get('/v1/seller/exports/payouts?format=json')).body.rows).toHaveLength(1);
    expect((await seller.api.get('/v1/seller/exports/statement?from=2026-01-01&to=2028-01-01')).body.error.code).toBe('range_too_long');
    const salesJson = (await seller.api.get('/v1/seller/exports/sales?format=json')).body;
    expect(salesJson.rows.map((r: any) => r.order_id).sort()).toEqual(orders.map((o) => o.id).sort());
  });
});
