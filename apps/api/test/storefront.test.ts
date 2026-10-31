import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EicarOnlyScanner } from '../src/providers/files.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-shop-')) });
});
afterAll(async () => h.close());

const photo = (w = 2400, hgt = 1200) =>
  sharp({ create: { width: w, height: hgt, channels: 3, background: '#2a78d6' } }).withMetadata({ exif: { IFD0: { Copyright: 'secret-gps' } } }).jpeg().toBuffer();

describe('seller storefront', () => {
  it('saves a screened intro, an accent and pinned listings, shown on the public shop page', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const other = await makeUser(h, { tier: 2 });
    const a = await makeOffer(seller, { title: 'Pinned one', deliveryMode: 'manual', stock: 3 });
    const b = await makeOffer(seller, { title: 'Pinned two', deliveryMode: 'manual', stock: 3 });
    const theirs = await makeOffer(other, { deliveryMode: 'manual', stock: 3 });

    expect((await seller.api.put('/v1/seller/storefront', { intro: 'Fast delivery! Add me on discord for discounts' })).body.error.code).toBe('contact_details');
    expect((await seller.api.put('/v1/seller/storefront', { pinned: [a.id, theirs.id] })).body.error.code).toBe('invalid_pinned');
    expect((await seller.api.put('/v1/seller/storefront', { accent: 'neon' })).status).toBe(400);

    const saved = await seller.api.put('/v1/seller/storefront', { intro: 'Keys and gift cards since 2019. Most orders deliver in minutes.', accent: 'teal', pinned: [b.id, a.id] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const shop = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body.storefront;
    expect(shop).toMatchObject({ intro: 'Keys and gift cards since 2019. Most orders deliver in minutes.', accent: 'teal', banner_url: null });
    expect(shop.pinned.map((o: any) => o.title)).toEqual(['Pinned two', 'Pinned one']);

    // A paused listing drops out of the pins on its own.
    const v = (await client(h.app).get(`/v1/offers/${b.id}`)).body.version;
    await seller.api.patch(`/v1/offers/${b.id}`, { version: v, status: 'paused' });
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.storefront.pinned.map((o: any) => o.title)).toEqual(['Pinned one']);

    // Buyers can't set a storefront.
    const buyer = await makeUser(h);
    expect((await buyer.api.put('/v1/seller/storefront', { intro: 'hi there' })).status).toBe(403);
  });

  it('crops, re-encodes and serves the banner; blocks malware; staff can clear it', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const up = await seller.api.post('/v1/seller/storefront/banner', await photo(), { 'content-type': 'image/jpeg' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.banner_url).toMatch(new RegExp(`^/v1/sellers/${seller.id}/banner\\?v=[0-9a-f]{12}$`));

    const res = await h.app.inject({ method: 'GET', url: up.body.banner_url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1500, 400, 'webp']);
    expect(meta.exif).toBeUndefined(); // metadata stripped

    // Changing it again right away is rate-limited.
    expect((await seller.api.post('/v1/seller/storefront/banner', await photo(), { 'content-type': 'image/jpeg' })).status).toBe(429);

    // Malware is refused and flags the uploader.
    const other = await makeUser(h, { tier: 2 });
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).png().toBuffer();
    const bad = await other.api.post('/v1/seller/storefront/banner', Buffer.concat([png, Buffer.from(EicarOnlyScanner.EICAR)]), { 'content-type': 'image/png' });
    expect(bad.body.error.code).toBe('malware_detected');
    expect((await h.ctx.db.query(`SELECT 1 FROM risk_flags WHERE user_id = $1`, [other.id])).rowCount).toBe(1);

    // Staff (moderation.manage) can remove it; the action is audited.
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    expect((await seller.api.post(`/v1/admin/sellers/${seller.id}/storefront/clear`, { banner: true, note: 'nope' })).status).toBe(403);
    expect((await admin.api.post(`/v1/admin/sellers/${seller.id}/storefront/clear`, { banner: true, note: 'Offensive image' })).status).toBe(200);
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.storefront.banner_url).toBeNull();
    expect((await h.app.inject({ method: 'GET', url: `/v1/sellers/${seller.id}/banner` })).statusCode).toBe(404);
    expect((await h.ctx.db.query(`SELECT 1 FROM admin_audit_log WHERE action = 'storefront.clear'`)).rowCount).toBe(1);
  });
});
