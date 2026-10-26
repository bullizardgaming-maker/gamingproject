import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, originWarning } from '../src/config.js';
import { createContext } from '../src/context.js';
import { Keyring } from '../src/lib/crypto.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { SiteverifyCaptcha } from '../src/providers/captcha.js';
import { ClamdScanner, LocalEncryptedStorage, clamdTimeoutMs, type FileStorage } from '../src/providers/files.js';
import { MAX_DIRECT_VIDEO_BYTES, MAX_VIDEO_BYTES } from '../src/domain/attachments.js';
import { pullBrevoUnsubscribes, syncNewsletter } from '../src/domain/newsletter.js';
import { buildApp } from '../src/server.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** Round 23b: fixes from the review of Round 23a. One block per item. */
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(repo(p), 'utf8');
const silent = { info() {}, warn() {}, error() {} };
const MB = 1024 * 1024;
const MP4_HEAD = Buffer.from('\x00\x00\x00\x18ftypmp42', 'latin1');

const prodEnv = (extra: Record<string, string> = {}) =>
  ({
    NODE_ENV: 'production',
    JWT_SECRET: 'x'.repeat(40),
    DATA_ENCRYPTION_KEYS: 'v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=',
    FINGERPRINT_KEY: 'fp',
    CRYPTO_INDEXER_SECRET: 'idx',
    PLATFORM_ACCOUNTS: 'live',
    MALWARE_SCANNER: 'clamd',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test',
    SMS_PROVIDER: 'twilio',
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    ORIGIN_SHARED_SECRET: 'origin-secret-of-at-least-32-characters!',
    ...extra,
  }) as any;

/** A lazily generated video: `size` bytes in 64 KB chunks, never held in memory together. */
function videoStream(size: number) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= size) return this.push(null);
      const n = Math.min(64 * 1024, size - sent);
      const chunk = Buffer.alloc(n, 7);
      if (sent === 0) MP4_HEAD.copy(chunk);
      sent += n;
      this.push(chunk);
    },
  });
}

/** Records the largest Buffer allocated (alloc*, concat, from) while `fn` runs. */
async function largestAllocation<T>(fn: () => Promise<T>): Promise<{ result: T; largest: number }> {
  const B = Buffer as any;
  const orig = { alloc: B.alloc, allocUnsafe: B.allocUnsafe, allocUnsafeSlow: B.allocUnsafeSlow, concat: B.concat, from: B.from };
  let largest = 0;
  const note = (b: Buffer) => {
    if (b && b.length > largest) largest = b.length;
    return b;
  };
  B.alloc = (...a: any[]) => note(orig.alloc.apply(Buffer, a));
  B.allocUnsafe = (...a: any[]) => note(orig.allocUnsafe.apply(Buffer, a));
  B.allocUnsafeSlow = (...a: any[]) => note(orig.allocUnsafeSlow.apply(Buffer, a));
  B.concat = (...a: any[]) => note(orig.concat.apply(Buffer, a));
  B.from = (...a: any[]) => note(orig.from.apply(Buffer, a));
  try {
    return { result: await fn(), largest };
  } finally {
    Object.assign(B, orig);
  }
}

let h: Harness;
let base: string;
beforeAll(async () => {
  h = await setup();
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  h.app.server.closeAllConnections(); // keep-alive sockets from the streamed uploads
  await h.close();
});

async function orderRoom() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h);
  const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
  const order = await buyAndPay(h, buyer, offer.id);
  const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  return { seller, buyer, room };
}

/** A real HTTP upload with a streamed body (no test-side buffering). */
function postStream(url: string, token: string, body: Readable, size: number): Promise<{ status: number; body: any }> {
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

describe('1. origin guard required in production', () => {
  it('APP_ENV=production refuses to start without ORIGIN_SHARED_SECRET; staging warns instead', () => {
    expect(() => loadConfig(prodEnv({ ORIGIN_SHARED_SECRET: '' }))).toThrow(/ORIGIN_SHARED_SECRET is required in production/);
    const staging = loadConfig(prodEnv({ APP_ENV: 'staging', MALWARE_SCANNER: 'dev', ORIGIN_SHARED_SECRET: '' }));
    expect(staging.ORIGIN_SHARED_SECRET).toBeUndefined();
    expect(originWarning(staging)).toMatch(/ORIGIN_SHARED_SECRET is not set/);
    expect(originWarning(loadConfig(prodEnv({ APP_ENV: 'staging', MALWARE_SCANNER: 'dev' })))).toBeNull();
    expect(originWarning(loadConfig(prodEnv()))).toBeNull();
    expect(read('apps/api/src/index.ts')).toMatch(/originWarning\(cfg\)/);
  });

  it('/metrics is not exempt: through Cloudflare (X-Origin-Auth) and with METRICS_TOKEN only', async () => {
    const app = await buildApp(createContext({ ...h.ctx.cfg, ORIGIN_SHARED_SECRET: 's', METRICS_TOKEN: 'tok' } as any, silent, { db: h.ctx.db, pubsub: new MemoryPubSub() }));
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer tok' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-origin-auth': 's' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-origin-auth': 's', authorization: 'Bearer tok' } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('2. videos are streamed, never buffered whole', () => {
  it('caps: 95 MB through the API, 100 MB direct to storage', () => {
    expect(MAX_VIDEO_BYTES).toBe(95 * MB);
    expect(MAX_DIRECT_VIDEO_BYTES).toBe(100 * MB);
  });

  it('a 90 MB upload through the API never allocates more than a few MB, and is stored and served intact', async () => {
    const { seller, buyer, room } = await orderRoom();
    const size = 90 * MB;
    const { result: res, largest } = await largestAllocation(() => postStream(`${base}/v1/chat/rooms/${room}/attachments`, seller.token, videoStream(size), size));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ mime: 'video/mp4', bytes: size });
    expect(largest).toBeLessThan(8 * MB); // a buffered body would allocate 90 MB at once
    // Served as a stream with the same SHA-256.
    const got = await fetch(`${base}/v1/chat/attachments/${res.body.id}`, { headers: { authorization: `Bearer ${buyer.token}` } });
    expect(got.status).toBe(200);
    const hash = createHash('sha256');
    let n = 0;
    for await (const chunk of got.body as any) {
      hash.update(chunk);
      n += chunk.length;
    }
    expect(n).toBe(size);
    expect(hash.digest('hex')).toBe(got.headers.get('x-content-sha256'));
  });

  it('over 95 MB through the API is refused while reading (no Content-Length to go by), nothing stored', async () => {
    const { seller, room } = await orderRoom();
    const before = (await h.ctx.db.query(`SELECT count(*)::int AS n FROM chat_attachments WHERE room_id = $1`, [room])).rows[0].n;
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request(`${base}/v1/chat/rooms/${room}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${seller.token}`, 'content-type': 'video/mp4', 'transfer-encoding': 'chunked' } }, (r) => {
        const parts: Buffer[] = [];
        r.on('data', (d) => parts.push(d));
        r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(Buffer.concat(parts).toString() || '{}') }));
      });
      req.on('error', () => {}); // the server may stop reading early
      videoStream(96 * MB).pipe(req);
      setTimeout(() => reject(new Error('no answer')), 25_000);
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'file_too_large', details: { maxMb: 95 } });
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM chat_attachments WHERE room_id = $1`, [room])).rows[0].n).toBe(before);
  });

  it('a direct upload is read back from the bucket as a stream, not into memory', async () => {
    const size = 99 * MB;
    const objects = new Set<string>();
    let putFileCalls = 0;
    const storage: FileStorage = {
      put: async () => {},
      get: async () => {
        throw new Error('get() must not be used for videos');
      },
      putFile: async (k) => {
        putFileCalls++;
        objects.add(k);
      },
      getStream: async (k) => {
        if (!objects.has(k)) throw new Error('NoSuchKey');
        return videoStream(size);
      },
      delete: async (k) => void objects.delete(k),
      rekey: async () => null,
      keyVersion: null,
      presignPut: async (key) => ({ url: `https://bucket.test/${key}`, headers: {} }),
    };
    const s3 = await buildApp(createContext(h.ctx.cfg, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), storage }));
    await s3.ready();
    try {
      const { seller, room } = await orderRoom();
      const api = client(s3, seller.token);
      const start = await api.post(`/v1/chat/rooms/${room}/attachments/direct`, { contentType: 'video/mp4', bytes: size });
      objects.add(new URL(start.body.url).pathname.slice(1));
      const { result: done, largest } = await largestAllocation(() => api.post(`/v1/chat/attachments/${start.body.id}/complete`));
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect(largest).toBeLessThan(8 * MB);
      expect(putFileCalls).toBe(1); // Round 23d: the verified copy is written under a key the client cannot reach
    } finally {
      await s3.close();
    }
  });

  it('local encrypted storage streams in and out in the encryptBytes format, and detects tampering', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bz-store-'));
    const keyring = new Keyring('v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=');
    const store = new LocalEncryptedStorage(dir, keyring);
    const src = path.join(dir, 'src.bin');
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    writeFileSync(src, data);
    await store.putFile('chat/x/file', src, 'video/mp4', data.length);
    expect((await store.get('chat/x/file')).equals(data)).toBe(true); // same format as put()
    const parts: Buffer[] = [];
    for await (const c of await store.getStream('chat/x/file')) parts.push(c);
    expect(Buffer.concat(parts).equals(data)).toBe(true);
    // A flipped byte fails the GCM tag at the end of the stream.
    const f = path.join(dir, 'chat/x/file');
    const blob = readFileSync(f);
    blob[blob.length - 10] ^= 1;
    writeFileSync(f, blob);
    await expect((async () => {
      for await (const _ of await store.getStream('chat/x/file')) void _;
    })()).rejects.toThrow();
  });
});

describe('3. ClamAV limits and timeouts', () => {
  it('the ClamAV image raises StreamMaxLength, MaxScanSize and MaxFileSize to 120M, used by production and compose', () => {
    const conf = read('services/clamav/clamd-limits.conf');
    for (const key of ['StreamMaxLength', 'MaxScanSize', 'MaxFileSize']) {
      const m = new RegExp(`^${key}\\s+(\\d+)M$`, 'm').exec(conf);
      expect(Number(m?.[1]), key).toBeGreaterThanOrEqual(120);
    }
    expect(read('services/clamav/Dockerfile')).toMatch(/clamd-limits\.conf/);
    const prod = parseYaml(read('render.production.yaml'));
    const clam = prod.services.find((s: any) => s.name === 'bullizard-clamav');
    expect(clam).toMatchObject({ runtime: 'docker', dockerfilePath: './services/clamav/Dockerfile', dockerContext: './services/clamav' });
    expect(parseYaml(read('docker-compose.yml')).services.clamav.build).toBe('services/clamav');
    expect(read('.github/workflows/ci.yml')).toMatch(/clamconf/);
  });

  it('the scan timeout grows with the size: 15 s + 1 s per 5 MB, at most 120 s', () => {
    expect(clamdTimeoutMs(0)).toBe(15_000);
    expect(clamdTimeoutMs(5 * MB)).toBe(16_000);
    expect(clamdTimeoutMs(95 * MB)).toBe(34_000);
    expect(clamdTimeoutMs(100 * MB)).toBe(35_000);
    expect(clamdTimeoutMs(10_000 * MB)).toBe(120_000);
  });

  /** A stand-in clamd: reads INSTREAM chunks and answers as configured. */
  async function fakeClamd(answer: 'ok' | 'limit' | 'silent') {
    const seen = { bytes: 0, largestChunk: 0 };
    const server = createServer((sock: Socket) => {
      let buf = Buffer.alloc(0);
      let started = false;
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!started) {
          const i = buf.indexOf(0);
          if (i < 0) return;
          buf = buf.subarray(i + 1);
          started = true;
        }
        while (buf.length >= 4) {
          const n = buf.readUInt32BE(0);
          if (n === 0) {
            if (answer === 'ok') sock.end('stream: OK\0');
            if (answer === 'limit') sock.end('INSTREAM size limit exceeded. ERROR\0');
            return;
          }
          if (buf.length < 4 + n) return;
          seen.bytes += n;
          seen.largestChunk = Math.max(seen.largestChunk, n);
          buf = buf.subarray(4 + n);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('streams in 64 KB chunks and fails closed on a limit error or a timeout', async () => {
    const ok = await fakeClamd('ok');
    expect(await new ClamdScanner('127.0.0.1', ok.port).scanStream(videoStream(3 * MB), 3 * MB)).toEqual({ clean: true });
    expect(ok.seen).toEqual({ bytes: 3 * MB, largestChunk: 64 * 1024 });
    await ok.close();
    const limit = await fakeClamd('limit');
    await expect(new ClamdScanner('127.0.0.1', limit.port).scanStream(videoStream(MB), MB)).rejects.toThrow(/unexpected clamd reply/);
    await limit.close();
    const silentClamd = await fakeClamd('silent');
    await expect(new ClamdScanner('127.0.0.1', silentClamd.port, 300).scanStream(videoStream(MB), MB)).rejects.toThrow(/clamd timeout/);
    await silentClamd.close();
  });

  it('an upload while the scanner fails is refused (503), not stored', async () => {
    const failing = { name: 'clamd', scan: async () => { throw new Error('down'); }, scanStream: async (s: Readable) => { s.destroy(); throw new Error('down'); } };
    const app = await buildApp(createContext(h.ctx.cfg, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), scanner: failing as any }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { seller, room } = await orderRoom();
      const res = await postStream(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/chat/rooms/${room}/attachments`, seller.token, videoStream(2 * MB), 2 * MB);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('scanner_unavailable');
      expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM chat_attachments WHERE room_id = $1`, [room])).rows[0].n).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe('4. Turnstile action and hostname', () => {
  const PASS = '1x0000000000000000000000000000000AA';
  const verify = (action: string, hostname: string) =>
    new SiteverifyCaptcha('turnstile', PASS, (async () => new Response(JSON.stringify({ success: true, action, hostname }))) as any);

  it('a token is only good for the form and the site it was solved on', async () => {
    expect(await verify('signup', 'bullizard.com').verify('t', undefined, { action: 'signup', hostname: 'bullizard.com' })).toBe(true);
    expect(await verify('signin', 'bullizard.com').verify('t', undefined, { action: 'signup', hostname: 'bullizard.com' })).toBe(false);
    expect(await verify('signup', 'evil.example').verify('t', undefined, { action: 'signup', hostname: 'bullizard.com' })).toBe(false);
    expect(await verify('signup', 'BULLIZARD.com').verify('t', undefined, { action: 'signup', hostname: 'bullizard.com' })).toBe(true);
  });

  it('the endpoints ask for their own action and the web host (PUBLIC_WEB_URL, or TURNSTILE_HOSTNAME)', async () => {
    const seen: Array<{ action?: string; hostname?: string }> = [];
    const captcha = { enabled: true, verify: async (_t: string | undefined, _ip?: string, expect?: any) => (seen.push(expect), true) };
    const cfg = { ...h.ctx.cfg, PUBLIC_WEB_URL: 'https://staging.bullizard.com', CAPTCHA_AFTER_FAILED_LOGINS: 0 };
    const app = await buildApp(createContext(cfg as any, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), messenger: h.messenger, captcha }));
    await app.ready();
    try {
      const api = client(app, undefined, { origin: 'https://staging.bullizard.com' });
      const email = `ts${Date.now()}@example.com`;
      await api.post('/v1/auth/register', { email, password: 'correct horse battery', displayName: 'Ts', acceptTerms: true, captchaToken: 'x' });
      await api.post('/v1/auth/login', { email, password: 'correct horse battery', captchaToken: 'x' });
      await api.post('/v1/auth/password/forgot', { email, captchaToken: 'x' });
      expect(seen).toEqual([
        { action: 'signup', hostname: 'staging.bullizard.com' },
        { action: 'signin', hostname: 'staging.bullizard.com' },
        { action: 'reset', hostname: 'staging.bullizard.com' },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('4. Brevo sync: bans, address and language changes, unsubscribes', () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let contacts: any[] = [];
  const fake = (async (url: string, init: any) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET') return new Response(JSON.stringify({ contacts: url.includes('offset=0') ? contacts : [] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as any;
  const ctx = () => ({ ...h.ctx, cfg: { ...h.ctx.cfg, BREVO_API_KEY: 'k', BREVO_LIST_ID_EN: 21, BREVO_LIST_ID_AR: 22 } }) as any;
  const writes = () => calls.filter((c) => c.method !== 'GET');

  async function subscriber(locale = 'en') {
    await syncNewsletter(ctx(), fake); // settle everyone else first
    const u = await makeUser(h);
    await u.api.put('/v1/me/newsletter', { optIn: true });
    if (locale !== 'en') await h.ctx.db.query(`UPDATE users SET locale = $2 WHERE id = $1`, [u.id, locale]);
    calls.length = 0;
    expect(await syncNewsletter(ctx(), fake)).toBe(1);
    return u;
  }

  it('a banned or suspended subscriber is taken off the lists, and back on when active again', async () => {
    const u = await subscriber();
    await h.ctx.db.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [u.id]);
    calls.length = 0;
    expect(await syncNewsletter(ctx(), fake)).toBe(1);
    expect(writes()).toEqual([{ method: 'PUT', url: `https://api.brevo.com/v3/contacts/${encodeURIComponent(u.email)}`, body: { unlinkListIds: [21, 22] } }]);
    expect(await syncNewsletter(ctx(), fake)).toBe(0);
    await h.ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
    expect(await syncNewsletter(ctx(), fake)).toBe(0); // still off the lists
    await h.ctx.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [u.id]);
    calls.length = 0;
    expect(await syncNewsletter(ctx(), fake)).toBe(1);
    expect(writes()[0]).toMatchObject({ method: 'POST', body: { email: u.email, listIds: [21] } });
  });

  it('an address change removes the old contact and adds the new one; a language change moves the list', async () => {
    const u = await subscriber();
    const fresh = `new_${Date.now()}@example.com`;
    await h.ctx.db.query(`UPDATE users SET email = $2 WHERE id = $1`, [u.id, fresh]);
    calls.length = 0;
    expect(await syncNewsletter(ctx(), fake)).toBe(1);
    expect(writes()).toEqual([
      { method: 'PUT', url: `https://api.brevo.com/v3/contacts/${encodeURIComponent(u.email)}`, body: { unlinkListIds: [21, 22] } },
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ email: fresh, listIds: [21] }) }),
    ]);
    await h.ctx.db.query(`UPDATE users SET locale = 'ar' WHERE id = $1`, [u.id]);
    calls.length = 0;
    expect(await syncNewsletter(ctx(), fake)).toBe(1);
    expect(writes()).toEqual([expect.objectContaining({ method: 'POST', body: expect.objectContaining({ email: fresh, listIds: [22], unlinkListIds: [21] }) })]);
  });

  it('unsubscribes made in Brevo opt the user out here: no re-subscribe, not in the CSV', async () => {
    const a = await subscriber('ar');
    const b = await subscriber();
    contacts = [
      { email: a.email.toUpperCase(), emailBlacklisted: true, listUnsubscribed: [] },
      { email: b.email, emailBlacklisted: false, listUnsubscribed: [21] },
    ];
    expect(await pullBrevoUnsubscribes(ctx(), fake)).toBe(2);
    contacts = [];
    const rows = (await h.ctx.db.query(`SELECT news_opt_in FROM users WHERE id = ANY($1::uuid[])`, [[a.id, b.id]])).rows;
    expect(rows.every((r) => r.news_opt_in === false)).toBe(true);
    // The next sync takes them off our side's record, never subscribes them again.
    calls.length = 0;
    await syncNewsletter(ctx(), fake);
    expect(writes().some((c) => c.method === 'POST' && [a.email, b.email].includes(c.body.email))).toBe(false);
    const admin = await makeUser(h, { role: 'admin' });
    const csv = (await admin.api.get('/v1/admin/newsletter.csv')).body as string;
    expect(csv).not.toContain(a.email);
    expect(csv).not.toContain(b.email);
    // The pull reads only what changed since the last one (with an hour of overlap).
    calls.length = 0;
    await pullBrevoUnsubscribes(ctx(), fake);
    const since = new URL(calls[0]!.url).searchParams.get('modifiedSince')!;
    expect(Date.now() - new Date(since).getTime()).toBeLessThan(2 * 3_600_000);
  });
});

describe('4. newsletter.export permission and SMS in production', () => {
  it('only admin and marketing download the subscriber list (audited); compliance and finance cannot', async () => {
    for (const role of ['compliance', 'finance', 'support'] as const) {
      expect((await (await makeUser(h, { role })).api.get('/v1/admin/newsletter.csv')).status, role).toBe(403);
    }
    const marketing = await makeUser(h, { role: 'marketing' as any });
    expect((await marketing.api.get('/v1/admin/newsletter.csv')).status).toBe(200);
    expect((await marketing.api.get('/v1/admin/newsletter/status')).status).toBe(200);
    expect((await marketing.api.get('/v1/admin/analytics?days=30')).status).toBe(403); // nothing else
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM admin_audit_log WHERE actor_id = $1 AND action = 'newsletter.exported'`, [marketing.id])).rows[0].n).toBe(1);
    // A marketing staff role can be added to someone's roles too.
    const u = await makeUser(h);
    await h.ctx.db.query(`UPDATE users SET staff_roles = ARRAY['marketing', 'lead'] WHERE id = $1`, [u.id]);
  });

  it('SMS_PROVIDER=console is refused in production, allowed on staging', () => {
    expect(() => loadConfig(prodEnv({ SMS_PROVIDER: 'console' }))).toThrow(/SMS_PROVIDER=console/);
    expect(loadConfig(prodEnv({ SMS_PROVIDER: 'console', APP_ENV: 'staging', MALWARE_SCANNER: 'dev' })).SMS_PROVIDER).toBe('console');
  });
});
