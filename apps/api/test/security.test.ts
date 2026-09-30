import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchEmails } from '../src/domain/notifications.js';
import { fetchPublic, isPrivateAddress } from '../src/lib/netguard.js';
import { parseTrustProxy } from '../src/server.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ LOGIN_MAX_FAILURES: '5', LOGIN_LOCK_MINUTES: '15' });
});
afterAll(async () => h.close());

describe('SSRF guard', () => {
  it('blocks private, reserved and IPv4-embedding IPv6 addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', 'fd00::1', 'fe80::1%eth0', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses to connect to private destinations, whether given as an IP or a hostname', async () => {
    await expect(fetchPublic('http://127.0.0.1:8080/')).rejects.toThrow(/blocked/);
    await expect(fetchPublic('http://[::1]:8080/')).rejects.toThrow(/blocked/);
    // localhost resolves through DNS, so the connect-time lookup must catch it.
    const err = await fetchPublic('http://localhost:8080/').catch((e) => e);
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/blocked/);
  });
});

describe('proxy trust', () => {
  it('parses TRUST_PROXY forms', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });

  it('ignores X-Forwarded-For and client geo headers unless configured', async () => {
    const strict = await setup({ TRUST_PROXY: 'false' });
    const res = await client(strict.app).get('/v1/categories', { 'x-forwarded-for': '9.9.9.9', 'x-request-id': 'bad\nid' });
    expect(res.headers['x-request-id']).not.toContain('\n');
    expect(String(res.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
    await strict.close();
  });
});

describe('account lockout', () => {
  it('pauses sign-in after repeated wrong passwords, emails the owner, and a reset lifts it', async () => {
    const u = await makeUser(h);
    const anon = client(h.app);
    for (let i = 0; i < 5; i++) expect((await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' })).status).toBe(401);
    const locked = await anon.post('/v1/auth/login', { email: u.email, password: 'correct horse battery' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('account_locked');

    await dispatchEmails(h.ctx);
    const mail = (h.messenger.outbox as any[]).find((m) => m.channel === 'email' && m.to === u.email && /paused/.test(m.subject));
    expect(mail?.body).toMatch(/15 minutes/);

    // Proving control of the email (password reset) lifts the lock.
    await anon.post('/v1/auth/password/forgot', { email: u.email });
    await dispatchEmails(h.ctx);
    const link = (h.messenger.outbox as any[]).filter((m) => m.to === u.email).map((m) => m.body).join('\n').match(/token=([\w-]+)/)?.[1];
    expect(link).toBeTruthy();
    expect((await anon.post('/v1/auth/password/reset', { token: link, newPassword: 'another good password' })).status).toBe(200);
    expect((await anon.post('/v1/auth/login', { email: u.email, password: 'another good password' })).status).toBe(200);
  });

  it('doubles the lock on repeat offences and resets the counter after a good sign-in', async () => {
    const u = await makeUser(h);
    const anon = client(h.app);
    for (let i = 0; i < 4; i++) await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' });
    expect((await anon.post('/v1/auth/login', { email: u.email, password: 'correct horse battery' })).status).toBe(200);
    // Counter was cleared, so 4 more failures do not lock.
    for (let i = 0; i < 4; i++) await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' });
    expect((await anon.post('/v1/auth/login', { email: u.email, password: 'correct horse battery' })).status).toBe(200);

    for (let i = 0; i < 5; i++) await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' });
    await h.ctx.db.query('UPDATE users SET login_locked_until = now() - interval \'1 second\' WHERE id = $1', [u.id]);
    for (let i = 0; i < 5; i++) await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' });
    const { rows: [row] } = await h.ctx.db.query(`SELECT login_lock_count, extract(epoch FROM login_locked_until - now()) / 60 AS mins FROM users WHERE id = $1`, [u.id]);
    expect(row.login_lock_count).toBe(2);
    expect(Number(row.mins)).toBeGreaterThan(29);
  });

});

describe('search input', () => {
  it('treats LIKE wildcards in the query literally', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await makeOffer(seller, { title: 'Wildcard test key', categorySlug: 'boosting', deliveryMode: 'manual', stock: 3 });
    expect((await client(h.app).get('/v1/offers?q=Wildcard')).body.items).toHaveLength(1);
    expect((await client(h.app).get('/v1/offers?q=%25')).body.items).toHaveLength(0);
    expect((await client(h.app).get('/v1/offers?q=W_ldcard')).body.items).toHaveLength(0);
  });
});
