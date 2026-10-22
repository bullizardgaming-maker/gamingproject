import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enforceIdDeadlines } from '../src/domain/onboarding.js';
import { client, makeOffer, makeUser, mockKyc, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('seller onboarding', () => {
  it('gates the first listing on Tier 1 and a passed rules test, with staff-editable questions', async () => {
    const u = await makeUser(h, { tier: 1 });
    const listing = { categorySlug: 'currency', game: 'Albion Online', title: '5M silver', priceCents: 5_00, deliveryMode: 'manual', stock: 5, attributes: { server: 'Europe' } };
    expect((await u.api.post('/v1/offers', listing)).body.error.code).toBe('rules_test_required');

    const test = (await u.api.get('/v1/seller/rules-test')).body;
    expect(test.passMarkPct).toBe(100);
    expect(test.questions.length).toBeGreaterThanOrEqual(6);
    expect(test.questions[0]).not.toHaveProperty('correct');
    expect(test.passedAt).toBeNull();

    // Wrong answers: failed, with explanations for the misses, and the gate stays.
    const wrong = Object.fromEntries(test.questions.map((q: any) => [q.id, 0]));
    const failed = (await u.api.post('/v1/seller/rules-test', { answers: wrong })).body;
    expect(failed.passed).toBe(false);
    expect(failed.results.filter((r: any) => !r.correct).every((r: any) => typeof r.explanation === 'string' && r.explanation.length > 10)).toBe(true);
    expect((await u.api.post('/v1/offers', listing)).body.error.code).toBe('rules_test_required');

    // Staff see the answers, and can edit the test (an unlisted question retires).
    const support = await makeUser(h, { role: 'support' });
    const admin = (await support.api.get('/v1/admin/rules-test')).body;
    const right = Object.fromEntries(admin.questions.filter((q: any) => q.active).map((q: any) => [q.id, q.correct]));
    const passed = (await u.api.post('/v1/seller/rules-test', { answers: right })).body;
    expect(passed).toMatchObject({ passed: true, scorePct: 100 });
    expect((await u.api.get('/v1/seller/rules-test')).body.attempts).toBe(2);
    const created = await u.api.post('/v1/offers', listing);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await u.api.get('/v1/seller/onboarding')).body).toMatchObject({ tier1: true, identityVerified: false, canSell: true, idDueDays: 30 });
    expect((await u.api.get('/v1/seller/onboarding')).body.idDueAt).toBeTruthy();

    const edited = admin.questions.slice(0, 3).map((q: any, i: number) => ({ ...q, position: i + 1 }));
    edited.push({ position: 4, question: 'Can you ask a buyer for their password?', options: ['Yes', 'No, never'], correct: 1, explanation: 'Never ask for credentials.' });
    const put = await support.api.put('/v1/admin/rules-test', { questions: edited, settings: { passMarkPct: 75 } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.settings.passMarkPct).toBe(75);
    expect(put.body.questions.filter((q: any) => q.active)).toHaveLength(4);
    expect((await client(h.app).get('/v1/seller/rules-test')).status).toBe(401);
    expect((await (await makeUser(h, { tier: 1 })).api.get('/v1/seller/rules-test')).body.questions).toHaveLength(4);
    expect((await support.api.put('/v1/admin/rules-test', { questions: [{ position: 1, question: 'Broken question here', options: ['A', 'B'], correct: 5 }] })).body.error.code).toBe('invalid_question');
  });

  it('reminds, then restricts a seller who has not verified their identity in time, and lifts it on approval', async () => {
    const s = await makeUser(h, { tier: 1, rulesPassed: true });
    const offer = await makeOffer(s, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 } as any);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).status).toBe(200);
    const sent = async () => (await s.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template);

    // Day 24: first reminder. Day 29: last reminder. Day 31: restricted.
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '24 days' WHERE id = $1`, [s.id]);
    expect(await enforceIdDeadlines(h.ctx)).toMatchObject({ reminded: 1, restricted: 0 });
    expect(await enforceIdDeadlines(h.ctx)).toMatchObject({ reminded: 0, restricted: 0 }); // once
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '29 days' WHERE id = $1`, [s.id]);
    expect(await enforceIdDeadlines(h.ctx)).toMatchObject({ reminded: 1, restricted: 0 });
    expect((await sent()).filter((t: string) => t === 'id_reminder')).toHaveLength(2);
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '31 days' WHERE id = $1`, [s.id]);
    expect(await enforceIdDeadlines(h.ctx)).toMatchObject({ restricted: 1 });
    expect(await sent()).toContain('id_overdue');
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.status).toBe('paused');
    expect((await s.api.post('/v1/offers', { categorySlug: 'currency', game: 'Test Game', title: 'More', priceCents: 5_00, deliveryMode: 'manual', stock: 1 })).body.error.code).toBe('kyc_overdue');
    expect((await s.api.get('/v1/seller/dashboard')).body.onboarding).toMatchObject({ canSell: false, identityVerified: false });
    expect((await s.api.post('/v1/seller/withdrawals', { amountCents: 100 })).body.error.code).toBe('kyc_required');

    // Verified: back in business, listing included.
    const start = await s.api.post('/v1/kyc/start', { level: 'tier2_individual' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const payload = JSON.stringify({ externalId: start.body.externalId, status: 'approved', legalName: 'Seller Person' });
    expect((await client(h.app).post('/v1/kyc/webhook/mock', payload, { 'content-type': 'application/json', 'x-mock-signature': mockKyc(h).sign(payload) })).status).toBe(200);
    expect((await s.api.get('/v1/me')).body.user.kyc_tier).toBe(2);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.status).toBe('active');
    expect((await s.api.get('/v1/seller/onboarding')).body).toMatchObject({ canSell: true, identityVerified: true, idDueAt: null, sellingRestrictedAt: null });
  });
});
