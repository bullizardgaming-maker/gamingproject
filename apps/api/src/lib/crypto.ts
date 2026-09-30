import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// AES-256-GCM field encryption with a versioned keyring (supports key rotation).
// Ciphertext format: "<keyVersion>:<iv b64>:<tag b64>:<data b64>"
// ---------------------------------------------------------------------------
export class Keyring {
  private keys = new Map<string, Buffer>();
  private current: string;

  constructor(spec: string) {
    const entries = spec.split(',').map((s) => s.trim()).filter(Boolean);
    if (!entries.length) throw new Error('empty keyring');
    for (const entry of entries) {
      const [version, b64] = entry.split(':');
      const key = Buffer.from(b64 ?? '', 'base64');
      if (!version || key.length !== 32) throw new Error(`key ${version} must be 32 bytes base64`);
      this.keys.set(version, key);
    }
    this.current = entries[entries.length - 1]!.split(':')[0]!;
  }

  encrypt(plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.current)!, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [this.current, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(ciphertext: string, aad = ''): string {
    const [version, iv, tag, data] = ciphertext.split(':');
    const key = this.keys.get(version ?? '');
    if (!key || !iv || !tag || data === undefined) throw new Error('malformed ciphertext or unknown key version');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// Passwords: scrypt (memory-hard hashing — passwords are hashed, never reversibly encrypted).
// ---------------------------------------------------------------------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const hmacSha256 = (secret: string | Buffer, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time comparison of two hex/ascii strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomDigits = (len = 6) => Array.from({ length: len }, () => randomInt(10)).join('');
