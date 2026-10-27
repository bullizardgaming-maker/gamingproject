import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { assertUsdWithdrawal } from './cryptoPayouts.js';
import { PACKS, isLocale, type Locale } from './locales/index.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { maybeOne, one, withTx } from '../db.js';
import { hashPassword, hmacSha256, randomDigits, randomToken, safeEqual, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden } from '../lib/errors.js';
import { outranks, rolesOf } from './permissions.js';
import { liftIdRestriction } from './onboarding.js';
import { attributeBuyer, isAffiliateCode } from './affiliates.js';
import { assertNotPaused, assertWithdrawalWithinLimits } from './controls.js';
import { withScope } from './events.js';
import { recordSignals, subnetOf } from './fraud.js';
import { accountId, post, sellerAvailable } from './ledger.js';
import { checkSecondFactor } from './mfa.js';
import { withdrawable } from './payoutholds.js';
import { ensureScreenedForPayout, screenUser } from './aml.js';
import { recordAcceptance, tosVersion } from './legal.js';
import { referrerForCode } from './referrals.js';
import { renderCodeEmail, enqueueEmail } from './notifications.js';
import { activeSession, createSession, revokeOtherSessions, type IssuedSession } from './sessions.js';

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'arbiter' | 'support' | 'finance' | 'compliance' | 'admin';
  staff_roles: string[];
  kyc_tier: number;
  status: 'active' | 'suspended' | 'banned';
  suspended_until?: string | null;
  email_verified_at: string | null;
  phone: string | null;
  phone_verified_at: string | null;
  withdrawals_frozen: boolean;
  stripe_account_id: string | null;
  legal_name: string | null;
  created_at: string;
  totp_enabled: boolean;
  payouts_enabled: boolean;
  /** Character names / UIDs remembered per game (lower-case key) after the first order. */
  handover_names?: Record<string, string>;
  /** Seller onboarding (domain/onboarding.ts). */
  rules_passed_at?: string | null;
  selling_restricted_at?: string | null;
  seller_since?: string | null;
  /** Interface and message language (en, ar, es, fr, de, pt). */
  locale: string;
  /** Newsletter consent (Round 23a): unticked by default; the time of the current choice. */
  news_opt_in?: boolean;
  news_opt_in_at?: string | null;
  /** True when the current session was established with a second factor. */
  session_mfa?: boolean;
  session_id?: string;
  session_family?: string;
}

export const PUBLIC_USER_COLUMNS =
  'id, email, display_name, role, kyc_tier, status, email_verified_at, phone, phone_verified_at, withdrawals_frozen, stripe_account_id, legal_name, created_at, (totp_enabled_at IS NOT NULL) AS totp_enabled, payouts_enabled, staff_roles, locale, handover_names, rules_passed_at, selling_restricted_at, seller_since, listing_banned_at, suspended_until, news_opt_in, news_opt_in_at';

// ---------------------------------------------------------------------------
// Authentication. Sessions live in ./sessions.ts (15-minute access tokens +
// rotating refresh tokens). The user row and session are re-read on every
// request, so suspensions, tier changes and sign-outs apply immediately.
// ---------------------------------------------------------------------------

/** Short-lived token proving the password step passed; only exchangeable for a session via /auth/mfa. */
async function issueChallenge(ctx: Ctx, userId: string): Promise<string> {
  const jti = randomUUID();
  await ctx.db.query(`INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [jti, userId]);
  return new SignJWT({ purpose: 'mfa_challenge' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(ctx.cfg.JWT_SECRET));
}

/**
 * Round 23d (item 12): a challenge token is exchanged once, and not at all after a password reset issued later
 * (the row is deleted on use; resetPassword deletes every open challenge of the account).
 */
async function checkChallenge(ctx: Ctx, payload: { sub?: string; jti?: string }) {
  if (!payload.jti || !payload.sub) throw new Error('challenge without id');
  const r = await ctx.db.query(`SELECT 1 FROM mfa_challenges WHERE id = $1 AND user_id = $2 AND expires_at > now()`, [payload.jti, payload.sub]);
  if (!r.rowCount) throw new Error('challenge used or revoked');
  return { userId: payload.sub, jti: payload.jti };
}

async function verifyJwt(ctx: Ctx, token: string, purpose: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(ctx.cfg.JWT_SECRET), { algorithms: ['HS256'] });
  if (payload.purpose !== purpose) throw new Error('wrong token purpose');
  return payload;
}

/**
 * Round 23d/23e (item 3): the rank rule for every path that changes an account's status (suspend, ban, reinstate,
 * a confirmed risk flag, the chat penalty ladder): staff only act on accounts below their own rank, never on themselves.
 * `actor` may be a user id (loaded here) or a user with roles.
 */
export async function assertMayChangeStatus(q: Queryable, actor: string | { id: string; role: string; staff_roles?: string[] | null }, targetId: string) {
  const a = typeof actor === 'string' ? await maybeOne<{ id: string; role: string; staff_roles: string[] | null }>(q, 'SELECT id, role, staff_roles FROM users WHERE id = $1', [actor]) : actor;
  const target = await maybeOne<{ role: string; staff_roles: string[] | null }>(q, 'SELECT role, staff_roles FROM users WHERE id = $1', [targetId]);
  if (!target || !a) throw new AppError(404, 'not_found', 'User not found');
  if (targetId === a.id || !outranks(a, target)) throw forbidden('rank', 'You cannot suspend or ban an account at or above your own rank');
}

/**
 * Round 23d: a banned account cannot sign in or refresh; a suspended account with staff roles cannot either
 * (an ordinary suspended user still signs in to read their orders — every action checks `status`).
 */
export function assertMaySignIn(user: { status: string; suspended_until?: string | null; role: string; staff_roles?: string[] | null }) {
  if (user.status === 'banned') throw forbidden('banned', 'This account is banned');
  if (user.status === 'suspended' && rolesOf(user).length > 0) {
    const until = user.suspended_until ? new Date(user.suspended_until) : null;
    if (!until || until > new Date()) throw forbidden('suspended', 'This account is suspended');
  }
}

export async function userFromToken(ctx: Ctx, token: string): Promise<User> {
  try {
    const payload = await verifyJwt(ctx, token, 'session');
    const session = await activeSession(ctx.db, String(payload.sid));
    if (!session || session.user_id !== payload.sub) throw new Error('session revoked');
    const user = await maybeOne<User>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [payload.sub]);
    if (!user) throw new Error('unknown user');
    if (user.status === 'banned') throw new Error('banned');
    // A timed suspension lifts itself the moment it is over (the hourly job catches the rest).
    if (user.status === 'suspended' && user.suspended_until && new Date(user.suspended_until) <= new Date()) {
      await ctx.db.query(`UPDATE users SET status = 'active', suspended_until = NULL, suspension_reason = NULL WHERE id = $1 AND status = 'suspended' AND suspended_until <= now()`, [user.id]);
      user.status = 'active';
      user.suspended_until = null;
    }
    return { ...user, session_mfa: session.mfa, session_id: session.id, session_family: session.family_id };
  } catch {
    throw new AppError(401, 'session_expired', 'You were signed out. Sign in again.'); // Round 23f (§9.2)
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

export async function register(ctx: Ctx, input: { email: string; password: string; displayName: string; code?: string; referralCode?: string; creatorCode?: string; locale?: string; newsOptIn?: boolean } & AuthMeta) {
  await assertNotPaused(ctx.db, 'signups'); // kill switch (Ops → Controls)
  const hash = await hashPassword(input.password);
  // One code per user, entered at sign-up only (CEO, Oct 24): a friend's invite code or a creator code, whichever this is.
  const codes = [input.code, input.referralCode, input.creatorCode].filter((c): c is string => !!c?.trim());
  if (new Set(codes.map((c) => c.trim().toUpperCase())).size > 1) throw badRequest('one_code_only', 'Enter one code: a friend’s invite code or a creator code, not both');
  const code = codes[0]?.trim().toUpperCase();
  const creator = code ? await isAffiliateCode(ctx.db, code) : false;
  const referrer = code && !creator ? await referrerForCode(ctx.db, code) : null;
  const termsVersion = await tosVersion(ctx.db);
  try {
    const user = await one<User>(
      ctx.db,
      `INSERT INTO users (email, password_hash, display_name, referred_by, locale, tos_version, tos_accepted_at, news_opt_in, news_opt_in_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, CASE WHEN $7 THEN now() END) RETURNING ${PUBLIC_USER_COLUMNS}`,
      [input.email, hash, input.displayName, referrer, isLocale(input.locale) ? input.locale : 'en', termsVersion, input.newsOptIn === true],
    );
    await recordAcceptance(ctx.db, user.id, termsVersion, 'signup', input.ip ?? null); // Round 23d
    await recordSignals(ctx.db, user.id, { device: input.device, ip_subnet: subnetOf(input.ip) });
    await enqueueEmail(ctx.db, user.id, 'welcome', { name: input.displayName }, `welcome:${user.id}`);
    // A creator's code at signup (a wrong one is ignored rather than failing the signup).
    let applied: 'referral' | 'creator' | null = referrer ? 'referral' : null;
    if (code && creator) applied = (await attributeBuyer(ctx.db, user.id, code).then(() => 'creator' as const).catch(() => null));
    return { ...sessionResponse(user, await createSession(ctx, user.id, { mfa: false, userAgent: input.userAgent, ip: input.ip })), codeApplied: applied };
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

// ---------------------------------------------------------------------------
// Per-account lockout: LOGIN_MAX_FAILURES wrong passwords or 2FA codes pause sign-in for
// LOGIN_LOCK_MINUTES, doubling with each lock (capped at a day). Per-IP limits alone
// can be dodged by spreading guesses across many addresses.
// ---------------------------------------------------------------------------
export async function assertNotLocked(ctx: Ctx, userId: string) {
  const row = await maybeOne<{ until: string | null }>(ctx.db, 'SELECT login_locked_until AS until FROM users WHERE id = $1 AND login_locked_until > now()', [userId]);
  if (row) throw new AppError(429, 'account_locked', 'Too many failed sign-in attempts. Try again later or reset your password.', { retryAfter: row.until });
}

export async function noteFailedLogin(ctx: Ctx, userId: string) {
  const max = ctx.cfg.LOGIN_MAX_FAILURES;
  const row = await maybeOne<{ locked_minutes: number | null }>(
    ctx.db,
    `UPDATE users SET
        failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
        login_lock_count = login_lock_count + CASE WHEN failed_logins + 1 >= $2 THEN 1 ELSE 0 END,
        login_locked_until = CASE WHEN failed_logins + 1 >= $2
          THEN now() + make_interval(mins => LEAST($3 * 2 ^ login_lock_count, 1440)::int) ELSE login_locked_until END
      WHERE id = $1
      RETURNING CASE WHEN failed_logins = 0 THEN LEAST($3 * 2 ^ (login_lock_count - 1), 1440)::int END AS locked_minutes`,
    [userId, max, ctx.cfg.LOGIN_LOCK_MINUTES],
  );
  if (row?.locked_minutes) await enqueueEmail(ctx.db, userId, 'account_locked', { failures: max, minutes: row.locked_minutes });
}

export async function clearFailedLogins(q: Queryable, userId: string) {
  await q.query('UPDATE users SET failed_logins = 0, login_lock_count = 0, login_locked_until = NULL WHERE id = $1 AND (failed_logins > 0 OR login_lock_count > 0)', [userId]);
}

export async function login(ctx: Ctx, input: { email: string; password: string } & AuthMeta) {
  const row = await maybeOne<User & { password_hash: string }>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users WHERE email = $1 AND deleted_at IS NULL`, [input.email]);
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = await verifyPassword(input.password, row?.password_hash ?? 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (row) await assertNotLocked(ctx, row.id);
  if (row && !ok) await noteFailedLogin(ctx, row.id);
  if (!row || !ok) throw new AppError(401, 'invalid_credentials', 'Wrong email or password.'); // one message: never says which accounts exist
  const { password_hash: _, ...user } = row;
  assertMaySignIn(user);
  if (user.totp_enabled) return { mfaRequired: true as const, mfaToken: await issueChallenge(ctx, user.id) };
  await clearFailedLogins(ctx.db, user.id);
  await noteSignIn(ctx, user.id, input);
  return sessionResponse(user, await createSession(ctx, user.id, { mfa: false, userAgent: input.userAgent, ip: input.ip }));
}

/** Second login step: exchange the challenge token plus a TOTP or recovery code for a session. */
export async function completeMfaLogin(ctx: Ctx, mfaToken: string, code: string, meta: AuthMeta = {}) {
  let userId: string;
  let jti: string;
  try {
    ({ userId, jti } = await checkChallenge(ctx, await verifyJwt(ctx, mfaToken, 'mfa_challenge')));
  } catch {
    throw new AppError(401, 'reauth_required', 'Enter your password again to continue.');
  }
  await assertNotLocked(ctx, userId);
  let method: Awaited<ReturnType<typeof checkSecondFactor>>;
  try {
    method = await checkSecondFactor(ctx, userId, code);
  } catch (err) {
    if (err instanceof AppError && err.status === 401) await noteFailedLogin(ctx, userId);
    throw err;
  }
  // The challenge is spent only by a successful exchange (a wrong code keeps the 5-minute window open).
  const spent = await ctx.db.query('DELETE FROM mfa_challenges WHERE id = $1 AND user_id = $2', [jti, userId]);
  if (!spent.rowCount) throw new AppError(401, 'reauth_required', 'Enter your password again to continue.');
  await clearFailedLogins(ctx.db, userId);
  await noteSignIn(ctx, userId, meta);
  const user = await one<User>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return { ...sessionResponse(user, await createSession(ctx, userId, { mfa: true, userAgent: meta.userAgent, ip: meta.ip })), method };
}

// ---------------------------------------------------------------------------
// Password reset by email
// ---------------------------------------------------------------------------
const RESET_TTL_MINUTES = 30;

/**
 * Always resolves the same way whether or not the email exists, so the endpoint
 * can't be used to discover accounts. At most 3 links per hour per account.
 */
export async function requestPasswordReset(ctx: Ctx, email: string, ip?: string) {
  const user = await maybeOne<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (!user) return;
  const recent = await one<{ n: number }>(
    ctx.db,
    `SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (recent.n >= 3) return;
  const token = randomToken(32);
  await withScope(ctx, async (s) => {
    await s.tx.query(
      `INSERT INTO password_resets (user_id, token_hash, ip, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [user.id, hmacSha256(ctx.cfg.FINGERPRINT_KEY, `reset:${token}`), ip ?? null, RESET_TTL_MINUTES],
    );
    await enqueueEmail(s.tx, user.id, 'password_reset', { url: `${ctx.cfg.PUBLIC_WEB_URL}/reset-password?token=${token}`, minutes: RESET_TTL_MINUTES, ip });
  });
}

/** Sets the new password, burns every outstanding reset link and signs out all devices. 2FA stays on. */
export async function resetPassword(ctx: Ctx, token: string, newPassword: string) {
  const hash = await hashPassword(newPassword);
  return withScope(ctx, async (s) => {
    const row = await maybeOne(
      s.tx,
      `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hmacSha256(ctx.cfg.FINGERPRINT_KEY, `reset:${token}`)],
    );
    if (!row) throw badRequest('invalid_reset_link', 'This reset link has expired or was already used. Request a new one.');
    await s.tx.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
    await s.tx.query('UPDATE users SET password_hash = $2, failed_logins = 0, login_lock_count = 0, login_locked_until = NULL WHERE id = $1', [row.user_id, hash]);
    await s.tx.query('DELETE FROM mfa_challenges WHERE user_id = $1', [row.user_id]); // Round 23d: a half-done sign-in dies with the old password
    await revokeOtherSessions(s.tx, row.user_id, null, 'password_reset');
    await enqueueEmail(s.tx, row.user_id, 'password_changed', {});
    return { reset: true };
  });
}

/** Change password: signs out every other device and emails the user. */
export async function changePassword(ctx: Ctx, user: User, current: string, next: string) {
  const row = await one<{ password_hash: string }>(ctx.db, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
  // 403, not 401: a 401 would make the web client refresh and retry (Round 23e/23f).
  if (!(await verifyPassword(current, row.password_hash))) throw new AppError(403, 'wrong_current_password', "Your current password isn't right.");
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
// Tier 1: a verified email (Round 24: no phone; the SMS code path stays, dormant and never required)
// ---------------------------------------------------------------------------
const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

export async function sendVerificationCode(ctx: Ctx, user: User, channel: 'email' | 'sms', phone?: string) {
  // Round 24: with no SMS provider (the production default) SMS verification is off; nothing needs it.
  if (channel === 'sms' && ctx.cfg.SMS_PROVIDER === 'none') throw badRequest('sms_unavailable', 'Phone verification is not used. Verify your email instead.');
  const target = channel === 'email' ? user.email : phone;
  if (!target) throw badRequest('phone_required', 'Phone number is required');
  if (channel === 'sms') {
    if (!/^\+[1-9]\d{7,14}$/.test(target)) throw badRequest('invalid_phone', 'Phone must be in E.164 format, e.g. +14155550123');
    const taken = await maybeOne(
      ctx.db,
      'SELECT 1 FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND deleted_at IS NULL AND id <> $2',
      [target, user.id],
    );
    if (taken) throw conflict('phone_in_use', 'This number is already verified on another account');
    const check = await ctx.phoneChecker.check(target);
    if (!check.ok) {
      throw badRequest('phone_not_supported', 'Use a mobile number from a carrier. Virtual and VoIP numbers can’t be used for verification.');
    }
  }
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
  const pack = isLocale(user.locale) && user.locale !== 'en' ? PACKS[user.locale] : null;
  const locale = pack ? (user.locale as Locale) : 'en';
  if (channel === 'email') {
    // Round 23f (§9.7): the code is in the subject and shown large in the layout.
    const mail = renderCodeEmail(ctx, code, CODE_TTL_MINUTES, locale, user.display_name);
    await ctx.messenger.send({ channel, to: target, subject: mail.subject, body: mail.text, html: mail.html });
  } else {
    const body = pack ? pack.verifyCode(code, CODE_TTL_MINUTES) : `Your Bullizard code is ${code}. It works for ${CODE_TTL_MINUTES} minutes.`;
    await ctx.messenger.send({ channel, to: target, body });
  }
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
    else {
      try {
        await s.tx.query('SAVEPOINT phone');
        await s.tx.query('UPDATE users SET phone = $2, phone_verified_at = now() WHERE id = $1', [user.id, row.target]);
      } catch (err: any) {
        if (err.code !== '23505') throw err;
        await s.tx.query('ROLLBACK TO SAVEPOINT phone');
        throw conflict('phone_in_use', 'This number is already verified on another account');
      }
    }
    await s.tx.query(
      `UPDATE users SET kyc_tier = GREATEST(kyc_tier, 1) WHERE id = $1 AND email_verified_at IS NOT NULL`, // Round 24: email only
      [user.id],
    );
    return one<User>(s.tx, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [user.id]);
  });
}

// ---------------------------------------------------------------------------
// Tier 2: government ID + biometric liveness via the KYC provider
// ---------------------------------------------------------------------------
export async function startKyc(ctx: Ctx, user: User, level: 'tier2_individual' | 'tier2_business') {
  if (user.kyc_tier < 1) throw badRequest('tier1_required', 'Verify your email first.');
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
      await liftIdRestriction(s.tx, v.user_id); // overdue sellers get their listings back
      await enqueueEmail(s.tx, v.user_id, 'kyc_result', { approved: true });
      s.notifyUser(v.user_id, 'kyc.approved', {});
      s.defer(async () => void (await screenUser(ctx, v.user_id)));
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
export async function requestWithdrawal(ctx: Ctx, userId: string, amountCents: number, currency = ctx.cfg.SETTLEMENT_CURRENCY) {
  assertUsdWithdrawal(currency); // Round 22b: USD only on every withdrawal path
  await ensureScreenedForPayout(ctx, userId);
  const w = await withScope(ctx, async (s) => {
    // Lock the user row to serialize concurrent withdrawals against the same balance.
    const user = await one<User>(s.tx, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (user.kyc_tier < 2) throw new AppError(403, 'kyc_required', 'Tier 2 identity verification is required to withdraw');
    await assertNotPaused(s.tx, 'withdrawals');
    await assertWithdrawalWithinLimits(s.tx, userId, amountCents);
    if (user.withdrawals_frozen || user.status !== 'active') throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are frozen pending a security review');
    // Compliance hold: deliberately the same generic wording, never mentioning AML (no tipping off).
    const { aml_hold } = await one<{ aml_hold: boolean }>(s.tx, 'SELECT aml_hold FROM users WHERE id = $1', [userId]);
    if (aml_hold) throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are paused while we complete a routine review');
    if (!user.stripe_account_id || !user.payouts_enabled) throw badRequest('no_payout_account', 'Set up your payout account first');
    // A balance below zero in any currency must be settled first (see domain/debts.ts).
    const owing = await maybeOne<{ currency: string }>(
      s.tx,
      `SELECT a.currency FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'seller_available' AND a.owner_id = $1 GROUP BY a.currency HAVING SUM(e.amount_cents) < 0 LIMIT 1`,
      [userId],
    );
    if (owing) throw new AppError(409, 'debt_outstanding', `Your ${owing.currency} balance is below zero; settle it before withdrawing`);
    const bal = await withdrawable(ctx, s.tx, userId, currency);
    if (amountCents > bal.withdrawableCents) {
      throw badRequest(
        'insufficient_funds',
        bal.heldCents
          ? `You can withdraw ${bal.withdrawableCents} cents now; ${bal.heldCents} cents from recent sales is on a ${bal.holdDays}-day payout hold`
          : `Available balance is ${bal.availableCents} cents`,
        { withdrawableCents: bal.withdrawableCents, heldCents: bal.heldCents, upcoming: bal.upcoming },
      );
    }
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
    return await withTx(ctx.db, async (tx) => {
      const paid = await one(tx, `UPDATE withdrawals SET status = 'paid', provider_ref = $2 WHERE id = $1 RETURNING *`, [w.id, ref]);
      await enqueueEmail(tx, userId, 'withdrawal_paid', { amount_cents: amountCents, currency, provider_ref: ref });
      return paid;
    });
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
      // Round 23f (§9.6): a reason code, worded in the reader's language (the provider's text stays in the logs).
      ctx.log.warn({ withdrawalId: w.id, err: (err as Error).message.slice(0, 200) }, 'payout failed');
      await enqueueEmail(s.tx, userId, 'withdrawal_failed', { amount_cents: amountCents, currency, reason: 'provider_failed' });
    });
    throw new AppError(502, 'payout_failed', 'The payment provider rejected this payout; the amount is back in your balance', { reason: (err as Error).message.slice(0, 200) });
  }
}

export async function getUser(q: Queryable, id: string) {
  return maybeOne<User>(q, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}
