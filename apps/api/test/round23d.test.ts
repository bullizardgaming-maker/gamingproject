import { readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import type { FileStorage } from '../src/providers/files.js';
import { buildApp } from '../src/server.js';
import { spoolLimits, spoolReservedBytes } from '../src/domain/attachments.js';
import { forgetNewsletterContact, pullBrevoUnsubscribes, syncNewsletter } from '../src/domain/newsletter.js';
import { currentStep, totpAt } from '../src/domain/mfa.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { loadConfig } from '../src/config.js';
import { deepRedact, redactUrl } from '../src/observability.js';
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
import { readdirSync } from 'node:fs';
import { request } from 'node:http';
import { withTx } from '../src/db.js';
import { accountId, post } from '../src/domain/ledger.js';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { WebSocket } from 'ws';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child: () => silent } as any;

async function orderRoom() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h);
  const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
  const order = await buyAndPay(h, buyer, offer.id);
  const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  return { seller, buyer, room };
}

/** In-memory object store with a presigned PUT, like the Round 23a test. */
function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage: FileStorage = {
    put: async (k, b) => void objects.set(k, b),
    get: async (k) => {
      const b = objects.get(k);
      if (!b) throw new Error('NoSuchKey');
      return b;
    },
    delete: async (k) => void objects.delete(k),
    rekey: async () => null,
    keyVersion: null,
    putFile: async (k, file) => void objects.set(k, readFileSync(file)),
    getStream: async (k) => {
      const b = objects.get(k);
      if (!b) throw new Error('NoSuchKey');
      return Readable.from([b]);
    },
    presignPut: async (key, contentType) => ({ url: `https://bucket.test/${key}`, headers: { 'Content-Type': contentType } }),
  };
  return { objects, storage };
}
/** A real HTTP upload with a streamed body, so the server sees bytes arrive (or stop arriving). */
function postStream(token: string, room: string, body: Readable, size: number): Promise<{ status: number; body: any }> {
  const url = wsUrl.replace('ws://', 'http://').replace('/v1/ws', `/v1/chat/rooms/${room}/attachments`);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4', 'content-length': String(size), 'x-filename': 'trade.mp4' } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(parts).toString() || '{}') }));
    });
    req.on('error', reject);
    body.pipe(req);
  });
}
/** A body that sends its first bytes and then goes quiet (a client that stalls, or an attacker holding the slot). */
function stallingStream(size: number) {
  const head = Buffer.alloc(1024);
  head.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
  const r = new Readable({ read() {} });
  r.push(head);
  return { stream: r, size, finish: () => r.destroy() };
}
const spoolDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('bz-upload-')).length;

/** A real (tiny) MP4 made by ffmpeg, so the re-mux step accepts it. */
function realMp4(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'bz-mp4-'));
  const f = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.3', f]);
  return readFileSync(f);
}
const mp4 = (size: number) => {
  const b = Buffer.alloc(size);
  b.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
  return b;
};

let h: Harness;
let wsUrl: string;
beforeAll(async () => {
  h = await setup({ VIDEO_METADATA_STRIP: 'ffmpeg', STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-23d-')) });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/v1/ws`;
});

/** Open a socket, authenticate, and return a one-shot waiter for frames. */
function connect(token: string): Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
      else inbox.push(m);
    });
    const next = (pred: (m: any) => boolean) =>
      new Promise<any>((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        waiters.push({ pred, resolve: res });
        setTimeout(() => rej(new Error('timeout waiting for ws frame')), 5_000);
      });
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      try {
        await next((m) => m.type === 'ready');
        resolve({ ws, next });
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', reject);
  });
}
afterAll(async () => {
  h.app.server.closeAllConnections?.(); // the stalled-upload sockets of test 8
  await h.close();
});

const STAFF_ONLY = ['buyer_ip', 'buyer_ip_country', 'buyer_device', 'risk_score'];
const BUYER_ONLY = ['payment_ref', 'idempotency_key'];

describe('Round 23d', () => {
  it('1. sellers and buyers never see the buyer device, IP, risk score or payment plumbing; staff do', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { device: 'dev-23d', ip: '203.0.113.9' });
    const offer = await makeOffer(seller, { title: 'Leak check', priceCents: 10_00, deliveryMode: 'manual', stock: 3 });
    const order = await buyAndPay(h, buyer, offer.id);
    await h.ctx.db.query(`UPDATE orders SET risk_score = 0.42, buyer_ip = '203.0.113.9', buyer_device = 'dev-23d' WHERE id = $1`, [order.id]);

    for (const [who, api] of [['seller', seller.api], ['buyer', buyer.api]] as const) {
      const hidden = who === 'seller' ? [...STAFF_ONLY, ...BUYER_ONLY] : STAFF_ONLY;
      const one = await api.get(`/v1/orders/${order.id}`);
      expect(one.status, who).toBe(200);
      for (const k of hidden) expect(one.body, `${who} sees ${k}`).not.toHaveProperty(k);
      const list = await api.get(`/v1/orders?as=${who}`);
      expect(list.status).toBe(200);
      const row = list.body.find((o: any) => o.id === order.id);
      expect(row).toBeTruthy();
      for (const k of hidden) expect(row, `${who} list sees ${k}`).not.toHaveProperty(k);
    }
    // The buyer keeps their own payment reference (the checkout needs it) but never the device/risk columns.
    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.order.payment_ref).toBeTruthy();
    for (const k of STAFF_ONLY) expect(created.body.order).not.toHaveProperty(k);

    const support = await makeUser(h, { role: 'support' });
    const staffView = await support.api.get(`/v1/orders/${order.id}`);
    expect(staffView.status).toBe(200);
    expect(staffView.body.buyer_device).toBe('dev-23d');
    expect(Number(staffView.body.risk_score)).toBeCloseTo(0.42);
  });

  it('2. a direct upload cannot be swapped after complete, and a tampered stored video is never served', async () => {
    const { objects, storage } = memoryStorage();
    const s3 = await buildApp(createContext(h.ctx.cfg, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), storage }));
    await s3.ready();
    try {
      const { seller, buyer, room } = await orderRoom();
      const api = client(s3, seller.token);
      const video = realMp4();
      const start = await api.post(`/v1/chat/rooms/${room}/attachments/direct`, { fileName: 'trade.mp4', contentType: 'video/mp4', bytes: video.length });
      expect(start.status).toBe(201);
      const uploadKey = new URL(start.body.url).pathname.slice(1);
      objects.set(uploadKey, video);
      const done = await api.post(`/v1/chat/attachments/${start.body.id}/complete`);
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      // The scanned bytes now live under a key the client was never given; the upload key is gone.
      const { storage_key } = (await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [start.body.id])).rows[0];
      expect(storage_key).not.toBe(uploadKey);
      expect(objects.has(uploadKey)).toBe(false);
      // Swap: the presigned PUT is replayed with a same-size file after complete. What is served is unchanged.
      const swapped = mp4(video.length);
      swapped.write('EVIL', 100, 'latin1');
      objects.set(uploadKey, swapped);
      const got = await s3.inject({ method: 'GET', url: `/v1/chat/attachments/${start.body.id}`, headers: { authorization: `Bearer ${buyer.token}` } });
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.includes('EVIL')).toBe(false);
      expect(createHash('sha256').update(got.rawPayload).digest('hex')).toBe(done.body.sha256);
      // Tamper with the stored object itself: no 200 with a body, a clean 500.
      const stored = Buffer.from(objects.get(storage_key)!);
      stored[stored.length - 20] ^= 1;
      objects.set(storage_key, stored);
      const bad = await s3.inject({ method: 'GET', url: `/v1/chat/attachments/${start.body.id}`, headers: { authorization: `Bearer ${buyer.token}` } });
      expect(bad.statusCode).toBe(500);
      expect(bad.json().error.code).toBe('integrity_error');
    } finally {
      await s3.close();
    }
  });

  it('3. suspended or banned staff lose their powers at once; a lead cannot ban an admin', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const lead = await makeUser(h, { role: 'lead' });
    const support = await makeUser(h, { role: 'support' });
    expect((await support.api.get('/v1/admin/support/tickets')).status).not.toBe(403);
    // Suspended: the existing session keeps signing in as them, but staff routes refuse.
    expect((await admin.api.post(`/v1/admin/users/${support.id}/suspend`, { reason: 'under review', days: 3 })).status).toBe(200);
    expect((await support.api.get('/v1/admin/support/tickets')).body.error.code).toBe('account_restricted');
    const login = await client(h.app).post('/v1/auth/login', { email: support.email, password: 'correct horse battery' });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('suspended');
    // Reinstated: back to work, and a refresh token issued now works…
    expect((await admin.api.post(`/v1/admin/users/${support.id}/reinstate`, { note: 'review done' })).status).toBe(200);
    const fresh = await client(h.app).post('/v1/auth/login', { email: support.email, password: 'correct horse battery' });
    expect(fresh.status).toBe(200);
    // …until the account is banned: token, refresh and login all stop.
    expect((await admin.api.post(`/v1/admin/users/${support.id}/ban`, { reason: 'fraud' })).status).toBe(200);
    expect((await client(h.app, fresh.body.token).get('/v1/me')).status).toBe(401);
    expect((await client(h.app).post('/v1/auth/refresh', { refreshToken: fresh.body.refreshToken })).status).toBe(401);
    expect((await client(h.app).post('/v1/auth/login', { email: support.email, password: 'correct horse battery' })).body.error.code).toBe('banned');
    // Rank: a lead cannot suspend or ban an admin or finance, nor themselves; an admin can act on a lead.
    const finance = await makeUser(h, { role: 'finance' });
    expect((await lead.api.post(`/v1/admin/users/${admin.id}/ban`, { reason: 'rank check' })).body.error.code).toBe('rank');
    expect((await lead.api.post(`/v1/admin/users/${finance.id}/suspend`, { reason: 'rank check' })).body.error.code).toBe('rank');
    expect((await lead.api.post(`/v1/admin/users/${lead.id}/suspend`, { reason: 'rank check' })).body.error.code).toBe('rank');
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [admin.id])).rows[0].status).toBe('active');
    expect((await admin.api.post(`/v1/admin/users/${lead.id}/suspend`, { reason: 'rank check', days: 1 })).status).toBe(200);
  });

  it('4. legal documents: only admin/compliance publish, nothing is backdated, in-force versions are frozen in the database', async () => {
    const support = await makeUser(h, { role: 'support' });
    const compliance = await makeUser(h, { role: 'compliance' });
    const body = { title: 'Privacy', contentMd: '# Privacy v9\n\nLonger body text.', material: false };
    expect((await support.api.put('/v1/admin/legal/privacy', { version: '23d-1', ...body })).body.error.code).toBe('insufficient_permission');
    // Backdating is refused even for staff who may publish.
    const past = await compliance.api.put('/v1/admin/legal/privacy', { version: '23d-1', ...body, effectiveAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(past.body.error.code).toBe('backdated');
    expect((await compliance.api.put('/v1/admin/legal/privacy', { version: '23d-1', ...body })).status).toBe(200);
    // In force now (effectiveAt defaulted to now): a translation of that version is a new version…
    expect((await compliance.api.put('/v1/admin/legal/privacy', { version: '23d-1', lang: 'ar', ...body })).body.error.code).toBe('version_in_force');
    // …and the database itself refuses to change or delete it, whoever asks.
    await expect(h.ctx.db.query(`UPDATE legal_documents SET content_md = 'x' WHERE doc = 'privacy' AND version = '23d-1'`)).rejects.toThrow(/in force/);
    await expect(h.ctx.db.query(`DELETE FROM legal_documents WHERE doc = 'privacy' AND version = '23d-1'`)).rejects.toThrow(/in force/);
    // A draft for the future can still be corrected, then is frozen once its date arrives.
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await compliance.api.put('/v1/admin/legal/privacy', { version: '23d-2', ...body, effectiveAt: future })).status).toBe(200);
    expect((await compliance.api.put('/v1/admin/legal/privacy', { version: '23d-2', ...body, contentMd: '# Privacy v9\n\nCorrected body text.', effectiveAt: future })).status).toBe(200);
  });

  it('5. deleting an account keeps no money, address, link, device, search, ticket text or KYC payload; chat erasure drops the files', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 3 });
    const order = await buyAndPay(h, buyer, offer.id);
    const roomId = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
    const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const att = await buyer.api.post(`/v1/chat/rooms/${roomId}/attachments`, jpeg, { 'content-type': 'image/jpeg', 'x-filename': 'proof.jpg' });
    expect(att.status).toBe(201);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);

    // Store credit blocks deletion until it is gone.
    await withTx(h.ctx.db, async (tx) => {
      await post(tx, [{ account: await accountId(tx, 'treasury', 'USD'), amountCents: -2_00 }, { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 2_00 }], 'test_credit');
    });
    expect((await buyer.api.post('/v1/me/delete', { password: 'correct horse battery' })).body.error.code).toBe('credit_remaining');
    await withTx(h.ctx.db, async (tx) => {
      await post(tx, [{ account: await accountId(tx, 'treasury', 'USD'), amountCents: 2_00 }, { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: -2_00 }], 'test_credit_out');
    });

    // Personal data in the satellite tables.
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TXYZ123', payout_address_currency = 'usdttrc20' WHERE id = $1`, [buyer.id]);
    await h.ctx.db.query(`INSERT INTO payout_address_changes (user_id, address, currency, token_hash, expires_at) VALUES ($1, 'TXYZ123', 'usdttrc20', 'h-23d', now() + interval '1 hour')`, [buyer.id]);
    await h.ctx.db.query(`INSERT INTO linked_accounts (user_id, provider, external_id, display_name, profile_url) VALUES ($1, 'steam', '7656119', 'gamer', 'https://steamcommunity.com/id/gamer')`, [buyer.id]);
    await h.ctx.db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example/abc', 'k', 'a')`, [buyer.id]);
    await h.ctx.db.query(`INSERT INTO saved_searches (user_id, name, params, frequency) VALUES ($1, 'cheap keys', '{}', 'daily')`, [buyer.id]);
    await h.ctx.db.query(`INSERT INTO watches (user_id, kind, offer_id, target_cents) VALUES ($1, 'offer', $2, 100)`, [buyer.id, offer.id]);
    await h.ctx.db.query(`INSERT INTO kyc_verifications (user_id, provider, external_id, level, status, result) VALUES ($1, 'sumsub', 'app-23d', 'tier2_individual', 'approved', '{"doc":"passport","number":"X1"}')`, [buyer.id]);
    const ticket = await buyer.api.post('/v1/support/tickets', { category: 'account', subject: 'My address is 1 Main St', body: 'Please call me on 555-0100 about my account.' });
    expect(ticket.status).toBe(201);

    const del = await buyer.api.post('/v1/me/delete', { password: 'correct horse battery' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const q = async (sql: string) => (await h.ctx.db.query(sql, [buyer.id])).rows;
    expect((await q('SELECT payout_address, payout_address_currency FROM users WHERE id = $1'))[0]).toEqual({ payout_address: null, payout_address_currency: null });
    expect((await q('SELECT address FROM payout_address_changes WHERE user_id = $1'))[0].address).toBe('redacted');
    expect((await q('SELECT external_id, display_name, profile_url, unlinked_at FROM linked_accounts WHERE user_id = $1'))[0]).toMatchObject({ display_name: 'redacted', profile_url: null });
    expect((await q('SELECT external_id FROM linked_accounts WHERE user_id = $1'))[0].external_id).not.toBe('7656119');
    expect(await q('SELECT 1 FROM push_subscriptions WHERE user_id = $1')).toHaveLength(0);
    expect(await q('SELECT 1 FROM saved_searches WHERE user_id = $1')).toHaveLength(0);
    expect(await q('SELECT 1 FROM watches WHERE user_id = $1')).toHaveLength(0);
    expect((await q('SELECT subject FROM support_tickets WHERE user_id = $1'))[0].subject).toBe('Deleted user');
    expect((await q('SELECT body FROM support_messages WHERE author_id = $1'))[0].body).not.toMatch(/555-0100/);
    expect((await q('SELECT result, external_id, status FROM kyc_verifications WHERE user_id = $1'))[0]).toEqual({ result: {}, external_id: 'app-23d', status: 'approved' });
    // The provider-side deletion is queued for compliance.
    const admin = await makeUser(h, { role: 'admin' });
    const queue = await admin.api.get('/v1/admin/privacy/kyc-deletions');
    const item = queue.body.find((r: any) => r.user_id === buyer.id);
    expect(item).toMatchObject({ provider: 'sumsub', external_id: 'app-23d' });
    expect((await admin.api.post(`/v1/admin/privacy/kyc-deletions/${item.id}/done`)).status).toBe(200);
    expect((await admin.api.get('/v1/admin/privacy/kyc-deletions')).body.some((r: any) => r.id === item.id)).toBe(false);

    // Chat erasure: the attachment row, its name and the stored object go.
    const { storage_key } = (await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [att.body.id])).rows[0];
    await expect(h.ctx.storage.get(storage_key)).resolves.toBeTruthy();
    const erased = await admin.api.post(`/v1/admin/users/${buyer.id}/erase-chat`, { reason: 'erasure request' });
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    expect(erased.body.files).toBe(1);
    expect((await h.ctx.db.query('SELECT 1 FROM chat_attachments WHERE id = $1', [att.body.id])).rowCount).toBe(0);
    await expect(h.ctx.storage.get(storage_key)).rejects.toThrow();
  });

  it('6. every staff read of a chat they are not part of is audited: WebSocket subscribe/sync and REST at any offset', async () => {
    const { buyer, room } = await orderRoom();
    await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'hello seller' });
    const support = await makeUser(h, { role: 'support' });
    const count = async () => Number((await h.ctx.db.query(`SELECT count(*)::int AS n FROM admin_audit_log WHERE actor_id = $1 AND action = 'chat.viewed' AND target_id = $2`, [support.id, room])).rows[0].n);
    expect(await count()).toBe(0);
    // REST: offset 0 and a later offset both leave a row.
    expect((await support.api.get(`/v1/chat/rooms/${room}/messages`)).status).toBe(200);
    expect((await support.api.get(`/v1/chat/rooms/${room}/messages?afterSeq=1`)).status).toBe(200);
    expect(await count()).toBe(2);
    // WebSocket: subscribe and sync are reads too.
    const s = await connect(support.token);
    s.ws.send(JSON.stringify({ type: 'subscribe', roomId: room }));
    const history = await s.next((m) => m.type === 'history');
    expect(history.messages.length).toBeGreaterThan(0);
    s.ws.send(JSON.stringify({ type: 'sync', roomId: room, afterSeq: 1 }));
    await s.next((m) => m.type === 'history');
    s.ws.close();
    expect(await count()).toBe(4);
    // A participant reading their own chat is not audited.
    const b = await connect(buyer.token);
    b.ws.send(JSON.stringify({ type: 'subscribe', roomId: room }));
    await b.next((m) => m.type === 'history');
    b.ws.close();
    expect(Number((await h.ctx.db.query(`SELECT count(*)::int AS n FROM admin_audit_log WHERE actor_id = $1`, [buyer.id])).rows[0].n)).toBe(0);
  });

  it('7. a proof video loses its metadata (GPS, title) before it is stored; an unreadable video is refused', async () => {
    const { seller, buyer, room } = await orderRoom();
    const dir = mkdtempSync(path.join(tmpdir(), 'bz-gps-'));
    const src = path.join(dir, 'gps.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.3', '-metadata', 'location=+51.5000-000.1200/', '-metadata', 'com.apple.quicktime.location.ISO6709=+51.5000-000.1200/', '-metadata', 'title=home', src]);
    const original = readFileSync(src);
    const tags = (file: string) => execFileSync('ffprobe', ['-v', 'quiet', '-show_format', file]).toString();
    expect(tags(src)).toMatch(/location=\+51\.5000/);
    const res = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, original, { 'content-type': 'video/mp4', 'x-filename': 'proof.mp4' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // What is stored (and served) is the re-muxed file: same video, no location, no title; the hash is the new file's.
    const got = await h.app.inject({ method: 'GET', url: `/v1/chat/attachments/${res.body.id}`, headers: { authorization: `Bearer ${buyer.token}` } });
    expect(got.statusCode).toBe(200);
    const stored = path.join(dir, 'stored.mp4');
    writeFileSync(stored, got.rawPayload);
    const t = tags(stored);
    expect(t).not.toMatch(/location/);
    expect(t).not.toMatch(/title=home/);
    expect(t).toMatch(/format_name=.*mp4/);
    expect(got.headers['x-content-sha256']).toBe(res.body.sha256);
    expect(createHash('sha256').update(got.rawPayload).digest('hex')).toBe(res.body.sha256);
    expect(res.body.sha256).not.toBe(createHash('sha256').update(original).digest('hex'));
    // Bytes that only pretend to be a video are refused (ffmpeg cannot re-mux them): nothing stored.
    const fake = Buffer.alloc(4096);
    fake.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
    const bad = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, fake, { 'content-type': 'video/mp4', 'x-filename': 'fake.mp4' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('video_not_processable');
  });

  it('8. upload slots are reserved before spooling: parallel uploads cannot exceed the hourly limit, two in flight is the cap, a stalled upload is dropped and its temp file removed', async () => {
    const { seller, room } = await orderRoom();
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    // 25 at once: at most 20 may succeed, the rest are 429 before a byte is spooled.
    const burst = await Promise.all(Array.from({ length: 25 }, () => seller.api.post(`/v1/chat/rooms/${room}/attachments`, jpeg, { 'content-type': 'image/jpeg', 'x-filename': 'p.jpg' })));
    const ok = burst.filter((r) => r.status === 201).length;
    const limited = burst.filter((r) => r.status === 429).length;
    expect(ok, JSON.stringify(burst.map((r) => r.body.error?.code ?? r.status))).toBe(20);
    expect(limited).toBe(5);
    expect(burst.filter((r) => r.body.error?.code === 'too_many_uploads')).toHaveLength(5);

    // Concurrency: a fresh user holds two slow uploads; the third is refused at once.
    const { seller: s2, room: room2 } = await orderRoom();
    const before = spoolDirs();
    const reserved = spoolReservedBytes();
    spoolLimits.idleMs = 1_500; // a stalled upload is dropped after 1.5 s here (30 s in production)
    const a = stallingStream(5_000_000);
    const b = stallingStream(5_000_000);
    const pa = postStream(s2.token, room2, a.stream, a.size);
    const pb = postStream(s2.token, room2, b.stream, b.size);
    await new Promise((r) => setTimeout(r, 300));
    expect(spoolDirs()).toBe(before + 2);
    expect(spoolReservedBytes()).toBeGreaterThan(reserved);
    const c = stallingStream(5_000_000);
    const third = await postStream(s2.token, room2, c.stream, c.size);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('upload_in_progress');
    c.finish();
    // The two stalled uploads time out (idle), answer 408, and leave no temp files or reserved space behind.
    try {
      const [ra, rb] = await Promise.all([pa, pb]);
      expect([ra.status, rb.status]).toEqual([408, 408]);
      expect(ra.body.error.code).toBe('upload_stalled');
    } finally {
      spoolLimits.idleMs = 30_000;
      a.finish();
      b.finish();
    }
    expect(spoolDirs()).toBe(before);
    expect(spoolReservedBytes()).toBe(reserved);
    // Slots are free again.
    const after = await seller.api.get(`/v1/orders`); // any request keeps the connection pool busy for a tick
    expect(after.status).toBe(200);
    const again = await s2.api.post(`/v1/chat/rooms/${room2}/attachments`, jpeg, { 'content-type': 'image/jpeg', 'x-filename': 'p.jpg' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('9. migration 075 marks every row that ever reached Brevo, so a pending opt-out is pushed', async () => {
    const u = await makeUser(h);
    // Synced once (Round 23a era), then opted out before 23b: the 23b backfill left it unmarked.
    await h.ctx.db.query(`UPDATE users SET news_opt_in = false, news_synced_at = now() - interval '10 days', news_synced_email = NULL, news_synced_list = NULL WHERE id = $1`, [u.id]);
    const sql = readFileSync(repo('apps/api/migrations/075_round23d.sql'), 'utf8');
    await h.ctx.db.query(sql); // idempotent
    const row = (await h.ctx.db.query('SELECT news_synced_email, news_synced_list FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row).toEqual({ news_synced_email: u.email, news_synced_list: -1 });
    // The next sync removes the contact from every list.
    const calls: Array<{ method: string; url: string }> = [];
    const fake = async (url: string, init: any) => {
      calls.push({ method: init.method, url });
      return new Response(null, { status: 204 });
    };
    const ctx = { ...h.ctx, cfg: { ...h.ctx.cfg, BREVO_API_KEY: 'k', BREVO_LIST_ID_EN: 11, BREVO_LIST_ID_AR: 12 } } as any;
    await syncNewsletter(ctx, fake as any);
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes(encodeURIComponent(u.email)))).toBe(true);
    expect((await h.ctx.db.query('SELECT news_synced_list FROM users WHERE id = $1', [u.id])).rows[0].news_synced_list).toBeNull();
  });

  it('10. newsletter: a row that keeps failing backs off and is parked; Brevo unsubscribes keep the consent time; a failed Brevo deletion is retried with the stored address', async () => {
    const good = await makeUser(h);
    const bad = await makeUser(h);
    await h.ctx.db.query(`UPDATE users SET news_opt_in = true, news_opt_in_at = now() WHERE id = ANY($1::uuid[])`, [[good.id, bad.id]]);
    const calls: string[] = [];
    const fake = async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push(`${init.method} ${url}`);
      if (init.method === 'GET') return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
      if (body?.email === bad.email) return new Response('boom', { status: 500 });
      return new Response(null, { status: 201 });
    };
    const ctx = { ...h.ctx, cfg: { ...h.ctx.cfg, BREVO_API_KEY: 'k', BREVO_LIST_ID_EN: 11, BREVO_LIST_ID_AR: 12 } } as any;
    expect(await syncNewsletter(ctx, fake as any)).toBeGreaterThanOrEqual(1); // good synced, bad failed once (retried next run)
    const attempts = async () => (await h.ctx.db.query('SELECT news_sync_attempts AS a, news_sync_next_at AS n FROM users WHERE id = $1', [bad.id])).rows[0];
    expect((await attempts()).a).toBe(1);
    await syncNewsletter(ctx, fake as any); // second failure: backs off
    expect((await attempts()).a).toBe(2);
    expect(new Date((await attempts()).n).getTime()).toBeGreaterThan(Date.now());
    const before = calls.length;
    await syncNewsletter(ctx, fake as any); // not due: no call for it, the queue is not blocked
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(calls.slice(0, before).filter((c) => c.startsWith('POST')).length);
    await h.ctx.db.query(`UPDATE users SET news_sync_attempts = 10, news_sync_next_at = NULL WHERE id = $1`, [bad.id]);
    await syncNewsletter(ctx, fake as any); // parked after the maximum: never picked up again
    expect((await attempts()).a).toBe(10);

    // Brevo unsubscribe: opted out, consent time kept, opt-out time recorded.
    const consentAt = (await h.ctx.db.query('SELECT news_opt_in_at FROM users WHERE id = $1', [good.id])).rows[0].news_opt_in_at;
    const unsub = async (url: string, init: any) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ contacts: [{ email: good.email.toUpperCase(), emailBlacklisted: true }] }), { status: 200 });
      return new Response(null, { status: 201 });
    };
    expect(await pullBrevoUnsubscribes(ctx, unsub as any)).toBe(1);
    const g = (await h.ctx.db.query('SELECT news_opt_in, news_opt_in_at, news_opt_out_at FROM users WHERE id = $1', [good.id])).rows[0];
    expect(g.news_opt_in).toBe(false);
    expect(g.news_opt_in_at).toEqual(consentAt);
    expect(g.news_opt_out_at).toBeTruthy();

    // Deletion at Brevo fails → queued with the address Brevo has, retried by the next sync, then gone.
    let deletes = 0;
    let down = true;
    const del = async (url: string, init: any) => {
      if (init.method === 'DELETE') {
        deletes++;
        return down ? new Response('down', { status: 503 }) : new Response(null, { status: 204 });
      }
      if (init.method === 'GET') return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
      return new Response(null, { status: 201 });
    };
    await forgetNewsletterContact(ctx, 'old-address@example.com', del as any);
    expect((await h.ctx.db.query(`SELECT attempts FROM newsletter_forget_queue WHERE email = 'old-address@example.com'`)).rowCount).toBe(1);
    down = false;
    await syncNewsletter(ctx, del as any);
    expect(deletes).toBe(2);
    expect((await h.ctx.db.query(`SELECT 1 FROM newsletter_forget_queue WHERE email = 'old-address@example.com'`)).rowCount).toBe(0);
  });

  it('11. terms: every acceptance is kept; after a material change orders wait for re-acceptance; a stale version at checkout is refused', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { title: 'Terms check', priceCents: 5_00, deliveryMode: 'manual', stock: 10 });
    const history = async () => (await h.ctx.db.query('SELECT version, via FROM terms_acceptances WHERE user_id = $1 ORDER BY id', [buyer.id])).rows;
    expect(await history()).toEqual([{ version: expect.any(String), via: 'signup' }]);
    const current = (await buyer.api.get('/v1/me/legal')).body.currentVersion as string;
    // An order records the version it was placed under, and sending the version the buyer saw is accepted.
    const o1 = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, tosVersion: current });
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    expect(o1.body.order.tos_version).toBe(current);
    expect((await history()).map((r) => r.via)).toEqual(['signup', 'order']);
    // A material change takes effect (date moved up here): orders are blocked until the buyer accepts again…
    const v2 = `23d-${Date.now()}`;
    expect((await admin.api.put('/v1/admin/legal/terms', { version: v2, title: 'Terms', contentMd: '# Terms\n\nA material change to the body.', material: true, effectiveAt: new Date(Date.now() + 15 * 86_400_000).toISOString() })).status).toBe(200);
    await h.ctx.db.query(`UPDATE legal_documents SET effective_at = now() WHERE doc = 'terms' AND version = $1`, [v2]);
    expect((await buyer.api.get('/v1/me/legal')).body.reacceptanceRequired).toBe(true);
    const blocked = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('terms_reacceptance_required');
    expect((await buyer.api.post('/v1/orders/cart', { items: [{ offerId: offer.id, quantity: 1 }], acceptTos: true })).body.error.code).toBe('terms_reacceptance_required');
    // …and a checkout page still showing the old version is refused even after accepting.
    expect((await buyer.api.post('/v1/me/legal/accept', {})).body.tosVersion).toBe(v2);
    const stale = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, tosVersion: current });
    expect(stale.body.error.code).toBe('terms_stale');
    const fresh = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, tosVersion: v2 });
    expect(fresh.status).toBe(201);
    expect(fresh.body.order.tos_version).toBe(v2);
    // History has every step; the first row was not overwritten.
    expect((await history()).map((r) => r.via)).toEqual(['signup', 'order', 'settings', 'order']);
    expect((await history())[0]!.version).toBe(current);
  });

  it('12. accounts: MFA challenge is single-use and dies with a password reset; wrong codes on 2FA-off and delete lock the account; origin secret length; seller ID deadline is live', async () => {
    const u = await makeUser(h, { tier: 1 });
    const secret: string = (await u.api.post('/v1/me/2fa/setup')).body.secret;
    const codeFor = (offset = 0) => totpAt(secret, currentStep() + offset);
    const enabled = await u.api.post('/v1/me/2fa/enable', { code: codeFor() });
    expect(enabled.status).toBe(200);
    // Single use: the same challenge cannot be exchanged twice, even with a fresh valid code.
    const login = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'correct horse battery' });
    const first = await client(h.app).post('/v1/auth/mfa', { mfaToken: login.body.mfaToken, code: codeFor(1) });
    expect(first.status).toBe(200);
    const replay = await client(h.app).post('/v1/auth/mfa', { mfaToken: login.body.mfaToken, code: codeFor(2) });
    expect(replay.status).toBe(401);
    // A password reset issued after the challenge kills it.
    const login2 = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'correct horse battery' });
    const token = 'reset-token-for-23d-test-0123456789';
    await h.ctx.db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`, [u.id, hmacSha256(h.ctx.cfg.FINGERPRINT_KEY, `reset:${token}`)]);
    expect((await client(h.app).post('/v1/auth/password/reset', { token, newPassword: 'a brand new password 23d' })).status).toBe(200);
    expect((await client(h.app).post('/v1/auth/mfa', { mfaToken: login2.body.mfaToken, code: codeFor(3) })).status).toBe(401);

    // Wrong codes on /me/2fa/disable and wrong passwords on /me/delete count towards the lockout.
    const login3 = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'a brand new password 23d' });
    const fresh = await client(h.app).post('/v1/auth/mfa', { mfaToken: login3.body.mfaToken, code: enabled.body.recoveryCodes[0] });
    expect(fresh.status).toBe(200);
    const session = client(h.app, fresh.body.token);
    for (let i = 0; i < h.ctx.cfg.LOGIN_MAX_FAILURES - 1; i++) expect((await session.post('/v1/me/2fa/disable', { code: '000000' })).status).toBe(401);
    expect((await session.post('/v1/me/delete', { password: 'wrong password here' })).status).toBe(401); // the last straw
    const locked = await session.post('/v1/me/2fa/disable', { code: enabled.body.recoveryCodes[1] });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('account_locked');
    expect((await session.post('/v1/me/delete', { password: 'a brand new password 23d' })).body.error.code).toBe('account_locked');

    // ORIGIN_SHARED_SECRET must be long; STAFF_MFA_REQUIRED cannot be off in production.
    const base = {
      NODE_ENV: 'production', APP_ENV: 'production', JWT_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEYS: 'v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=', FINGERPRINT_KEY: 'fp', CRYPTO_INDEXER_SECRET: 'idx',
      PLATFORM_ACCOUNTS: 'live', MALWARE_SCANNER: 'clamd', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', SMS_PROVIDER: 'twilio', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      ORIGIN_SHARED_SECRET: 'origin-secret-of-at-least-32-characters!',
    } as any;
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, ORIGIN_SHARED_SECRET: 'short' })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ ...base, STAFF_MFA_REQUIRED: 'false' })).toThrow(/STAFF_MFA_REQUIRED=false is not allowed/);

    // A seller past the 30-day ID deadline cannot be bought from, even before the hourly job pauses their listings.
    const seller = await makeUser(h, { tier: 1, rulesPassed: true });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { title: 'Late ID', priceCents: 3_00, deliveryMode: 'manual', stock: 5 });
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '31 days' WHERE id = $1`, [seller.id]);
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('seller_id_overdue');
  });

  it('13. public catalogue hides the seller commission rate; seller profiles show reviewers by initial only', async () => {
    const seller = await makeUser(h, { tier: 2, name: 'Shopkeeper' });
    const buyer = await makeUser(h, { name: 'Jordan Buyer' });
    const offer = await makeOffer(seller, { title: 'Rate check', priceCents: 7_00, deliveryMode: 'manual', stock: 5 });
    // Public and buyer views: no seller_rate_bps anywhere; the seller's own view keeps it.
    for (const api of [client(h.app), buyer.api]) {
      const one = await api.get(`/v1/offers/${offer.id}`);
      expect(one.status).toBe(200);
      expect(one.body).not.toHaveProperty('seller_rate_bps');
      const list = await api.get(`/v1/offers?game=${encodeURIComponent('Test Game')}`);
      expect(list.status).toBe(200);
      for (const o of list.body.items ?? list.body) expect(o).not.toHaveProperty('seller_rate_bps');
    }
    expect((await seller.api.get(`/v1/offers/${offer.id}`)).body).toHaveProperty('seller_rate_bps');
    // A review on the seller's profile names the buyer by initial, never in full.
    const order = await buyAndPay(h, buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    expect((await buyer.api.post(`/v1/orders/${order.id}/review`, { rating: 5, comment: 'great' })).status).toBe(201);
    const profile = await client(h.app).get(`/v1/sellers/${seller.id}`);
    expect(profile.status).toBe(200);
    const rv = profile.body.reviews.find((r: any) => r.comment === 'great');
    expect(rv.buyer_name).toBe('J.');
    expect(JSON.stringify(profile.body)).not.toContain('Jordan Buyer');
  });

  it('14. logs: OAuth callback query strings and nested secret keys are redacted', () => {
    expect(redactUrl('/v1/linked-accounts/steam/callback?code=abc&state=xyz')).toBe('/v1/linked-accounts/steam/callback?[redacted]');
    expect(redactUrl('/v1/auth/password/reset?token=t0k')).toBe('/v1/auth/password/reset?[redacted]');
    expect(redactUrl('/v1/offers?game=Test&page=2')).toBe('/v1/offers?game=Test&page=2');
    const out = deepRedact({ req: { url: '/x/callback?code=1', body: { user: { password: 'p', profile: { token: 't', nested: [{ mfaToken: 'm', ok: 1 }] } } } }, msg: 'hi' }) as any;
    expect(out.req.url).toBe('/x/callback?[redacted]');
    expect(out.req.body.user.password).toBe('[redacted]');
    expect(out.req.body.user.profile.token).toBe('[redacted]');
    expect(out.req.body.user.profile.nested[0]).toEqual({ mfaToken: '[redacted]', ok: 1 });
    expect(out.msg).toBe('hi');
  });

  it('15. the tax CSV goes through csvCell: cells are quoted and formulas neutralised', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { title: 'Tax csv', priceCents: 9_00, deliveryMode: 'manual', stock: 5 });
    const order = await buyAndPay(h, buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    // A currency a spreadsheet would run as a formula (country and treatment are constrained columns).
    await h.ctx.db.query(`UPDATE orders SET currency = '=HY' WHERE id = $1`, [order.id]);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const csv = await admin.api.get(`/v1/admin/tax/report?from=${today}&to=${tomorrow}&format=csv`);
    expect(csv.status).toBe(200);
    const text = String(csv.body);
    expect(text.split(/\r?\n/)[0]).toBe('country,treatment,rate_bps,currency,orders,credit_notes,commission_gross_cents,tax_cents,commission_net_cents');
    const line = text.split(/\r?\n/).find((l) => l.includes('=HY'))!;
    expect(line).toContain(`'=HY`);
    expect(line).not.toMatch(/(^|,)=HY/);
  });
});
