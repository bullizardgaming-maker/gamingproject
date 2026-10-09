import type { WebhookEvent } from './types.js';

/**
 * Webhook verification. Bullizard signs the raw request body with your endpoint's secret:
 * `X-Hook-Signature` = hex HMAC-SHA256(secret, raw body). Verify against the exact bytes you
 * received, before parsing, and process each event id once (it's also the Idempotency-Key header
 * and stays the same across retries). Uses Web Crypto, so it runs on Node 18+, Deno, Bun and
 * edge runtimes.
 */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

const encoder = new TextEncoder();
const toBytes = (body: string | Uint8Array) => (typeof body === 'string' ? encoder.encode(body) : body);

async function hmacHex(secret: string, body: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body as unknown as ArrayBuffer));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two hex strings. */
function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True if `signature` (the X-Hook-Signature header) matches the raw body. */
export async function verifyWebhookSignature(rawBody: string | Uint8Array, signature: string | null | undefined, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  return equal(await hmacHex(secret, toBytes(rawBody)), signature.trim().toLowerCase());
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
const header = (h: HeaderSource, name: string) => {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const rec = h as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()] ?? Object.entries(rec).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
};

/**
 * Verify and parse a webhook request. Throws WebhookVerificationError if the signature is
 * missing or wrong. Pass the raw body (not a re-serialized object).
 *
 *   const event = await constructWebhookEvent(rawBody, req.headers, process.env.BULLIZARD_WEBHOOK_SECRET!);
 *   if (event.type === 'order.created') deliver(event.data.id);
 */
export async function constructWebhookEvent(rawBody: string | Uint8Array, headers: HeaderSource, secret: string): Promise<WebhookEvent> {
  const signature = header(headers, 'X-Hook-Signature');
  if (!(await verifyWebhookSignature(rawBody, signature, secret))) {
    throw new WebhookVerificationError(signature ? 'Webhook signature does not match' : 'Missing X-Hook-Signature header');
  }
  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  return JSON.parse(text) as WebhookEvent;
}
