import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/domain/permissions.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const status = async (u: { api: any }, method: 'get' | 'post', path: string, body?: unknown) => (await (method === 'get' ? u.api.get(path) : u.api.post(path, body ?? {}))).status;

describe('staff roles', () => {
  it('gives each role only what it needs', async () => {
    const [finance, support, compliance, arbiter] = await Promise.all(
      (['finance', 'support', 'compliance', 'arbiter'] as const).map((role) => makeUser(h, { tier: 2, role })),
    );
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1 });
    const order = await buyAndPay(h, buyer, offer.id);

    // Finance moves money, but can't suspend people or rule on disputes.
    expect(await status(finance, 'get', '/v1/admin/treasury')).toBe(200);
    expect(await status(finance, 'get', '/v1/admin/tax/rates')).toBe(200);
    expect(await status(finance, 'post', `/v1/admin/users/${seller.id}/suspend`, { reason: 'test' })).toBe(403);
    expect(await status(finance, 'get', '/v1/admin/disputes')).toBe(403);
    expect(await status(finance, 'get', `/v1/orders/${order.id}`)).toBe(404); // can't read other people's orders

    // Support can look (audited) but not touch money.
    expect(await status(support, 'get', `/v1/orders/${order.id}`)).toBe(200);
    expect(await status(support, 'get', `/v1/admin/users/${seller.id}/ledger`)).toBe(200);
    expect(await status(support, 'get', '/v1/admin/treasury')).toBe(403);
    const denied = await support.api.post('/v1/admin/ledger/adjustments', { reason: 'x'.repeat(12), lines: [] });
    expect(denied.body.error).toMatchObject({ code: 'insufficient_permission', message: 'Missing permission ledger.adjust' });

    // Compliance investigates and can suspend, but can't pay anyone.
    expect(await status(compliance, 'get', '/v1/admin/risk-flags')).toBe(200);
    expect(await status(compliance, 'get', '/v1/admin/audit')).toBe(200);
    expect(await status(compliance, 'post', '/v1/admin/treasury/withdrawals', { amountCents: 1, note: 'nope' })).toBe(403);

    // Arbiters rule on disputes only.
    expect(await status(arbiter, 'get', '/v1/admin/disputes')).toBe(200);
    expect(await status(arbiter, 'get', '/v1/admin/chargebacks')).toBe(403);

    expect((await support.api.get('/v1/me/permissions')).body.permissions).toEqual([...ROLE_PERMISSIONS.support].sort());
    expect((await buyer.api.get('/v1/me/permissions')).body.permissions).toEqual([]);
    const { rows } = await h.ctx.db.query(`SELECT actor_role FROM admin_audit_log WHERE actor_id = $1 AND action = 'order.viewed'`, [support.id]);
    expect(rows[0].actor_role).toBe('support');
  });

  it('lets admins grant several roles, with guardrails, effective immediately', async () => {
    await h.ctx.db.query(`UPDATE users SET role = 'user' WHERE role = 'admin'`); // start from a known state
    const admin = await makeUser(h, { role: 'admin' });
    const staffer = await makeUser(h, { tier: 2 });
    expect(await status(staffer, 'get', '/v1/admin/treasury')).toBe(403);

    const res = await admin.api.put(`/v1/admin/staff/${staffer.id}`, { roles: ['support', 'finance'], reason: 'Joined finance ops' });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual(expect.arrayContaining(['orders.view_any', 'treasury.request', 'ledger.adjust']));
    expect(await status(staffer, 'get', '/v1/admin/treasury')).toBe(200); // same session, no re-login
    expect((await staffer.api.get('/v1/me/notifications')).body.items[0].template).toBe('staff_roles_changed');

    expect((await admin.api.put(`/v1/admin/staff/${admin.id}`, { roles: [], reason: 'leaving' })).body.error.code).toBe('self_change');
    // Hand over: promote the staffer to admin, who then moves the original admin to finance.
    await admin.api.put(`/v1/admin/staff/${staffer.id}`, { roles: ['admin'], reason: 'Backup admin' });
    expect((await staffer.api.put(`/v1/admin/staff/${admin.id}`, { roles: ['finance'], reason: 'Role change' })).status).toBe(200);
    expect((await admin.api.put(`/v1/admin/staff/${staffer.id}`, { roles: [], reason: 'try' })).status).toBe(403); // admin is finance now
    const list = (await staffer.api.get('/v1/admin/staff')).body;
    expect(list.find((u: any) => u.id === admin.id)).toMatchObject({ role: 'finance', staff_roles: [] });
    const audit = (await staffer.api.get('/v1/admin/audit?action=staff.roles_changed')).body;
    expect(JSON.stringify(audit)).toContain('Backup admin');
  });

  it('every permission belongs to at least one non-admin role or is admin-only on purpose', () => {
    const covered = new Set(Object.entries(ROLE_PERMISSIONS).filter(([r]) => r !== 'admin').flatMap(([, p]) => p));
    const adminOnly = PERMISSIONS.filter((p) => !covered.has(p));
    expect(adminOnly.sort()).toEqual(['keys.manage', 'staff.manage']);
  });
});
