import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueMonthlyInvoices, monthStart } from '../src/domain/invoices.js';
import { accountId, balance } from '../src/domain/ledger.js';
import { FakeVatValidator } from '../src/providers/vat.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ PLATFORM_TAX_COUNTRY: 'IE', PLATFORM_VAT_ID: 'IE1234567T', PLATFORM_LEGAL_NAME: 'Bullizard Ltd' }, { vat: new FakeVatValidator(new Set(['FR12345678901'])) });
});
afterAll(async () => h.close());

async function sale(seller: Awaited<ReturnType<typeof makeUser>>, priceCents = 100_00) {
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1, priceCents });
  const order = await buyAndPay(h, buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
  await buyer.api.post(`/v1/orders/${order.id}/confirm`);
  return (await h.ctx.db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
}

describe('tax on commission', () => {
  it('charges the seller-country rate to consumers and reverse-charges verified EU businesses', async () => {
    const german = await makeUser(h, { tier: 2 });
    expect((await german.api.put('/v1/seller/tax-profile', { country: 'DE', isBusiness: false })).body.commissionTax).toMatchObject({ treatment: 'standard', rateBps: 1900 });
    const de = await sale(german);
    expect(de).toMatchObject({ tax_country: 'DE', tax_treatment: 'standard', tax_rate_bps: 1900 });
    expect(Number(de.commission_tax_cents)).toBe(Math.round((Number(de.commission_cents) * 1900) / 11_900));
    // The seller is paid their price either way: commission (VAT-inclusive) sits on top of it.
    expect(Number(de.seller_net_cents)).toBe(100_00);
    expect(Number(de.amount_cents)).toBe(100_00 + Number(de.commission_cents));

    const french = await makeUser(h, { tier: 2 });
    expect((await french.api.put('/v1/seller/tax-profile', { country: 'FR', isBusiness: true, taxId: 'FR 99 999999999' })).body.error.code).toBe('tax_id_not_registered');
    expect((await french.api.put('/v1/seller/tax-profile', { country: 'FR', isBusiness: true, taxId: '123' })).body.error.code).toBe('invalid_tax_id');
    expect((await french.api.put('/v1/seller/tax-profile', { country: 'FR', isBusiness: true })).body.error.code).toBe('tax_id_required');
    const profile = (await french.api.put('/v1/seller/tax-profile', { country: 'FR', isBusiness: true, taxId: 'FR12345678901', billingAddress: '1 rue de Rivoli, Paris' })).body;
    expect(profile).toMatchObject({ taxId: '12345678901', taxIdVerified: true, commissionTax: { treatment: 'reverse_charge', rateBps: 0 } });
    const fr = await sale(french);
    expect(fr).toMatchObject({ tax_treatment: 'reverse_charge', tax_rate_bps: 0 });
    expect(Number(fr.commission_tax_cents)).toBe(0);

    const american = await makeUser(h, { tier: 2 });
    await american.api.put('/v1/seller/tax-profile', { country: 'US', isBusiness: false });
    expect((await sale(american)).tax_treatment).toBe('outside_scope');

    // No profile yet: taxed like a consumer in the platform's own country.
    const unknown = await makeUser(h, { tier: 2 });
    expect(await sale(unknown)).toMatchObject({ tax_country: 'IE', tax_rate_bps: 2300 });

    // The tax sits in tax_payable, not in platform revenue.
    const payable = await balance(h.ctx.db, await accountId(h.ctx.db, 'tax_payable', 'USD'));
    expect(payable).toBe(Number(de.commission_tax_cents) + Math.round((Number(de.commission_cents) * 2300) / 12_300));

    const admin = await makeUser(h, { role: 'admin' });
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = (await admin.api.get(`/v1/admin/tax/report?from=${today}&to=${tomorrow}`)).body;
    expect(report.find((r: any) => r.country === 'DE')).toMatchObject({ treatment: 'standard', rate_bps: 1900, orders: 1 });
    const csv = await admin.api.get(`/v1/admin/tax/report?from=${today}&to=${tomorrow}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(String(csv.body).split(/\r?\n/)[0]).toBe('country,treatment,rate_bps,currency,orders,credit_notes,commission_gross_cents,tax_cents,commission_net_cents');

    // Paying the tax over: four-eyes withdrawal from tax_payable, not from revenue.
    const admin2 = await makeUser(h, { role: 'admin' });
    const w = (await admin.api.post('/v1/admin/treasury/withdrawals', { amountCents: payable, note: 'VAT return Q3', source: 'tax_payable' })).body;
    expect((await admin2.api.post(`/v1/admin/treasury/withdrawals/${w.id}/decide`, { approve: true })).body.status).toBe('paid');
    expect(await balance(h.ctx.db, await accountId(h.ctx.db, 'tax_payable', 'USD'))).toBe(0);
  });
});

describe('commission invoices', () => {
  it('issues one immutable, gapless-numbered invoice per seller per month, with a PDF', async () => {
    const a = await makeUser(h, { tier: 2 });
    await a.api.put('/v1/seller/tax-profile', { country: 'DE', isBusiness: false, billingAddress: 'Hauptstr. 1, Berlin' });
    const b = await makeUser(h, { tier: 2 });
    await b.api.put('/v1/seller/tax-profile', { country: 'FR', isBusiness: true, taxId: 'FR12345678901' });
    const a1 = await sale(a, 40_00);
    const a2 = await sale(a, 60_00);
    await sale(b, 50_00);

    const month = monthStart(new Date());
    const run = await issueMonthlyInvoices(h.ctx, month);
    expect(run.issued.length).toBeGreaterThanOrEqual(2);
    const numbers = run.issued.map((n) => Number(n.split('-').pop()));
    expect(numbers).toEqual(numbers.map((_, i) => numbers[0]! + i)); // consecutive, no gaps
    expect((await issueMonthlyInvoices(h.ctx, month)).issued).toEqual([]); // idempotent

    const list = (await a.api.get('/v1/seller/invoices')).body;
    expect(list).toHaveLength(1);
    const inv = (await a.api.get(`/v1/seller/invoices/${list[0].id}`)).body;
    expect(inv.number).toMatch(new RegExp(`^BZ-${month.slice(0, 4)}-\\d{6}$`));
    expect(inv.lines.map((l: any) => l.orderId).sort()).toEqual([a1.id, a2.id].sort());
    expect(Number(inv.gross_cents)).toBe(Number(a1.commission_cents) + Number(a2.commission_cents));
    expect(Number(inv.net_cents) + Number(inv.tax_cents)).toBe(Number(inv.gross_cents));
    expect(inv.seller).toMatchObject({ country: 'DE', address: 'Hauptstr. 1, Berlin' });
    expect(inv.issuer).toMatchObject({ name: 'Bullizard Ltd', vatId: 'IE1234567T' });

    const pdf = await a.api.get(`/v1/seller/invoices/${inv.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.body).slice(0, 4)).toBe('%PDF');
    expect((await b.api.get(`/v1/seller/invoices/${inv.id}`)).status).toBe(404);
    const bInv = (await b.api.get('/v1/seller/invoices')).body[0];
    expect((await b.api.get(`/v1/seller/invoices/${bInv.id}`)).body.totals[0]).toMatchObject({ treatment: 'reverse_charge', taxCents: 0 });

    await expect(h.ctx.db.query('UPDATE invoices SET gross_cents = 0 WHERE id = $1', [inv.id])).rejects.toThrow(/append-only/);
    expect((await client(h.app).get(`/v1/seller/invoices/${inv.id}`)).status).toBe(401);
  });
});
