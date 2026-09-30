import { createHmac, randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { hmacSha256, safeEqual } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { withScope } from './events.js';

// ---------------------------------------------------------------------------
// TOTP (RFC 6238): 30-second steps, 6 digits, HMAC-SHA1 — what every authenticator app speaks.
// ---------------------------------------------------------------------------
const STEP_SECONDS = 30;
const DRIFT_STEPS = 1; // accept the previous/next step for clock skew
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** Returns the matching step, or null. Steps at or before `lastStep` are rejected (no replay). */
export function verifyTotp(secretB32: string, code: string, lastStep: number, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    if (safeEqual(totpAt(secretB32, step), code)) return step;
  }
  return null;
}

const secretAad = (userId: string) => `totp:${userId}`;
const recoveryHash = (ctx: Ctx, userId: string, code: string) => hmacSha256(ctx.cfg.FINGERPRINT_KEY, `recovery:${userId}:${code.replace(/-/g, '').toLowerCase()}`);

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------
export async function beginSetup(ctx: Ctx, user: { id: string; email: string }) {
  const row = await one<{ totp_enabled_at: string | null }>(ctx.db, 'SELECT totp_enabled_at FROM users WHERE id = $1', [user.id]);
  if (row.totp_enabled_at) throw conflict('mfa_enabled', 'Two-factor login is already on');
  const secret = base32Encode(randomBytes(20));
  await ctx.db.query('UPDATE users SET totp_secret_ciphertext = $2 WHERE id = $1', [user.id, ctx.keyring.encrypt(secret, secretAad(user.id))]);
  const label = encodeURIComponent(`Bullizard:${user.email}`);
  return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=Bullizard&algorithm=SHA1&digits=6&period=${STEP_SECONDS}` };
}

export async function enable(ctx: Ctx, userId: string, code: string) {
  return withScope(ctx, async (s) => {
    const row = await one(s.tx, 'SELECT totp_secret_ciphertext, totp_enabled_at, totp_last_step FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (row.totp_enabled_at) throw conflict('mfa_enabled', 'Two-factor login is already on');
    if (!row.totp_secret_ciphertext) throw badRequest('mfa_not_started', 'Start two-factor setup first');
    const step = verifyTotp(ctx.keyring.decrypt(row.totp_secret_ciphertext, secretAad(userId)), code, row.totp_last_step);
    if (step === null) throw badRequest('invalid_code', 'That code is not valid. Check the time on your phone and try the newest code.');
    await s.tx.query('UPDATE users SET totp_enabled_at = now(), totp_last_step = $2 WHERE id = $1', [userId, step]);
    await s.tx.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
    for (const c of codes) await s.tx.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, recoveryHash(ctx, userId, c)]);
    return { recoveryCodes: codes };
  });
}

export async function disable(ctx: Ctx, userId: string, code: string) {
  await checkSecondFactor(ctx, userId, code);
  await ctx.db.query('UPDATE users SET totp_enabled_at = NULL, totp_secret_ciphertext = NULL WHERE id = $1', [userId]);
  await ctx.db.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
}

/** Accepts a current TOTP code or an unused recovery code. Throws on failure. */
export async function checkSecondFactor(ctx: Ctx, userId: string, code: string): Promise<'totp' | 'recovery'> {
  return withScope(ctx, async (s) => {
    const row = await maybeOne(s.tx, 'SELECT totp_secret_ciphertext, totp_enabled_at, totp_last_step FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!row?.totp_enabled_at) throw badRequest('mfa_not_enabled', 'Two-factor login is not on');
    const step = verifyTotp(ctx.keyring.decrypt(row.totp_secret_ciphertext, secretAad(userId)), code.trim(), row.totp_last_step);
    if (step !== null) {
      await s.tx.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [userId, step]);
      return 'totp';
    }
    const used = await s.tx.query(
      'UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
      [userId, recoveryHash(ctx, userId, code.trim())],
    );
    if (used.rowCount === 1) return 'recovery';
    throw unauthorized('Invalid two-factor code');
  });
}

export async function remainingRecoveryCodes(ctx: Ctx, userId: string) {
  return (await many(ctx.db, 'SELECT 1 FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId])).length;
}
