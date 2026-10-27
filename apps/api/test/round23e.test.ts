import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as attachments from '../src/domain/attachments.js';
import { shredUserChatKey } from '../src/domain/chatkeys.js';
import { withTx } from '../src/db.js';
import { accountId, post } from '../src/domain/ledger.js';
import * as privacy from '../src/domain/privacy.js';
import { runRetention } from '../src/domain/retention.js';
import { deepRedact } from '../src/observability.js';
import type { FileStorage } from '../src/providers/files.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/**
 * Round 23e (`claude/round-23e-fixes.md`): one test per item, each written to fail on 0123a8c and pass now.
 */
let h: Harness;
beforeAll(async () => {
  h = await setup({ VIDEO_METADATA_STRIP: 'ffmpeg', STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-23e-')) });
});
afterAll(async () => {
  await h.close();
});

const PASSWORD = 'correct horse battery';
const jpeg = () => sharp({ create: { width: 24, height: 24, channels: 3, background: '#123' } }).jpeg().toBuffer();

async function orderRoom(categorySlug = 'currency') {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h);
  const offer = await makeOffer(seller, { categorySlug, deliveryMode: 'manual', stock: 5 });
  const order = await buyAndPay(h, buyer, offer.id);
  const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  return { seller, buyer, offer, order, room };
}

/** A real MP4 (re-muxable by ffmpeg); `extra` adds ffmpeg arguments before the output (e.g. a subtitle track). */
function makeMp4(extra: string[] = [], inputs: string[] = [], seconds = 0.3) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bz-23e-mp4-'));
  const f = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=64x64:d=${seconds}`, ...inputs, ...extra, f]);
  return { dir, file: f, bytes: readFileSync(f) };
}

/** The same store, with one method replaced (the local store is a class: its methods live on the prototype). */
function storageWith(over: Partial<FileStorage>): FileStorage {
  return Object.assign(Object.create(h.ctx.storage), over);
}

describe('Round 23e', () => {
  it('1. chat erasure clears what points at the files (boosting progress screenshot), in one transaction; objects are deleted after commit through a retry queue; retention resumes per user', async () => {
    const { seller, order, room } = await orderRoom('boosting');
    const shot = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, await jpeg(), { 'content-type': 'image/jpeg', 'x-filename': 'progress.jpg' });
    expect(shot.status).toBe(201);
    const progress = await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 40, note: 'halfway', attachmentId: shot.body.id });
    expect(progress.status, JSON.stringify(progress.body)).toBe(201);
    const key = (await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [shot.body.id])).rows[0].storage_key as string;
    await expect(h.ctx.storage.get(key)).resolves.toBeTruthy();

    const admin = await makeUser(h, { role: 'admin' });
    const erased = await admin.api.post(`/v1/admin/users/${seller.id}/erase-chat`, { reason: 'erasure request' });
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    expect(erased.body.files).toBe(1);
    expect((await h.ctx.db.query('SELECT 1 FROM chat_attachments WHERE id = $1', [shot.body.id])).rowCount).toBe(0);
    expect((await h.ctx.db.query('SELECT attachment_id, percent FROM order_progress WHERE order_id = $1', [order.id])).rows[0]).toEqual({ attachment_id: null, percent: 40 });
    await expect(h.ctx.storage.get(key)).rejects.toThrow();
    expect((await h.ctx.db.query('SELECT 1 FROM storage_deletions WHERE storage_key = $1', [key])).rowCount).toBe(0);
    // The order page still works (no dangling reference).
    expect((await seller.api.get(`/v1/orders/${order.id}`)).status).toBe(200);

    // Storage down at erasure time: the rows still go, the key stays queued and is deleted on a later run.
    const b = await orderRoom('boosting');
    const shot2 = await b.seller.api.post(`/v1/chat/rooms/${b.room}/attachments`, await jpeg(), { 'content-type': 'image/jpeg', 'x-filename': 'p2.jpg' });
    const key2 = (await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [shot2.body.id])).rows[0].storage_key as string;
    const down = { ...h.ctx, storage: storageWith({ delete: async () => { throw new Error('storage unavailable'); } }) } as typeof h.ctx;
    const r = await privacy.eraseUserChat(down, b.seller.id, 'erasure request');
    expect(r).toEqual({ shredded: true, files: 1 });
    expect((await h.ctx.db.query('SELECT 1 FROM chat_attachments WHERE id = $1', [shot2.body.id])).rowCount).toBe(0);
    const queued = (await h.ctx.db.query('SELECT attempts FROM storage_deletions WHERE storage_key = $1', [key2])).rows[0];
    expect(queued.attempts).toBe(1);
    await h.ctx.db.query(`UPDATE storage_deletions SET next_at = now() WHERE storage_key = $1`, [key2]);
    await runRetention(h.ctx);
    await expect(h.ctx.storage.get(key2)).rejects.toThrow();
    expect((await h.ctx.db.query('SELECT 1 FROM storage_deletions WHERE storage_key = $1', [key2])).rowCount).toBe(0);

    // Resumable: a deleted user whose key was shredded but whose files survived (the 23d failure) is picked up again.
    const c = await orderRoom('boosting');
    const shot3 = await c.seller.api.post(`/v1/chat/rooms/${c.room}/attachments`, await jpeg(), { 'content-type': 'image/jpeg', 'x-filename': 'p3.jpg' });
    await c.seller.api.post(`/v1/orders/${c.order.id}/progress`, { percent: 10, note: '', attachmentId: shot3.body.id });
    await shredUserChatKey(h.ctx.db, c.seller.id, 'earlier run');
    await h.ctx.db.query(`UPDATE users SET deleted_at = now() - interval '600 days' WHERE id = $1`, [c.seller.id]);
    const run = await runRetention(h.ctx);
    expect(run.counts.chatErasureErrors).toBe(0);
    expect((await h.ctx.db.query('SELECT 1 FROM chat_attachments WHERE uploader_id = $1', [c.seller.id])).rowCount).toBe(0);
  });

  it('2. account deletion is refused while any credit or seller balance in any currency is above zero', async () => {
    const buyer = await makeUser(h);
    await withTx(h.ctx.db, async (tx) => {
      await post(tx, [{ account: await accountId(tx, 'treasury', 'EUR'), amountCents: -3_00 }, { account: await accountId(tx, 'user_credit', 'EUR', buyer.id), amountCents: 3_00 }], 'test_credit_eur');
    });
    const del = await buyer.api.post('/v1/me/delete', { password: PASSWORD });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('credit_remaining');
    expect((await h.ctx.db.query('SELECT deleted_at FROM users WHERE id = $1', [buyer.id])).rows[0].deleted_at).toBeNull();
    // Seller balance in EGP blocks it too.
    const seller = await makeUser(h, { tier: 2 });
    await withTx(h.ctx.db, async (tx) => {
      await post(tx, [{ account: await accountId(tx, 'treasury', 'EGP'), amountCents: -50_00 }, { account: await accountId(tx, 'seller_available', 'EGP', seller.id), amountCents: 50_00 }], 'test_balance_egp');
    });
    expect((await seller.api.post('/v1/me/delete', { password: PASSWORD })).body.error.code).toBe('balance_remaining');
    // Spent: deletion goes through.
    await withTx(h.ctx.db, async (tx) => {
      await post(tx, [{ account: await accountId(tx, 'treasury', 'EUR'), amountCents: 3_00 }, { account: await accountId(tx, 'user_credit', 'EUR', buyer.id), amountCents: -3_00 }], 'test_credit_eur_out');
    });
    expect((await buyer.api.post('/v1/me/delete', { password: PASSWORD })).status).toBe(200);
  });

  it('3. the rank rule holds on every status path (risk flag, chat flag, reinstate); a suspension signs the account out at once', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const compliance = await makeUser(h, { role: 'compliance' });
    const support = await makeUser(h, { role: 'support' });
    const finance = await makeUser(h, { role: 'finance' });
    // Risk flag on an admin: compliance cannot confirm it (it bans).
    const flag = (await h.ctx.db.query(`INSERT INTO risk_flags (user_id, score, reasons) VALUES ($1, 0.95, '[]') RETURNING id`, [admin.id])).rows[0].id;
    const confirm = await compliance.api.post(`/v1/admin/risk-flags/${flag}/review`, { decision: 'confirm' });
    expect(confirm.status).toBe(403);
    expect(confirm.body.error.code).toBe('rank');
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [admin.id])).rows[0].status).toBe('active');
    // Chat flag on finance (penalty ladder set to ban): support cannot confirm it.
    const { room } = await orderRoom();
    await h.ctx.db.query(`UPDATE moderation_settings SET offplatform_actions = '{ban}'`);
    try {
      const cf = (await h.ctx.db.query(`INSERT INTO chat_flags (room_id, seq, user_id, reasons) VALUES ($1, 9999, $2, '{phone}') RETURNING id`, [room, finance.id])).rows[0].id;
      const res = await support.api.post(`/v1/admin/moderation/chats/${cf}`, { confirm: true });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('rank');
      expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [finance.id])).rows[0].status).toBe('active');
    } finally {
      await h.ctx.db.query(`UPDATE moderation_settings SET offplatform_actions = '{warn,warn,ban}'`);
    }
    // Reinstating is a status change too: a lead cannot lift an admin-imposed ban on finance.
    const lead = await makeUser(h, { role: 'lead' });
    expect((await admin.api.post(`/v1/admin/users/${finance.id}/ban`, { reason: 'test ban' })).status).toBe(200);
    expect((await lead.api.post(`/v1/admin/users/${finance.id}/reinstate`, { note: 'lift it' })).body.error.code).toBe('rank');
    // Suspension: the existing session stops working at once.
    const user = await makeUser(h);
    expect((await user.api.get('/v1/me')).status).toBe(200);
    expect((await admin.api.post(`/v1/admin/users/${user.id}/suspend`, { reason: 'under review', days: 2 })).status).toBe(200);
    expect((await user.api.get('/v1/me')).status).toBe(401);
  });

  it('4. the seller never sees the buyer refund wallet, who released the money and why, or the tax country', async () => {
    const { seller, buyer, order } = await orderRoom();
    await h.ctx.db.query(`UPDATE orders SET payment_provider = 'nowpayments', released_by = $2, release_note = 'checked by staff', tax_country = 'DE' WHERE id = $1`, [order.id, (await makeUser(h, { role: 'admin' })).id]);
    await h.ctx.db.query(`INSERT INTO crypto_refunds (order_id, amount_cents, currency, reason, refund_address, refund_currency, status) VALUES ($1, 500, 'USD', 'test', 'TBuyerWallet23e', 'usdttrc20', 'pending')`, [order.id]);
    const sellerView = (await seller.api.get(`/v1/orders/${order.id}`)).body;
    expect(JSON.stringify(sellerView)).not.toContain('TBuyerWallet23e');
    for (const k of ['released_by', 'release_note', 'tax_country']) expect(sellerView).not.toHaveProperty(k);
    const buyerView = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(buyerView.crypto_refund.refund_address).toBe('TBuyerWallet23e');
    const staff = await makeUser(h, { role: 'admin' });
    const staffView = (await staff.api.get(`/v1/orders/${order.id}`)).body;
    expect(staffView.release_note).toBe('checked by staff');
    expect(staffView.crypto_refund.refund_address).toBe('TBuyerWallet23e');
  });

  it('5. proof videos lose subtitle and data tracks (DJI-style GPS); ffmpeg runs under resource limits', async () => {
    const { seller, buyer, room } = await orderRoom();
    const dir = mkdtempSync(path.join(tmpdir(), 'bz-23e-dji-'));
    const srt = path.join(dir, 'gps.srt');
    writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,200\nF/2.8 ISO 100 GPS (31.235712, 30.044420, 23) H 5m\n');
    const video = makeMp4(['-map', '0', '-map', '1', '-c:v', 'libx264', '-c:s', 'mov_text'], ['-i', srt]);
    const streams = (f: string) => execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', f]).toString().trim().split('\n');
    expect(streams(video.file)).toContain('subtitle');
    expect(video.bytes.includes('31.235712')).toBe(true);
    const res = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, video.bytes, { 'content-type': 'video/mp4', 'x-filename': 'dji.mp4' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const got = await h.app.inject({ method: 'GET', url: `/v1/chat/attachments/${res.body.id}`, headers: { authorization: `Bearer ${buyer.token}` } });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.includes('31.235712')).toBe(false);
    const stored = path.join(dir, 'stored.mp4');
    writeFileSync(stored, got.rawPayload);
    expect(streams(stored)).toEqual(['video']);
    // Limits are applied: with a memory cap far too small, ffmpeg cannot start and the upload is refused (fail closed).
    const saved = { ...attachments.ffmpegLimits };
    attachments.ffmpegLimits.memoryKb = 4096;
    try {
      const refused = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, video.bytes, { 'content-type': 'video/mp4', 'x-filename': 'dji2.mp4' });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('video_not_processable');
    } finally {
      Object.assign(attachments.ffmpegLimits, saved);
    }
  });

  it('6. a video view streams from storage verified chunk by chunk: no spool against the upload budget, bad chunks never delivered, a per-user stream limit', async () => {
    const { seller, buyer, room } = await orderRoom();
    const limits = (attachments as any).downloadLimits ?? { chunkBytes: 0 }; // (absent before Round 23e)
    const savedChunk = limits.chunkBytes;
    limits.chunkBytes = 1024; // small chunks, so a tiny test video has several
    let id: string;
    try {
      const video = makeMp4([], [], 1);
      const res = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, video.bytes, { 'content-type': 'video/mp4', 'x-filename': 'proof.mp4' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      id = res.body.id;
    } finally {
      limits.chunkBytes = savedChunk;
    }
    const row = (await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [id])).rows[0];
    const original = await h.ctx.storage.get(row.storage_key);
    const viewer = { id: buyer.id, role: 'user' };

    // A slow store (two chunks, then nothing for a while): the view starts without claiming upload temp space.
    const before = attachments.spoolReservedBytes();
    const dirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('bz-upload-')).length;
    const dirsBefore = dirs();
    const slow = new Readable({ read() {} });
    slow.push(original.subarray(0, 2048));
    const stalled = { ...h.ctx, storage: storageWith({ getStream: async () => slow }) } as typeof h.ctx;
    const opened = attachments.openAttachment(stalled, id, viewer);
    await new Promise((r) => setTimeout(r, 300));
    expect(attachments.spoolReservedBytes()).toBe(before);
    expect(dirs()).toBe(dirsBefore);
    const view = await opened;
    const first = await new Promise<Buffer>((resolve) => view.stream.once('data', resolve));
    expect(first.equals(original.subarray(0, 1024))).toBe(true);
    view.stream.destroy();
    slow.destroy();
    const chunks = (await h.ctx.db.query('SELECT chunk_bytes, array_length(chunk_sha256, 1) AS n FROM chat_attachments WHERE id = $1', [id])).rows[0];
    expect(chunks.chunk_bytes).toBe(1024);
    expect(chunks.n).toBeGreaterThan(3);

    // The whole file through the API matches its hash.
    const got = await h.app.inject({ method: 'GET', url: `/v1/chat/attachments/${id}`, headers: { authorization: `Bearer ${buyer.token}` } });
    expect(got.statusCode).toBe(200);
    expect(createHash('sha256').update(got.rawPayload).digest('hex')).toBe(got.headers['x-content-sha256']);

    // Tampered third chunk: the first two (verified) arrive, the bad one never does, the stream ends in an error.
    const bad = Buffer.from(original);
    bad[2048 + 10] ^= 1;
    // Delivered in pieces with a pause between them, as a real store does.
    const pieces = async function* () {
      for (let off = 0; off < bad.length; off += 512) {
        await new Promise((r) => setTimeout(r, 5));
        yield bad.subarray(off, off + 512);
      }
    };
    const tampered = { ...h.ctx, storage: storageWith({ getStream: async () => Readable.from(pieces()) }) } as typeof h.ctx;
    const t = await attachments.openAttachment(tampered, id, viewer);
    const parts: Buffer[] = [];
    const err = await new Promise<Error | null>((resolve) => {
      t.stream.on('data', (d: Buffer) => parts.push(d));
      t.stream.once('error', resolve);
      t.stream.once('end', () => resolve(null));
    });
    expect(err?.message).toMatch(/integrity/);
    expect(Buffer.concat(parts).equals(original.subarray(0, 2048))).toBe(true);
    // Tampered first chunk: a clean 500 before any byte.
    const bad0 = Buffer.from(original);
    bad0[5] ^= 1;
    const tampered0 = { ...h.ctx, storage: storageWith({ getStream: async () => Readable.from([bad0]) }) } as typeof h.ctx;
    await expect(attachments.openAttachment(tampered0, id, viewer)).rejects.toMatchObject({ status: 500, code: 'integrity_error' });

    // Per user: a few streams at a time.
    const open: Array<{ stream: Readable }> = [];
    const hanging = () => ({ ...h.ctx, storage: storageWith({ getStream: async () => { const r = new Readable({ read() {} }); r.push(original.subarray(0, 1024)); return r; } }) }) as typeof h.ctx;
    for (let i = 0; i < attachments.downloadLimits.perUser; i++) open.push(await attachments.openAttachment(hanging(), id, viewer));
    await expect(attachments.openAttachment(hanging(), id, viewer)).rejects.toMatchObject({ status: 429, code: 'downloads_busy' });
    for (const o of open) o.stream.destroy();
    await new Promise((r) => setTimeout(r, 20));
    const again = await attachments.openAttachment(hanging(), id, viewer);
    again.stream.destroy();
  });

  it('7. seller-only prices (what the seller entered, the seller net, commission) reach only the seller and staff', async () => {
    const { seller, buyer, offer, order } = await orderRoom();
    const pub = (await buyer.api.get(`/v1/offers/${offer.id}`)).body;
    expect(pub.price_cents).toBeGreaterThan(0);
    expect(pub).not.toHaveProperty('seller_price_cents');
    expect(pub).not.toHaveProperty('seller_price_tiers');
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body).not.toHaveProperty('seller_price_cents');
    expect((await seller.api.get(`/v1/offers/${offer.id}`)).body.seller_price_cents).toBe(10_00);
    const buyerOrder = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    for (const k of ['commission_cents', 'seller_net_cents', 'commission_bps']) expect(buyerOrder).not.toHaveProperty(k);
    expect((await seller.api.get(`/v1/orders/${order.id}`)).body.seller_net_cents).toBeGreaterThan(0);
  });

  it('8. opting out keeps the original consent time and records the opt-out apart', async () => {
    const u = await makeUser(h);
    expect((await u.api.put('/v1/me/newsletter', { optIn: true })).status).toBe(200);
    await h.ctx.db.query(`UPDATE users SET news_opt_in_at = '2026-01-02T03:04:05Z' WHERE id = $1`, [u.id]);
    const out = await u.api.put('/v1/me/newsletter', { optIn: false });
    expect(out.status).toBe(200);
    const row = (await h.ctx.db.query('SELECT news_opt_in, news_opt_in_at, news_opt_out_at FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row.news_opt_in).toBe(false);
    expect(new Date(row.news_opt_in_at).toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(row.news_opt_out_at).not.toBeNull();
  });

  it('9. an order must carry the Terms version the buyer saw: missing is refused, stale is refused', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { stock: 5 });
    const missing = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, tosVersion: undefined });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('tos_version_required');
    const stale = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, tosVersion: '1999-01-01' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('terms_stale');
    const cart = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: offer.id, quantity: 1 }], acceptTos: true, tosVersion: undefined });
    expect(cart.body.error.code).toBe('tos_version_required');
    // The web app sends the version loaded with the page, not one fetched at click time.
    const repo = (p: string) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');
    for (const page of ['pages/OfferPage.tsx', 'pages/Cart.tsx']) {
      expect(repo(page)).not.toMatch(/await api<\{ version: string \}>\('\/legal\/terms'\)/);
      expect(repo(page)).toMatch(/useTermsVersion\(\)/);
    }
  });

  it('10. a wrong password or code on delete / 2FA-off is 403 (not 401, which the web client refreshes and retries)', async () => {
    const u = await makeUser(h);
    const del = await u.api.post('/v1/me/delete', { password: 'wrong password' });
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('invalid_credentials');
    const { currentStep, totpAt } = await import('../src/domain/mfa.js');
    const secret: string = (await u.api.post('/v1/me/2fa/setup')).body.secret;
    expect((await u.api.post('/v1/me/2fa/enable', { code: totpAt(secret, currentStep()) })).status).toBe(200);
    const off = await u.api.post('/v1/me/2fa/disable', { code: '000000' });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('invalid_credentials');
    expect((await h.ctx.db.query('SELECT failed_logins FROM users WHERE id = $1', [u.id])).rows[0].failed_logins).toBe(2); // each mistake counted once
  });

  it('11. web session: the legacy stored token is removed and counts as signed in; a 409 refresh race is retried, not signed out', async () => {
    const store = new Map<string, string>([['mkt.token', 'legacy-access-token']]);
    const g = globalThis as any;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: g.fetch };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
    g.window = { dispatchEvent: () => true };
    const replies = [409, 409, 200];
    let calls = 0;
    g.fetch = async () => {
      const status = replies[Math.min(calls++, replies.length - 1)]!;
      return new Response(status === 200 ? JSON.stringify({ token: 'fresh-token' }) : JSON.stringify({ error: { code: 'refresh_superseded' } }), { status });
    };
    try {
      const web = await import('../../web/src/api.ts');
      expect(store.has('mkt.token')).toBe(false); // removed on load
      expect(web.session.maybeSignedIn).toBe(true); // that browser was signed in: exchange the cookie
      const [a, b] = await Promise.all([web.refreshAccessToken(), web.refreshAccessToken()]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(calls).toBe(3); // one shared refresh, retried through two races
      expect(web.session.token).toBe('fresh-token');
      expect(store.get('mkt.signed-in')).toBe('1');
    } finally {
      Object.assign(g, saved);
    }
  });

  it('12. staff polling a chat over REST is audited once per session and room, not once per poll', async () => {
    const { buyer, room } = await orderRoom();
    await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'hello' });
    const support = await makeUser(h, { role: 'support' });
    const count = async () => Number((await h.ctx.db.query(`SELECT count(*)::int AS n FROM admin_audit_log WHERE actor_id = $1 AND action = 'chat.viewed' AND target_id = $2`, [support.id, room])).rows[0].n);
    expect((await support.api.get(`/v1/chat/rooms/${room}/messages`)).status).toBe(200); // full read: always on the record
    for (let i = 0; i < 6; i++) expect((await support.api.get(`/v1/chat/rooms/${room}/messages?afterSeq=1`)).status).toBe(200);
    expect(await count()).toBe(2);
    // A new session polls: one more row.
    const login = await client(h.app).post('/v1/auth/login', { email: support.email, password: PASSWORD });
    for (let i = 0; i < 3; i++) await client(h.app, login.body.token).get(`/v1/chat/rooms/${room}/messages?afterSeq=1`);
    expect(await count()).toBe(3);
  });

  it('13. logs redact secret codes (OTP, OAuth) but keep error codes', () => {
    const out = deepRedact({
      err: { code: 'ECONNREFUSED', message: 'down' },
      error: { code: 'invalid_code' },
      pg: { code: '23505' },
      req: { body: { email: 'a@b.c', code: '123456' }, query: { code: 'oauth-code', state: 's' } },
      otpCode: '654321',
    }) as any;
    expect(out.err.code).toBe('ECONNREFUSED');
    expect(out.error.code).toBe('invalid_code');
    expect(out.pg.code).toBe('23505');
    expect(out.req.body.code).toBe('[redacted]');
    expect(out.req.body.email).toBe('a@b.c');
    expect(out.req.query.code).toBe('[redacted]');
    expect(out.req.query.state).toBe('[redacted]');
    expect(out.otpCode).toBe('[redacted]');
  });
});
