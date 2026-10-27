import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/domain/aml.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

describe('bulk listing CSV', () => {
  it('exports listings and round-trips edits, previewing before applying', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const a = await makeOffer(seller, { title: 'Key one', priceCents: 10_00, deliveryMode: 'manual', stock: 5 });
    await makeOffer(seller, { title: '=HYPERLINK("x")', priceCents: 5_00, deliveryMode: 'manual', stock: 1 });

    const exp = await seller.api.get('/v1/seller/listings/export.csv');
    expect(exp.headers['content-type']).toMatch(/text\/csv/);
    const [header, ...rows] = parseCsv(exp.body);
    expect(header).toEqual(['id', 'game', 'category', 'title', 'description', 'price', 'currency', 'delivery', 'stock', 'delivery_hours', 'status', 'attributes', 'warranty_days']);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slice(0, 9)).toEqual([a.id, 'Test Game', 'keys', 'Key one', '', '10.00', 'USD', 'manual', '5']);
    expect(rows[1]![3]).toBe(`'=HYPERLINK("x")`); // formula neutralised in the export…

    // Edit: new price and stock on one row, a new listing, and some bad rows.
    rows[0]![5] = '12.50';
    rows[0]![8] = '9';
    const edited = csvOf([
      header!,
      ...rows,
      ['', 'Valorant', 'accounts', 'Immortal account, 40 skins', '', '150', 'USD', 'manual', '', '', 'active', 'region=Europe', '30'],
      ['', 'Test Game', 'nonsense', 'Bad category', '', '5', '', 'instant', '', '', '', '', ''],
      ['', 'Test Game', 'keys', 'Contact me on telegram', '', '5', '', 'instant', '', '', '', '', ''],
      ['not-mine', '', '', 'Not mine', '', '5', '', '', '', '', '', '', ''],
    ]);
    const preview = await seller.api.post('/v1/seller/listings/import', { csv: edited, dryRun: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.summary, JSON.stringify(preview.body.rows)).toEqual({ create: 2, update: 1, unchanged: 1, error: 2 });
    const byRow = Object.fromEntries(preview.body.rows.map((r: any) => [r.row, r]));
    expect(byRow[1]).toMatchObject({ action: 'update', changes: ['price', 'stock'] });
    expect(byRow[2]).toMatchObject({ action: 'unchanged' }); // …and read back unchanged
    expect(byRow[4].error).toMatch(/Unknown category/);
    expect(byRow[5]).toMatchObject({ action: 'create', review: true }); // contact details: held for review
    expect(byRow[6].error).toMatch(/No listing of yours/);
    // A preview writes nothing.
    expect((await seller.api.get(`/v1/offers/${a.id}`)).body.seller_price_cents).toBe(10_00); // seller-only (Round 23e)

    const applied = await seller.api.post('/v1/seller/listings/import', { csv: edited, dryRun: false });
    expect(applied.body.summary).toEqual({ create: 2, update: 1, unchanged: 1, error: 2 });
    const updated = (await seller.api.get(`/v1/offers/${a.id}`)).body; // seller_price_cents is the seller's (Round 23e)
    expect([updated.seller_price_cents, updated.price_cents, updated.stock]).toEqual([12_50, 13_16, 9]); // buyers see the grossed-up price
    const created = (await seller.api.get('/v1/seller/offers')).body;
    expect(created.find((o: any) => o.title === 'Immortal account, 40 skins')).toMatchObject({ warranty_days: 30, status: 'active' });
    expect(created.find((o: any) => o.title === 'Contact me on telegram')).toMatchObject({ status: 'review' });
  });

  it('refuses changes that would rewrite a listing, and other sellers’ ids', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const other = await makeUser(h, { tier: 2 });
    const a = await makeOffer(seller, { title: 'Mine', deliveryMode: 'manual', stock: 1 });
    const b = await makeOffer(other, { title: 'Theirs', deliveryMode: 'manual', stock: 1 });
    const res = await seller.api.post('/v1/seller/listings/import', {
      csv: csvOf([
        ['id', 'game', 'price', 'warranty_days'],
        [a.id, 'Another Game', '5', ''],
        [a.id, '', '5', '30'],
        [b.id, '', '1', ''],
      ]),
      dryRun: true,
    });
    expect(res.body.rows.map((r: any) => r.error)).toEqual([
      expect.stringMatching(/game of an existing listing can’t change/),
      'This id appears twice in the file',
      'No listing of yours with this id',
    ]);
    const buyer = await makeUser(h);
    expect((await buyer.api.post('/v1/seller/listings/import', { csv: 'id\n', dryRun: true })).status).toBe(403);
  });
});
