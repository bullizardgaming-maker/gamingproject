import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, totpAt, verifyTotp } from '../src/domain/mfa.js';
import { client, makeUser, setup, type Harness } from './helpers.js';

describe('TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 Appendix B (8-digit values; we use the last 6 digits).
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe('279037');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('allows one step of clock drift and rejects replays', () => {
    const secret = base32Encode(Buffer.alloc(20, 7));
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(secret, totpAt(secret, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), 0, now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull(); // already used
  });
});

describe('two-factor login', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup({ STAFF_MFA_REQUIRED: 'true' });
  });
  afterAll(async () => h.close());

  const codeFor = (secret: string, offset = 0) => totpAt(secret, currentStep() + offset);

  it('enrols, challenges at login, accepts recovery codes once, and can be turned off', async () => {
    const u = await makeUser(h, { tier: 1 });
    const setupRes = await u.api.post('/v1/me/2fa/setup');
    expect(setupRes.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Bullizard/);
    const secret: string = setupRes.body.secret;

    expect((await u.api.post('/v1/me/2fa/enable', { code: '000000' })).status).toBe(400);
    const enrolCode = codeFor(secret);
    const enabled = await u.api.post('/v1/me/2fa/enable', { code: enrolCode });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);

    // Password alone no longer yields a session.
    const login = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'correct horse battery' });
    expect(login.body).toMatchObject({ mfaRequired: true });
    expect(login.body.token).toBeUndefined();
    // The challenge token is not a session.
    expect((await client(h.app, login.body.mfaToken).get('/v1/me')).status).toBe(401);

    // The code used during enrolment can't be replayed (the exact code, even if a 30-second step has passed since).
    expect((await client(h.app).post('/v1/auth/mfa', { mfaToken: login.body.mfaToken, code: enrolCode })).status).toBe(401);
    const ok = await client(h.app).post('/v1/auth/mfa', { mfaToken: login.body.mfaToken, code: codeFor(secret, 1) });
    expect(ok.status).toBe(200);
    const status = await client(h.app, ok.body.token).get('/v1/me/2fa');
    expect(status.body).toMatchObject({ enabled: true, sessionVerified: true, recoveryCodesLeft: 10 });

    const recovery = enabled.body.recoveryCodes[0];
    const login2 = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'correct horse battery' });
    expect((await client(h.app).post('/v1/auth/mfa', { mfaToken: login2.body.mfaToken, code: recovery })).body.method).toBe('recovery');
    expect((await client(h.app).post('/v1/auth/mfa', { mfaToken: login2.body.mfaToken, code: recovery })).status).toBe(401);

    const session = client(h.app, ok.body.token);
    expect((await session.post('/v1/me/2fa/disable', { code: '123456' })).status).toBe(401);
    expect((await session.post('/v1/me/2fa/disable', { code: enabled.body.recoveryCodes[1] })).status).toBe(200);
    const plain = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'correct horse battery' });
    expect(plain.body.token).toBeTruthy();
  });

  it('requires a two-factor session for staff actions', async () => {
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const denied = await admin.api.get('/v1/admin/risk-flags');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('mfa_required');

    const { secret } = (await admin.api.post('/v1/me/2fa/setup')).body;
    const { token } = (await admin.api.post('/v1/me/2fa/enable', { code: codeFor(secret) })).body;
    expect((await client(h.app, token).get('/v1/admin/risk-flags')).status).toBe(200);
  });
});
