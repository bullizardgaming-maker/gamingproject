import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createPool, strictSslUrl } from '../src/db.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { SiteverifyCaptcha } from '../src/providers/captcha.js';
import type { FileStorage } from '../src/providers/files.js';
import { ConsoleMessenger, ResendMessenger, RoutingMessenger } from '../src/providers/messaging.js';
import { dispatchEmails } from '../src/domain/notifications.js';
import { sendOpsAlerts } from '../src/domain/opsAlerts.js';
import { syncNewsletter } from '../src/domain/newsletter.js';
import { MAX_VIDEO_BYTES } from '../src/domain/attachments.js';
import { buildApp } from '../src/server.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** Round 23a: what the first Render staging deploy needed, then domain, email and Cloudflare. One block per item. */
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(repo(p), 'utf8');
const silent = { info() {}, warn() {}, error() {} };

/** A production/staging environment with every secret filled in, as Render would pass it. */
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
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    ORIGIN_SHARED_SECRET: 'origin', // required in production since Round 23b
    SMS_PROVIDER: 'twilio',
    ...extra,
  }) as any;

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('9. the production image has every runtime package', () => {
  it('copies apps/api/node_modules (packages npm keeps there, e.g. @sentry/node) into the image', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const nested = Object.keys(lock.packages).filter((k) => k.startsWith('apps/api/node_modules/') && !lock.packages[k].dev);
    expect(nested.length).toBeGreaterThan(0); // @sentry/node, undici today
    const dockerfile = read('apps/api/Dockerfile');
    expect(dockerfile).toMatch(/COPY --from=build \/app\/apps\/api\/node_modules apps\/api\/node_modules/);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
  });

  it('@sentry/node is a production dependency and CI starts the built image', () => {
    const pkg = JSON.parse(read('apps/api/package.json'));
    expect(pkg.dependencies['@sentry/node']).toBeTruthy();
    expect(pkg.devDependencies?.['@sentry/node']).toBeUndefined();
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/api-image:/);
    expect(ci).toMatch(/docker build -f apps\/api\/Dockerfile/);
    expect(ci).toMatch(/check-runtime-imports\.mjs/);
    expect(ci).toMatch(/localhost:4000\/readyz/);
    expect(existsSync(repo('apps/api/scripts/check-runtime-imports.mjs'))).toBe(true);
  });
});

describe('7. staging mode', () => {
  it('APP_ENV=staging with NODE_ENV=production allows MALWARE_SCANNER=dev (no ClamAV, no CLAMD_HOST)', () => {
    const cfg = loadConfig(prodEnv({ APP_ENV: 'staging', MALWARE_SCANNER: 'dev', SANDBOX_MODE: 'true', PLATFORM_ACCOUNTS: 'mock' }));
    expect(cfg.APP_ENV).toBe('staging');
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.MALWARE_SCANNER).toBe('dev');
    // Production proper still refuses it.
    expect(() => loadConfig(prodEnv({ MALWARE_SCANNER: 'dev' }))).toThrow(/MALWARE_SCANNER=clamd/);
    expect(loadConfig(prodEnv()).APP_ENV).toBe('production');
  });

  it('keeps every other production check on staging', () => {
    const staging = (extra: Record<string, string>) => () => loadConfig(prodEnv({ APP_ENV: 'staging', MALWARE_SCANNER: 'dev', ...extra }));
    expect(staging({ DATA_ENCRYPTION_KEYS: '' })).toThrow(/DATA_ENCRYPTION_KEYS must be set/);
    expect(staging({ EMAIL_PROVIDER: 'console' })).toThrow(/EMAIL_PROVIDER=console is not allowed/);
    expect(staging({ TURNSTILE_SECRET: '' })).toThrow(/TURNSTILE_SECRET/);
    expect(staging({ PLATFORM_ACCOUNTS: 'mock' })).toThrow(/PLATFORM_ACCOUNTS=live/); // only with SANDBOX_MODE, as in production
    expect(() => loadConfig({ APP_ENV: 'staging' } as any)).toThrow(/needs NODE_ENV=production/);
    // What the first deploy tried: a clear message instead of a ZodError.
    expect(() => loadConfig(prodEnv({ NODE_ENV: 'staging' }))).toThrow(/APP_ENV=staging/);
  });
});

describe('8. render.yaml (staging blueprint)', () => {
  const bp = parseYaml(read('render.yaml'));
  const group = bp.envVarGroups[0].envVars as Array<{ key: string; value?: string; sync?: boolean; generateValue?: boolean }>;

  it('puts every service and the Key Value store in Frankfurt and has no ClamAV service', () => {
    expect(bp.services.length).toBeGreaterThan(0);
    for (const s of bp.services) expect([s.name, s.region]).toEqual([s.name, 'frankfurt']);
    expect(bp.services.some((s: any) => s.type === 'pserv' || /clamav/i.test(s.name))).toBe(false);
    expect(read('render.yaml')).not.toMatch(/CLAMD_HOST/);
  });

  it('keeps the secrets out of the file (sync: false)', () => {
    const askFor = new Set(group.filter((v) => v.sync === false).map((v) => v.key));
    for (const key of ['DATABASE_URL', 'DATA_ENCRYPTION_KEYS', 'RESEND_API_KEY', 'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'ORIGIN_SHARED_SECRET', 'TURNSTILE_SECRET', 'BREVO_API_KEY']) {
      expect(askFor.has(key), key).toBe(true);
    }
  });

  it('its values load as a staging config once the asked-for values are filled in', () => {
    const env: Record<string, string> = {};
    for (const v of group) {
      if (v.value !== undefined) env[v.key] = String(v.value);
      else if (v.generateValue) env[v.key] = 'g'.repeat(40);
    }
    Object.assign(env, { DATA_ENCRYPTION_KEYS: 'v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=', RESEND_API_KEY: 're_x', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA', ORIGIN_SHARED_SECRET: 's' });
    const cfg = loadConfig(env as any);
    expect(cfg.APP_ENV).toBe('staging');
    expect(cfg.EMAIL_PROVIDER).toBe('resend');
    expect(cfg.EMAIL_FROM).toBe('Bullizard <no-reply@mail.bullizard.com>');
    expect(cfg.ALERTS_EMAIL).toBe('alerts@bullizard.com');
    expect(cfg.FINANCE_EMAIL).toBe('finance@bullizard.com');
    // Blank sync:false values (Render sends "") count as unset.
    expect(loadConfig({ ...env, BREVO_API_KEY: '', ORIGIN_SHARED_SECRET: '' } as any).ORIGIN_SHARED_SECRET).toBeUndefined();
  });
});

describe('10. Postgres sslmode', () => {
  it('asks for verify-full explicitly instead of relying on pg treating require as verify-full', () => {
    expect(strictSslUrl('postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require')).toBe('postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=verify-full');
    expect(strictSslUrl('postgres://h/db?channel_binding=require&sslmode=require&x=1')).toBe('postgres://h/db?channel_binding=require&sslmode=verify-full&x=1');
    expect(strictSslUrl('postgres://h/db?sslmode=prefer')).toBe('postgres://h/db?sslmode=verify-full');
    for (const kept of ['postgres://h/db', 'postgres://h/db?sslmode=disable', 'postgres://h/db?sslmode=no-verify', 'postgres://h/db?sslmode=verify-full']) expect(strictSslUrl(kept)).toBe(kept);
    const pool = createPool('postgres://u:p@localhost:5432/x?sslmode=require', 1);
    expect((pool as any).options.connectionString).toMatch(/sslmode=verify-full$/);
    void pool.end();
  });
});

describe('1. email through Resend', () => {
  it('posts to the Resend API with an idempotency key, reply-to, and no tracking options', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fake = async (url: any, init: any) => (calls.push({ url: String(url), init }), new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }));
    const m = new ResendMessenger('re_key', 'Bullizard <no-reply@mail.bullizard.com>', 'support@bullizard.com', 'https://api.resend.test', fake as any);
    await m.send({ channel: 'email', to: 'a@example.com', subject: 'Hi', body: 'text', html: '<p>text</p>', idempotencyKey: 'notification-1' });
    expect(calls[0]!.url).toBe('https://api.resend.test/emails');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer re_key');
    expect(calls[0]!.init.headers['Idempotency-Key']).toBe('notification-1');
    const body = JSON.parse(calls[0]!.init.body);
    expect(body).toEqual({ from: 'Bullizard <no-reply@mail.bullizard.com>', to: ['a@example.com'], subject: 'Hi', text: 'text', html: '<p>text</p>', reply_to: 'support@bullizard.com' });
    // Without a key each message still gets its own.
    await m.send({ channel: 'email', to: 'b@example.com', body: 'x' });
    await m.send({ channel: 'email', to: 'b@example.com', body: 'x' });
    expect(calls[1]!.init.headers['Idempotency-Key']).not.toBe(calls[2]!.init.headers['Idempotency-Key']);
    // Errors surface (the outbox retries).
    const failing = new ResendMessenger('k', 'f', undefined, 'https://x', (async () => new Response('bad', { status: 422 })) as any);
    await expect(failing.send({ channel: 'email', to: 'c@example.com', body: 'x' })).rejects.toThrow(/resend 422/);
  });

  it('EMAIL_PROVIDER=resend is wired up; dev providers stay', () => {
    const cfg = loadConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_k' } as any);
    const ctx = createContext(cfg, silent, { db: h.ctx.db, pubsub: new MemoryPubSub() });
    expect(((ctx.messenger as RoutingMessenger) as any).routes.email).toBeInstanceOf(ResendMessenger);
    expect(() => createContext(loadConfig({ EMAIL_PROVIDER: 'resend' } as any), silent, { db: h.ctx.db, pubsub: new MemoryPubSub() })).toThrow(/RESEND_API_KEY/);
    expect(loadConfig({} as any).EMAIL_PROVIDER).toBe('console');
    void ctx.views.close();
  });

  it('the outbox uses the notification id as the key, so a retry is the same message', async () => {
    const user = await makeUser(h);
    await h.ctx.db.query(`UPDATE notifications SET status = 'sent' WHERE status = 'pending'`);
    await h.ctx.db.query(`INSERT INTO notifications (user_id, template, data, status) VALUES ($1, 'welcome', '{"name":"x"}', 'pending')`, [user.id]);
    const keys: string[] = [];
    let fail = true;
    const messenger = { send: async (m: any) => { keys.push(m.idempotencyKey); if (fail) { fail = false; throw new Error('timeout'); } } };
    const ctx = { ...h.ctx, messenger };
    await dispatchEmails(ctx as any);
    await h.ctx.db.query(`UPDATE notifications SET next_attempt_at = now() WHERE status = 'pending'`);
    await dispatchEmails(ctx as any);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^notification-/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('ops alerts also go to ALERTS_EMAIL (once per hour), sent through the outbox to the mailbox', async () => {
    await h.ctx.db.query(`UPDATE notifications SET status = 'sent' WHERE status = 'pending'`);
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`INSERT INTO withdrawals (user_id, amount_cents, currency, status) VALUES ($1, 1000, 'USD', 'unknown')`, [seller.id]);
    const ctx = { ...h.ctx, cfg: { ...h.ctx.cfg, ALERTS_EMAIL: 'alerts@bullizard.com' } };
    await sendOpsAlerts(ctx as any);
    await sendOpsAlerts(ctx as any);
    const rows = (await h.ctx.db.query(`SELECT to_email, user_id, template FROM notifications WHERE to_email IS NOT NULL AND status = 'pending'`)).rows;
    expect(rows.filter((r) => r.template === 'ops_alert').length).toBeGreaterThanOrEqual(1);
    expect(new Set(rows.map((r) => r.to_email))).toEqual(new Set(['alerts@bullizard.com']));
    const keys = (await h.ctx.db.query(`SELECT dedupe_key FROM notifications WHERE to_email IS NOT NULL AND status = 'pending'`)).rows.map((r) => r.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length); // the second run within the hour queued nothing new
    const messenger = new ConsoleMessenger(() => {});
    await dispatchEmails({ ...h.ctx, messenger } as any);
    expect(messenger.lastTo('alerts@bullizard.com')?.subject).toBeTruthy();
    await h.ctx.db.query(`DELETE FROM withdrawals WHERE user_id = $1`, [seller.id]);
  });

  it('reconciliation alerts go to ALERTS_EMAIL and FINANCE_EMAIL', () => {
    const src = readFileSync(new URL('../src/domain/reconciliation.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/enqueueMailboxEmail\(ctx\.db, to, 'reconciliation_alert'/);
    expect(src).toMatch(/ALERTS_EMAIL, ctx\.cfg\.FINANCE_EMAIL/);
  });
});

describe('2. behind Cloudflare (ORIGIN_SHARED_SECRET)', () => {
  const SECRET = 'origin-secret-round23a';
  let cf: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    cf = await originApp(100_000);
  });
  afterAll(async () => cf.close());
  const originApp = async (perMinute: number) => {
    const cfg = { ...h.ctx.cfg, ORIGIN_SHARED_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: perMinute, AUTH_RATE_LIMIT_PER_MINUTE: 100000 };
    const app = await buildApp(createContext(cfg as any, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), messenger: h.messenger }));
    await app.ready();
    return app;
  };

  it('refuses requests without the matching X-Origin-Auth, except /readyz and /healthz', async () => {
    expect((await cf.inject({ method: 'GET', url: '/v1/games' })).statusCode).toBe(403);
    expect((await cf.inject({ method: 'GET', url: '/v1/games', headers: { 'x-origin-auth': 'wrong' } })).json().error.code).toBe('origin_forbidden');
    expect((await cf.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect((await cf.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await cf.inject({ method: 'GET', url: '/readyz?x=1' })).statusCode).toBe(200);
    expect((await cf.inject({ method: 'GET', url: '/v1/me', headers: { 'x-origin-auth': SECRET } })).statusCode).toBe(401); // through: auth decides
  });

  it('uses CF-Connecting-IP for sessions, fraud signals, orders (buyer_ip), the audit log and rate limits', async () => {
    const ip = '203.0.113.77';
    const headers = { 'x-origin-auth': SECRET, 'cf-connecting-ip': ip, 'x-forwarded-for': '198.51.100.1' };
    const email = `cf_${Date.now()}@example.com`;
    const reg = await client(cf, undefined, headers).post('/v1/auth/register', { email, password: 'correct horse battery', displayName: 'Cf User', acceptTerms: true });
    expect(reg.status).toBe(201);
    const userId = reg.body.user.id;
    const subnet = (await h.ctx.db.query(`SELECT value FROM risk_signals WHERE user_id = $1 AND kind = 'ip_subnet'`, [userId])).rows.map((r) => r.value);
    expect(subnet).toEqual(['203.0.113.0/24']);
    const sessions = await client(cf, reg.body.token, headers).get('/v1/me/sessions');
    expect(JSON.stringify(sessions.body)).toContain(ip);

    // An order placed through Cloudflare records the buyer's real IP.
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1, email_verified_at = now(), phone_verified_at = now() WHERE id = $1`, [userId]);
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
    const order = await client(cf, reg.body.token, headers).post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect((await h.ctx.db.query(`SELECT host(buyer_ip) AS ip FROM orders WHERE id = $1`, [order.body.order.id])).rows[0].ip).toBe(ip);

    // Staff actions are audited with it.
    const admin = await makeUser(h, { role: 'admin' });
    await client(cf, admin.token, headers).get('/v1/admin/newsletter.csv');
    expect((await h.ctx.db.query(`SELECT host(ip) AS ip FROM admin_audit_log WHERE actor_id = $1 AND action = 'newsletter.exported'`, [admin.id])).rows[0].ip).toBe(ip);

    // Rate limits count per real client IP, not per Cloudflare edge address.
    const rl = await originApp(3);
    const hit = (who: string) => rl.inject({ method: 'GET', url: '/v1/auth/config', headers: { 'x-origin-auth': SECRET, 'cf-connecting-ip': who } });
    const a = `198.18.${Math.floor(Math.random() * 250)}.1`;
    const b = `198.18.${Math.floor(Math.random() * 250)}.2`;
    const codesA = [];
    for (let i = 0; i < 4; i++) codesA.push((await hit(a)).statusCode);
    expect(codesA.at(-1)).toBe(429);
    expect((await hit(b)).statusCode).toBe(200);
    await rl.close();
  });
});

describe('3. Cloudflare limits', () => {
  it('pings open WebSockets well inside the 100-second idle timeout', async () => {
    expect(loadConfig({} as any).WS_PING_SECONDS).toBe(30);
    const quick = await setup({ WS_PING_SECONDS: '1' });
    try {
      await quick.app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(`ws://127.0.0.1:${(quick.app.server.address() as AddressInfo).port}/v1/ws`);
      const pinged = await new Promise<boolean>((resolve) => {
        ws.on('ping', () => resolve(true));
        setTimeout(() => resolve(false), 4_000);
      });
      ws.close();
      expect(pinged).toBe(true);
    } finally {
      await quick.close();
    }
  });

  it('a video over 95 MB through the API gets file_too_large with the limit (the web app translates it)', async () => {
    expect(MAX_VIDEO_BYTES).toBe(95 * 1024 * 1024);
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
    const order = await buyAndPay(h, buyer, offer.id);
    const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id;
    const big = Buffer.alloc(MAX_VIDEO_BYTES + 1024);
    big.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
    const res = await h.app.inject({ method: 'POST', url: `/v1/chat/rooms/${room}/attachments`, headers: { authorization: `Bearer ${seller.token}`, 'content-type': 'video/mp4' }, payload: big });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'file_too_large', details: { maxMb: 95, directUpload: false } });
    // Without object storage there is no direct upload either.
    expect((await seller.api.post(`/v1/chat/rooms/${room}/attachments/direct`, { contentType: 'video/mp4', bytes: big.length })).body.error.code).toBe('direct_upload_unavailable');
  });

  it('with object storage, a large video goes straight to the bucket, then is checked, scanned and posted', async () => {
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
      presignPut: async (key, contentType, bytes) => ({ url: `https://bucket.test/${key}?signed=1&len=${bytes}`, headers: { 'Content-Type': contentType } }),
    };
    const s3 = await buildApp(createContext(h.ctx.cfg, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), storage }));
    await s3.ready();
    try {
      const seller = await makeUser(h, { tier: 2 });
      const buyer = await makeUser(h);
      const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
      const order = await buyAndPay(h, buyer, offer.id);
      const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id;
      const api = client(s3, seller.token);
      const video = Buffer.alloc(99 * 1024 * 1024); // above the 95 MB API cap, within the 100 MB direct cap
      video.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
      const start = await api.post(`/v1/chat/rooms/${room}/attachments/direct`, { fileName: 'trade.mp4', contentType: 'video/mp4', bytes: video.length });
      expect(start.status).toBe(201);
      expect(start.body.url).toMatch(/^https:\/\/bucket\.test\/chat\//);
      expect((await api.post(`/v1/chat/attachments/${start.body.id}/complete`)).body.error.code).toBe('upload_missing'); // not PUT yet
      objects.set(new URL(start.body.url).pathname.slice(1), video); // the browser's PUT
      const done = await api.post(`/v1/chat/attachments/${start.body.id}/complete`);
      expect(done.status).toBe(201);
      expect(done.body).toMatchObject({ id: start.body.id, mime: 'video/mp4', bytes: video.length });
      // Usable as delivery proof like any attachment; a second complete finds nothing to do.
      expect((await h.ctx.db.query(`SELECT status FROM chat_attachments WHERE id = $1`, [start.body.id])).rows[0].status).toBe('clean');
      expect((await api.post(`/v1/chat/attachments/${start.body.id}/complete`)).status).toBe(404);
      // A file that is not the announced video is dropped.
      const bad = await api.post(`/v1/chat/rooms/${room}/attachments/direct`, { contentType: 'video/mp4', bytes: 10 });
      objects.set(new URL(bad.body.url).pathname.slice(1), Buffer.from('MZ not a video'));
      expect((await api.post(`/v1/chat/attachments/${bad.body.id}/complete`)).body.error.code).toBe('unsupported_file');
      expect(objects.has(new URL(bad.body.url).pathname.slice(1))).toBe(false);
      // Only participants, and not larger than the direct limit.
      const stranger = await makeUser(h);
      expect((await client(s3, stranger.token).post(`/v1/chat/rooms/${room}/attachments/direct`, { contentType: 'video/mp4', bytes: 10 })).status).toBe(403);
      expect((await api.post(`/v1/chat/rooms/${room}/attachments/direct`, { contentType: 'video/mp4', bytes: 101 * 1024 * 1024 })).status).toBe(413);
    } finally {
      await s3.close();
    }
  });
});

describe('4. security.txt', () => {
  it('is published with exactly the agreed text and served as text/plain by Vercel', () => {
    expect(read('apps/web/public/.well-known/security.txt')).toBe(
      'Contact: mailto:security@bullizard.com\nExpires: 2027-10-25T00:00:00.000Z\nPreferred-Languages: en, ar\nCanonical: https://bullizard.com/.well-known/security.txt\n',
    );
    for (const f of ['vercel.json', 'apps/web/vercel.json']) {
      const cfg = JSON.parse(read(f));
      const rewritten = (p: string) => cfg.rewrites.some((r: any) => new RegExp(`^${r.source}$`).test(p));
      expect(rewritten('/.well-known/security.txt'), f).toBe(false);
      expect(rewritten('/orders/1'), f).toBe(true);
      const h = cfg.headers.find((x: any) => x.source === '/.well-known/security.txt');
      expect(h.headers.find((x: any) => x.key === 'Content-Type').value, f).toMatch(/^text\/plain/);
    }
  });
});

describe('5. newsletter consent', () => {
  it('is off unless ticked at sign-up; the choice and its time are stored and can be changed in settings', async () => {
    const reg = (newsOptIn?: boolean) =>
      client(h.app).post('/v1/auth/register', { email: `n${Math.random()}@example.com`, password: 'correct horse battery', displayName: 'News', acceptTerms: true, ...(newsOptIn === undefined ? {} : { newsOptIn }) });
    const plain = (await reg()).body;
    expect(plain.user).toMatchObject({ news_opt_in: false, news_opt_in_at: null });
    const yes = (await reg(true)).body;
    expect(yes.user.news_opt_in).toBe(true);
    expect(yes.user.news_opt_in_at).toBeTruthy();
    const api = client(h.app, plain.token);
    const on = await api.put('/v1/me/newsletter', { optIn: true });
    expect(on.body.newsOptIn).toBe(true);
    expect((await api.get('/v1/me')).body.user.news_opt_in).toBe(true);
    const off = await api.put('/v1/me/newsletter', { optIn: false });
    expect(off.body).toMatchObject({ newsOptIn: false });
    expect(new Date(off.body.newsOptInAt).getTime()).toBeGreaterThanOrEqual(new Date(on.body.newsOptInAt).getTime());
  });

  it('syncs changes to Brevo lists by language (EN / AR), retries failures, and Ops can export a CSV', async () => {
    // Earlier subscribers count as already in Brevo.
    await h.ctx.db.query(`UPDATE users SET news_synced_at = now(), news_synced_email = email, news_synced_list = CASE WHEN locale = 'ar' THEN 12 ELSE 11 END WHERE news_opt_in`);
    const en = (await client(h.app).post('/v1/auth/register', { email: `en${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'En', acceptTerms: true, newsOptIn: true })).body;
    const ar = (await client(h.app).post('/v1/auth/register', { email: `ar${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Ar', acceptTerms: true, newsOptIn: true, locale: 'ar' })).body;
    const calls: Array<{ method: string; url: string; body: any; key: string }> = [];
    let down = true;
    const fake = async (url: string, init: any) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : null, key: init.headers['api-key'] });
      return down ? new Response('down', { status: 503 }) : new Response(null, { status: 201 });
    };
    const ctx = { ...h.ctx, cfg: { ...h.ctx.cfg, BREVO_API_KEY: 'xkeysib-test', BREVO_LIST_ID_EN: 11, BREVO_LIST_ID_AR: 12 } } as any;
    expect(await syncNewsletter(ctx, fake as any)).toBe(0); // Brevo down: nothing marked, retried next run
    down = false;
    expect(await syncNewsletter(ctx, fake as any)).toBe(2);
    const last = calls.slice(-2);
    expect(last.find((c) => c.body.email === en.user.email)!.body).toMatchObject({ listIds: [11], unlinkListIds: [12], updateEnabled: true });
    expect(last.find((c) => c.body.email === ar.user.email)!.body).toMatchObject({ listIds: [12], unlinkListIds: [11] });
    expect(last[0]!.url).toBe('https://api.brevo.com/v3/contacts');
    expect(last[0]!.key).toBe('xkeysib-test');
    expect(await syncNewsletter(ctx, fake as any)).toBe(0); // nothing changed since
    await client(h.app, en.token).put('/v1/me/newsletter', { optIn: false });
    expect(await syncNewsletter(ctx, fake as any)).toBe(1);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { unlinkListIds: [11, 12] } });
    expect(calls.at(-1)!.url).toContain(encodeURIComponent(en.user.email));
    // Without a key: no calls.
    expect(await syncNewsletter(h.ctx, (async () => { throw new Error('called'); }) as any)).toBe(0);

    const marketing = await makeUser(h, { role: 'marketing' as any }); // newsletter.export (Round 23b)
    const csv = await marketing.api.get('/v1/admin/newsletter.csv');
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toMatch(/text\/csv/);
    expect(csv.body).toContain(ar.user.email);
    expect(csv.body).toContain('Newsletter AR');
    expect(csv.body).not.toContain(en.user.email); // opted out
    expect((await (await makeUser(h)).api.get('/v1/admin/newsletter.csv')).status).toBe(403);
  });
});

describe('6. Cloudflare Turnstile', () => {
  // Cloudflare's documented test secrets: 1x…AA always passes, 2x…AA always fails.
  const PASS = '1x0000000000000000000000000000000AA';
  const FAIL = '2x0000000000000000000000000000000AA';
  const DUMMY = 'XXXX.DUMMY.TOKEN.XXXX'; // what the test site keys hand the browser
  const siteverify = (async (_url: string, init: any) => {
    const form = new URLSearchParams(init.body);
    // The test token carries the action it was solved for: "XXXX.DUMMY.TOKEN.XXXX:signup".
    const action = String(form.get('response')).split(':')[1];
    return new Response(JSON.stringify({ success: form.get('secret') === PASS && !!form.get('response'), action, hostname: 'localhost' }));
  }) as any;

  it('TURNSTILE_SECRET switches the bot check on (every sign-in too) and is required in production and staging', () => {
    const cfg = loadConfig({ TURNSTILE_SECRET: PASS, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } as any);
    expect(cfg).toMatchObject({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SECRET: PASS, CAPTCHA_SITE_KEY: '1x00000000000000000000AA', CAPTCHA_AFTER_FAILED_LOGINS: 0 });
    expect(loadConfig({} as any)).toMatchObject({ CAPTCHA_PROVIDER: 'none', CAPTCHA_AFTER_FAILED_LOGINS: 3 });
    expect(() => loadConfig(prodEnv({ TURNSTILE_SECRET: '' }))).toThrow(/TURNSTILE_SECRET/);
    expect(() => loadConfig(prodEnv({ APP_ENV: 'staging', MALWARE_SCANNER: 'dev', TURNSTILE_SECRET: '' }))).toThrow(/TURNSTILE_SECRET/);
  });

  it('sign-up, sign-in and password reset need a valid token', async () => {
    const cfg = loadConfig({ TRUST_PROXY: 'true', RATE_LIMIT_PER_MINUTE: '100000', AUTH_RATE_LIMIT_PER_MINUTE: '100000', TURNSTILE_SECRET: PASS, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } as any);
    const mk = async (secret: string) => {
      const app = await buildApp(createContext(cfg, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), messenger: h.messenger, captcha: new SiteverifyCaptcha('turnstile', secret, siteverify) }));
      await app.ready();
      return app;
    };
    const ok = await mk(PASS);
    const bad = await mk(FAIL);
    try {
      const api = client(ok);
      expect((await api.get('/v1/auth/config')).body.captcha).toEqual({ provider: 'turnstile', siteKey: '1x00000000000000000000AA' });
      const creds = { email: `t${Date.now()}@example.com`, password: 'correct horse battery' };
      const signup = { ...creds, displayName: 'Turnstile', acceptTerms: true };
      expect((await api.post('/v1/auth/register', signup)).body.error.code).toBe('captcha_required');
      expect((await client(bad).post('/v1/auth/register', { ...signup, captchaToken: `${DUMMY}:signup` })).body.error.code).toBe('captcha_failed');
      expect((await api.post('/v1/auth/register', { ...signup, captchaToken: `${DUMMY}:signup` })).status).toBe(201);
      // Sign-in asks for it every time, not only after failures.
      expect((await api.post('/v1/auth/login', creds)).body.error.code).toBe('captcha_required');
      expect((await api.post('/v1/auth/login', { ...creds, captchaToken: `${DUMMY}:signin` })).status).toBe(200);
      expect((await api.post('/v1/auth/password/forgot', { email: creds.email })).body.error.code).toBe('captcha_required');
      expect((await api.post('/v1/auth/password/forgot', { email: creds.email, captchaToken: `${DUMMY}:reset` })).status).toBe(202);
    } finally {
      await ok.close();
      await bad.close();
    }
  });
});
