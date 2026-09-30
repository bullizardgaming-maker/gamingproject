import { SignJWT, jwtVerify } from 'jose';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { maybeOne, one } from '../db.js';
import { hashPassword, hmacSha256, randomDigits, safeEqual, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { withScope } from './events.js';
import { recordSignals, subnetOf } from './fraud.js';
import { accountId, post, sellerAvailable } from './ledger.js';
import { checkSecondFactor } from './mfa.js';
import { enqueueEmail } from './notifications.js';
import { activeSession, createSession, revokeOtherSessions, type IssuedSession } from './sessions.js';

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'arbiter' | 'admin';
  kyc_tier: number;
  status: 'active' | 'suspended';
  email_verified_at: string | null;
  phone: string | null;
  phone_verified_at: string | null;
  withdrawals_frozen: boolean;
  stripe_account_id: string | null;
  legal_name: string | null;
  created_at: string;
  totp_enabled: boolean;
  payouts_enabled: boolean;
  /** True when the current session was established with a second factor. */
  session_mfa?: boolean;
  session_id?: string;
  session_family?: string;
}

export const PUBLIC_USER_COLUMNS =
  'id, email, display_name, role, kyc_tier, status, email_verified_at, phone, phone_verified_at, withdrawals_frozen, stripe_account_id, legal_name, created_at, (totp_enabled_at IS NOT NULL) AS totp_enabled, payouts_enabled';

// ---------------------------------------------------------------------------
// Authentication. Sessions live in ./sessions.ts (15-minute access tokens +
// rotating refresh tokens). The user row and session are re-read on every
// request, so suspensions, tier changes and sign-outs apply immediately.
// ---------------------------------------------------------------------------

/** Short-lived token proving the password step passed; only exchangeable for a session via /auth/mfa. */
async function issueChallenge(ctx: Ctx, userId: string): Promise<string> {
  return new SignJWT({ purpose: 'mfa_challenge' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(ctx.cfg.JWT_SECRET));
}

async function verifyJwt(ctx: Ctx, token: string, purpose: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(ctx.cfg.JWT_SECRET), { algorithms: ['HS256'] });
  if (payload.purpose !== purpose) throw new Error('wrong token purpose');
  return payload;
}

export async function userFromToken(ctx: Ctx, token: string): Promise<User> {
  try {
    const payload = await verifyJwt(ctx, token, 'session');
    const session = await activeSession(ctx.db, String(payload.sid));
    if (!session || session.user_id !== payload.sub) throw new Error('session revoked');
    const user = await maybeOne<User>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [payload.sub]);
    if (!user) throw new Error('unknown user');
    return { ...user, session_mfa: session.mfa, session_id: session.id, session_family: session.family_id };
  } catch {
    throw unauthorized('Invalid or expired session');
  }
}

export interface AuthMeta {
  ip?: string;
  device?: string;
  userAgent?: string;
}

function sessionResponse(user: User, s: IssuedSession) {
  // `token` is the access token (kept under this name for API compatibility).
  return { user, token: s.accessToken, refreshToken: s.refreshToken, expiresIn: s.expiresIn };
}

export async function register(ctx: Ctx, input: { email: string; password: string; displayName: string } & AuthMeta) {
  const hash = await hashPassword(input.password);
  try {
    const user = await one<User>(
      ctx.db,
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING ${PUBLIC_USER_COLUMNS}`,
      [input.email, hash, input.displayName],
    );
    await recordSignals(ctx.db, user.id, { device: input.device, ip_subnet: subnetOf(input.ip) });
    return sessionResponse(user, await createSession(ctx, user.id, { mfa: false, userAgent: input.userAgent, ip: input.ip }));
  } catch (err: any) {
    if (err.code === '23505') throw conflict('email_taken', 'An account with this email already exists');
    throw err;
  }
}

/** Email the user when a sign-in comes from a device we haven't seen on this account. */
async function noteSignIn(ctx: Ctx, userId: string, meta: AuthMeta) {
  if (meta.device) {
    const known = await maybeOne(ctx.db, `SELECT 1 FROM risk_signals WHERE user_id = $1 AND kind = 'device' AND value = $2`, [userId, meta.device]);
    if (!known) await enqueueEmail(ctx.db, userId, 'new_signin', { userAgent: meta.userAgent, ip: meta.ip, at: new Date().toISOString() });
  }
  await recordSignals(ctx.db, userId, { device: meta.device, ip_subnet: subnetOf(meta.ip) });
}

export async function login(ctx: Ctx, input: { email: string; password: string } & AuthMeta) {
  const row = await maybeOne<User & { password_hash: string }>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users WHERE email = $1`, [input.email]);
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = await verifyPassword(input.password, row?.password_hash ?? 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!row || !ok) throw unauthorized('Invalid email or password');
  const { password_hash: _, ...user } = row;
  if (user.totp_enabled) return { mfaRequired: true as const, mfaToken: await issueChallenge(ctx, user.id) };
  await noteSignIn(ctx, user.id, input);
  return sessionResponse(user, await createSession(ctx, user.id, { mfa: false, userAgent: input.userAgent, ip: input.ip }));
}

/** Second login step: exchange the challenge token plus a TOTP or recovery code for a session. */
export async function completeMfaLogin(ctx: Ctx, mfaToken: string, code: string, meta: AuthMeta = {}) {
  let userId: string;
  try {
    userId = String((await verifyJwt(ctx, mfaToken, 'mfa_challenge')).sub);
  } catch {
    throw unauthorized('Sign-in expired. Enter your password again.');
  }
  const method = await checkSecondFactor(ctx, userId, code);
  await noteSignIn(ctx, userId, meta);
  const user = await one<User>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return { ...sessionResponse(user, await createSession(ctx, userId, { mfa: true, userAgent: meta.userAgent, ip: meta.ip })), method };
}

/** Change password: signs out every other device and emails the user. */
export async function changePassword(ctx: Ctx, user: User, current: string, next: string) {
  const row = await one<{ password_hash: string }>(ctx.db, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!(await verifyPassword(current, row.password_hash))) throw unauthorized('Current password is incorrect');
  if (current === next) throw badRequest('same_password', 'Choose a password you have not used here before');
  const hash = await hashPassword(next);
  return withScope(ctx, async (s) => {
    await s.tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hash]);
    const signedOut = await revokeOtherSessions(s.tx, user.id, user.session_family ?? null, 'password_changed');
    await enqueueEmail(s.tx, user.id, 'password_changed', {});
    return { signedOutDevices: signedOut };
  });
}

// ---------------------------------------------------------------------------
// Tier 1: verified email + SMS OTP
// ---------------------------------------------------------------------------
const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

export async function sendVerificationCode(ctx: Ctx, user: User, channel: 'email' | 'sms', phone?: string) {
  const target = channel === 'email' ? user.email : phone;
  if (!target) throw badRequest('phone_required', 'Phone number is required');
  if (channel === 'sms' && !/^\+[1-9]\d{7,14}$/.test(target)) throw badRequest('invalid_phone', 'Phone must be in E.164 format, e.g. +14155550123');
  const recent = await one<{ n: number }>(
    ctx.db,
    `SELECT count(*)::int AS n FROM verification_codes WHERE user_id = $1 AND channel = $2 AND created_at > now() - interval '1 hour'`,
    [user.id, channel],
  );
  if (recent.n >= 5) throw new AppError(429, 'too_many_codes', 'Too many verification codes requested; try again later');
  const code = randomDigits(6);
  await ctx.db.query(
    `INSERT INTO verification_codes (user_id, channel, target, code_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [user.id, channel, target, hmacSha256(ctx.cfg.FINGERPRINT_KEY, `${user.id}:${channel}:${code}`), CODE_TTL_MINUTES],
  );
  await ctx.messenger.send({ channel, to: target, body: `Your verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.` });
  return { sent: true, target };
}

export async function confirmVerificationCode(ctx: Ctx, user: User, channel: 'email' | 'sms', code: string) {
  return withScope(ctx, async (s) => {
    const row = await maybeOne(
      s.tx,
      `SELECT * FROM verification_codes WHERE user_id = $1 AND channel = $2 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id, channel],
    );
    if (!row || row.attempts >= MAX_CODE_ATTEMPTS) throw badRequest('code_expired', 'No valid code; request a new one');
    const expected = hmacSha256(ctx.cfg.FINGERPRINT_KEY, `${user.id}:${channel}:${code}`);
    if (!safeEqual(expected, row.code_hash)) {
      await s.tx.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      throw badRequest('invalid_code', 'Incorrect code');
    }
    await s.tx.query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
    if (channel === 'email') await s.tx.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
    else await s.tx.query('UPDATE users SET phone = $2, phone_verified_at = now() WHERE id = $1', [user.id, row.target]);
    await s.tx.query(
      `UPDATE users SET kyc_tier = GREATEST(kyc_tier, 1) WHERE id = $1 AND email_verified_at IS NOT NULL AND phone_verified_at IS NOT NULL`,
      [user.id],
    );
    return one<User>(s.tx, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [user.id]);
  });
}

// ---------------------------------------------------------------------------
// Tier 2: government ID + biometric liveness via the KYC provider
// ---------------------------------------------------------------------------
export async function startKyc(ctx: Ctx, user: User, level: 'tier2_individual' | 'tier2_business') {
  if (user.kyc_tier < 1) throw badRequest('tier1_required', 'Complete email and phone verification first');
  if (user.kyc_tier >= 2) throw conflict('already_verified', 'Identity already verified');
  const session = await ctx.kyc.startVerification({ id: user.id, email: user.email }, level);
  await ctx.db.query(
    `INSERT INTO kyc_verifications (user_id, provider, external_id, level) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [user.id, ctx.kyc.name, session.externalId, level],
  );
  return session;
}

export async function applyKycResult(ctx: Ctx, result: { externalId: string; status: string; legalName?: string; raw: unknown }) {
  return withScope(ctx, async (s) => {
    const v = await maybeOne(s.tx, 'SELECT * FROM kyc_verifications WHERE provider = $1 AND external_id = $2 FOR UPDATE', [ctx.kyc.name, result.externalId]);
    if (!v) return null;
    await s.tx.query('UPDATE kyc_verifications SET status = $2, result = $3, updated_at = now() WHERE id = $1', [v.id, result.status, JSON.stringify(result.raw ?? {})]);
    if (result.status === 'approved') {
      await s.tx.query('UPDATE users SET kyc_tier = 2, legal_name = COALESCE($2, legal_name) WHERE id = $1', [v.user_id, result.legalName ?? null]);
      await enqueueEmail(s.tx, v.user_id, 'kyc_result', { approved: true });
      s.notifyUser(v.user_id, 'kyc.approved', {});
    } else if (result.status === 'rejected') {
      await enqueueEmail(s.tx, v.user_id, 'kyc_result', { approved: false });
      s.notifyUser(v.user_id, 'kyc.rejected', {});
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Withdrawals (Tier 2 only)
// ---------------------------------------------------------------------------
export async function requestWithdrawal(ctx: Ctx, userId: string, amountCents: number, currency = 'USD') {
  const w = await withScope(ctx, async (s) => {
    // Lock the user row to serialize concurrent withdrawals against the same balance.
    const user = await one<User>(s.tx, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (user.kyc_tier < 2) throw new AppError(403, 'kyc_required', 'Tier 2 identity verification is required to withdraw');
    if (user.withdrawals_frozen || user.status !== 'active') throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are frozen pending a security review');
    if (!user.stripe_account_id || !user.payouts_enabled) throw badRequest('no_payout_account', 'Set up your payout account first');
    const available = await sellerAvailable(s.tx, userId, currency);
    if (amountCents > available) throw badRequest('insufficient_funds', `Available balance is ${available} cents`);
    const w = await one(s.tx, 'INSERT INTO withdrawals (user_id, amount_cents, currency) VALUES ($1, $2, $3) RETURNING *', [userId, amountCents, currency]);
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'seller_available', currency, userId), amountCents: -amountCents },
        { account: await accountId(s.tx, 'payouts', currency), amountCents },
      ],
      `withdrawal:${w.id}`,
    );
    return { ...w, destination: user.stripe_account_id };
  });

  try {
    const { ref } = await ctx.payments.payout(w.destination, amountCents, currency, `withdrawal_${w.id}`);
    const paid = await one(ctx.db, `UPDATE withdrawals SET status = 'paid', provider_ref = $2 WHERE id = $1 RETURNING *`, [w.id, ref]);
    await enqueueEmail(ctx.db, userId, 'withdrawal_paid', { amount_cents: amountCents, currency, provider_ref: ref });
    return paid;
  } catch (err) {
    // Payout failed: return the funds to the seller's balance.
    await withScope(ctx, async (s) => {
      await s.tx.query(`UPDATE withdrawals SET status = 'failed' WHERE id = $1`, [w.id]);
      await post(
        s.tx,
        [
          { account: await accountId(s.tx, 'payouts', currency), amountCents: -amountCents },
          { account: await accountId(s.tx, 'seller_available', currency, userId), amountCents },
        ],
        `withdrawal_failed:${w.id}`,
      );
    });
    throw err;
  }
}

export async function getUser(q: Queryable, id: string) {
  return maybeOne<User>(q, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}
