import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchEmails, render } from '../src/domain/notifications.js';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const BODY = { 'x-token-delivery': 'body' };
const PASSWORD = 'correct horse battery';

async function signIn(email: string, headers: Record<string, string> = {}) {
  const res = await client(h.app, undefined, { ...BODY, ...headers }).post('/v1/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body as { token: string; refreshToken: string; expiresIn: number };
}
const refresh = (refreshToken: string) => client(h.app, undefined, BODY).post('/v1/auth/refresh', { refreshToken });
const emailsTo = async (email: string) => {
  await dispatchEmails(h.ctx);
  return (h.messenger.outbox as any[]).filter((m) => m.channel === 'email' && m.to === email);
};

describe('sessions and refresh tokens', () => {
  it('issues 15-minute access tokens and rotates refresh tokens', async () => {
    const u = await makeUser(h, { tier: 1 });
    const s = await signIn(u.email);
    expect(s.expiresIn).toBe(900);
    expect(s.refreshToken).toMatch(/^rt_/);

    const r1 = await refresh(s.refreshToken);
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    expect((await client(h.app, r1.body.token).get('/v1/me')).status).toBe(200);
    const r2 = await refresh(r1.body.refreshToken);
    expect(r2.status).toBe(200);
  });

  it('treats a replayed refresh token as theft: signs out that device and emails the user', async () => {
    const u = await makeUser(h, { tier: 1 });
    const s = await signIn(u.email);
    const r1 = await refresh(s.refreshToken);

    // Immediate duplicate (two tabs) is tolerated with a retryable 409...
    expect((await refresh(s.refreshToken)).status).toBe(409);
    // ...but a replay after the grace window revokes the whole family.
    await h.ctx.db.query(`UPDATE sessions SET rotated_at = now() - interval '1 minute' WHERE rotated_at IS NOT NULL AND user_id = $1`, [u.id]);
    expect((await refresh(s.refreshToken)).status).toBe(401);
    expect((await refresh(r1.body.refreshToken)).status).toBe(401);
    expect((await client(h.app, r1.body.token).get('/v1/me')).status).toBe(401);
    expect((await emailsTo(u.email)).some((m) => m.subject.includes('signed out a device'))).toBe(true);
  });

  it('signs out immediately, including the access token', async () => {
    const u = await makeUser(h, { tier: 1 });
    const s = await signIn(u.email);
    const api = client(h.app, s.token);
    expect((await api.post('/v1/auth/logout', { refreshToken: s.refreshToken })).status).toBe(204);
    expect((await api.get('/v1/me')).status).toBe(401);
    expect((await refresh(s.refreshToken)).status).toBe(401);
  });

  it('uses an httpOnly SameSite=Strict cookie for browsers', async () => {
    const u = await makeUser(h, { tier: 1 });
    const res = await client(h.app).post('/v1/auth/login', { email: u.email, password: PASSWORD });
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/bz_rt=rt_/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
    const r = await client(h.app, undefined, { cookie: cookie.split(';')[0]! }).post('/v1/auth/refresh');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
  });

  it('lists devices, signs out others, and password change revokes other sessions', async () => {
    const u = await makeUser(h, { tier: 1 });
    const a = await signIn(u.email, { 'user-agent': 'Laptop Chrome' });
    const b = await signIn(u.email, { 'user-agent': 'Phone Safari' });
    const apiA = client(h.app, a.token);
    const devices = (await apiA.get('/v1/me/sessions')).body;
    // makeUser's registration session + the two sign-ins
    expect(devices.length).toBe(3);
    expect(devices.filter((d: any) => d.current)).toHaveLength(1);

    const phone = devices.find((d: any) => d.userAgent === 'Phone Safari');
    expect((await apiA.del(`/v1/me/sessions/${phone.id}`)).status).toBe(204);
    expect((await client(h.app, b.token).get('/v1/me')).status).toBe(401);

    expect((await apiA.post('/v1/me/password', { currentPassword: 'wrong-password', newPassword: 'another good password' })).status).toBe(401);
    const changed = await apiA.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'another good password' });
    expect(changed.body.signedOutDevices).toBe(1); // the registration session
    expect((await apiA.get('/v1/me')).status).toBe(200); // this device stays signed in
    expect((await emailsTo(u.email)).some((m) => m.subject === 'Your password was changed')).toBe(true);
  });
});

describe('email notifications', () => {
  it('emails buyer and seller through the order lifecycle', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { title: 'Test Key', priceCents: 20_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'K1' });
    const order = await buyAndPay(h, buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    await runJobsOnce(h.ctx);

    const toBuyer = (await emailsTo(buyer.email)).map((m) => m.subject);
    const toSeller = (await emailsTo(seller.email)).map((m) => m.subject);
    expect(toBuyer).toEqual(expect.arrayContaining(['Payment received for Test Key', 'Delivered: Test Key']));
    expect(toSeller).toEqual(expect.arrayContaining(['Sold: Test Key', '$18.00 added to your balance']));
    const delivered = (await emailsTo(buyer.email)).find((m) => m.subject === 'Delivered: Test Key');
    expect(delivered.body).toContain(`/orders/${order.id}`);
    expect(delivered.html).toContain('<a href=');
  });

  it('sends one reminder 24h before auto-release, and respects opt-outs', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { title: 'Reminder Key' });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'R1\nR2' });
    const o1 = await buyAndPay(h, buyer, offer.id);
    await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() + interval '5 hours' WHERE id = $1`, [o1.id]);
    await runJobsOnce(h.ctx);
    await runJobsOnce(h.ctx);
    const reminders = (await emailsTo(buyer.email)).filter((m) => m.subject === '24 hours left to check Reminder Key');
    expect(reminders).toHaveLength(1);

    const prefs = await buyer.api.patch('/v1/me/email-preferences', { reminders: false });
    expect(prefs.body.find((p: any) => p.category === 'reminders').enabled).toBe(false);
    expect((await buyer.api.patch('/v1/me/email-preferences', { security: false })).status).toBe(400);
    const o2 = await buyAndPay(h, buyer, offer.id);
    await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() + interval '5 hours' WHERE id = $1`, [o2.id]);
    await runJobsOnce(h.ctx);
    const skipped = await h.ctx.db.query(`SELECT status FROM notifications WHERE dedupe_key = $1`, [`protection_ending:${o2.id}`]);
    expect(skipped.rows[0].status).toBe('skipped');
  });

  it('alerts on sign-in from a new device only', async () => {
    const u = await makeUser(h, { tier: 1, device: 'home-pc' });
    await signIn(u.email, { 'x-device-fingerprint': 'home-pc' });
    await signIn(u.email, { 'x-device-fingerprint': 'unknown-laptop', 'user-agent': 'Firefox' });
    const alerts = (await emailsTo(u.email)).filter((m) => m.subject === 'New sign-in to your Bullizard account');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain('Firefox');
  });

  it('escapes user content in HTML emails', () => {
    const msg = render(h.ctx, 'dispute_opened', { order_id: 'x', title: '<script>alert(1)</script>', reason: '"><img src=x>' });
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).not.toContain('<img');
  });
});
