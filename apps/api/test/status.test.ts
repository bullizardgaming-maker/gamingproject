import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearStatusCache, dispatchStatusEmails } from '../src/domain/status.js';
import { client, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const anon = () => client(h.app);
const status = async () => {
  clearStatusCache();
  return (await anon().get('/v1/status')).body;
};
const component = (s: any, id: string) => s.components.find((c: any) => c.id === id).status;
const lastEmailTo = (to: string) => [...(h.messenger.outbox as any[])].reverse().find((m) => m.to === to);

describe('public status page', () => {
  it('reports measured health without signing in', async () => {
    const s = await status();
    expect(s.status).toBe('operational');
    expect(s.components.map((c: any) => c.id)).toEqual(['website', 'checkout', 'delivery', 'chat', 'payouts', 'notifications']);

    // A worker job that stopped beating takes its component down.
    await h.ctx.db.query(`INSERT INTO worker_heartbeats (job, last_ok_at) VALUES ('auto_release', now() - interval '20 minutes') ON CONFLICT (job) DO UPDATE SET last_ok_at = EXCLUDED.last_ok_at`);
    let after = await status();
    expect(component(after, 'delivery')).toBe('major_outage');
    expect(after.status).toBe('major_outage');
    await h.ctx.db.query(`UPDATE worker_heartbeats SET last_ok_at = now() - interval '7 minutes' WHERE job = 'auto_release'`);
    expect(component(await status(), 'delivery')).toBe('degraded');
    await h.ctx.db.query(`UPDATE worker_heartbeats SET last_ok_at = now() WHERE job = 'auto_release'`);
    after = await status();
    expect(after.status).toBe('operational');
  });

  it('lets staff post incidents and maintenance that subscribers hear about', async () => {
    // Double opt-in subscription.
    const email = `watcher_${Date.now()}@example.com`;
    expect((await anon().post('/v1/status/subscribe', { email })).status).toBe(202);
    const confirm = /confirm=([\w-]+)/.exec(lastEmailTo(email).body)![1]!;
    expect((await anon().post('/v1/status/confirm', { token: 'x'.repeat(20) })).status).toBe(400);
    expect((await anon().post('/v1/status/confirm', { token: confirm })).body).toEqual({ confirmed: true });
    const sent = h.messenger.outbox.length;
    expect((await anon().post('/v1/status/subscribe', { email })).status).toBe(202); // same answer, no new email
    expect(h.messenger.outbox.length).toBe(sent);
    const unconfirmed = `lurker_${Date.now()}@example.com`;
    await anon().post('/v1/status/subscribe', { email: unconfirmed });

    const user = await makeUser(h, { tier: 1 });
    const arbiter = await makeUser(h, { role: 'arbiter' });
    const support = await makeUser(h, { role: 'support' });
    const incident = { title: 'Card checkout failing for some buyers', impact: 'major', components: ['checkout'], body: 'We are looking into failed card payments.' };
    expect((await user.api.post('/v1/admin/incidents', incident)).status).toBe(403);
    expect((await arbiter.api.post('/v1/admin/incidents', incident)).status).toBe(403);
    expect((await support.api.post('/v1/admin/incidents', { ...incident, components: ['nope'] })).body.error.code).toBe('unknown_component');

    const created = await support.api.post('/v1/admin/incidents', incident);
    expect(created.status).toBe(201);
    let s = await status();
    expect(component(s, 'checkout')).toBe('partial_outage');
    expect(s.incidents.map((i: any) => i.id)).toEqual([created.body.id]);
    expect(s.incidents[0].updates[0]).toMatchObject({ status: 'investigating', body: incident.body });

    // Only confirmed subscribers get it, with a working unsubscribe link.
    await dispatchStatusEmails(h.ctx);
    const mail = lastEmailTo(email);
    expect(mail.subject).toBe('[Investigating] Card checkout failing for some buyers');
    expect(mail.body).toContain('Affected: Card and crypto checkout');
    expect(lastEmailTo(unconfirmed).subject).toBe('Confirm Bullizard status updates');

    expect((await support.api.post(`/v1/admin/incidents/${created.body.id}/updates`, { status: 'scheduled', body: 'wrong kind' })).body.error.code).toBe('invalid_status');
    await support.api.post(`/v1/admin/incidents/${created.body.id}/updates`, { status: 'identified', body: 'A provider outage; failing over.', impact: 'minor' });
    expect(component(await status(), 'checkout')).toBe('degraded');
    const resolved = await support.api.post(`/v1/admin/incidents/${created.body.id}/updates`, { status: 'resolved', body: 'Payments are working again.' });
    expect(resolved.body.resolved_at).not.toBeNull();
    s = await status();
    expect(component(s, 'checkout')).toBe('operational');
    expect(s.recent[0]).toMatchObject({ id: created.body.id, status: 'resolved' });
    expect(s.recent[0].updates).toHaveLength(3);
    expect((await support.api.post(`/v1/admin/incidents/${created.body.id}/updates`, { status: 'monitoring', body: 'again' })).body.error.code).toBe('incident_closed');
    expect((await anon().get(`/v1/status/incidents/${created.body.id}`)).body.title).toBe(incident.title);

    // Planned maintenance shows as scheduled, then as maintenance while in progress.
    const start = new Date(Date.now() + 3_600_000).toISOString();
    const end = new Date(Date.now() + 7_200_000).toISOString();
    expect((await support.api.post('/v1/admin/incidents', { kind: 'maintenance', title: 'Database upgrade', components: ['payouts'], body: 'Payouts pause briefly.' })).body.error.code).toBe('invalid_schedule');
    const m = await support.api.post('/v1/admin/incidents', { kind: 'maintenance', title: 'Database upgrade', components: ['payouts'], body: 'Payouts pause briefly.', scheduledStart: start, scheduledEnd: end });
    expect(m.body).toMatchObject({ status: 'scheduled', impact: 'none' });
    s = await status();
    expect(component(s, 'payouts')).toBe('operational');
    expect(s.maintenance.map((i: any) => i.id)).toEqual([m.body.id]);
    await support.api.post(`/v1/admin/incidents/${m.body.id}/updates`, { status: 'in_progress', body: 'Started.' });
    expect(component(await status(), 'payouts')).toBe('maintenance');
    await support.api.post(`/v1/admin/incidents/${m.body.id}/updates`, { status: 'completed', body: 'Done.' });
    await dispatchStatusEmails(h.ctx);
    expect(lastEmailTo(email).subject).toBe('[Maintenance completed] Database upgrade');

    // Unsubscribe from the link in the email.
    const token = /unsubscribe=([\w.-]+)/.exec(lastEmailTo(email).body)![1]!;
    expect((await anon().post('/v1/status/unsubscribe', { token: `${token.split('.')[0]}.forged-signature-000000` })).status).toBe(400);
    expect((await anon().post('/v1/status/unsubscribe', { token })).body).toEqual({ unsubscribed: true });
    expect((await h.ctx.db.query('SELECT 1 FROM status_subscribers WHERE email = $1', [email])).rowCount).toBe(0);
    const audit = (await (await makeUser(h, { role: 'admin' })).api.get('/v1/admin/audit?action=status.incident_created')).body;
    expect(JSON.stringify(audit)).toContain('Card checkout failing');
  });
});
