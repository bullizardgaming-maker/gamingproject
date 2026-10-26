/**
 * HTTP client shared by the staging test scripts (money-paths, kill-switch, loadtest-staging) and their GitHub
 * workflows (.github/workflows/staging-*.yml). Requests go through Cloudflare like any client: no origin secret.
 *
 *   API_URL               the API, e.g. https://api-staging.bullizard.com (default http://127.0.0.1:4000)
 *   STAGING_TEST_TOKEN    sent as X-Staging-Test-Token so sign-in skips Turnstile; the API accepts it only with
 *                         APP_ENV=staging and the same STAGING_TEST_TOKEN set there (config.ts refuses it elsewhere)
 *
 * Credentials come from the environment and are never printed: errors name the account ("staff", "buyer"), never
 * the address or the password.
 */
import { currentStep, totpAt } from '../src/domain/mfa.js';

export const API = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const TEST_TOKEN = process.env.STAGING_TEST_TOKEN || undefined;

export type Res = { status: number; body: any; ms: number };

export async function call(method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}): Promise<Res> {
  const started = performance.now();
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'bullizard-staging-tests',
      ...(TEST_TOKEN ? { 'x-staging-test-token': TEST_TOKEN } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body: parsed, ms: performance.now() - started };
}

export const api = (token: string | null, extra: Record<string, string> = {}) => ({
  get: (p: string) => call('GET', p, undefined, token, extra),
  post: (p: string, b: unknown = {}, h: Record<string, string> = {}) => call('POST', p, b, token, { ...extra, ...h }),
  put: (p: string, b: unknown = {}) => call('PUT', p, b, token, extra),
  patch: (p: string, b: unknown = {}) => call('PATCH', p, b, token, extra),
});
export type Api = ReturnType<typeof api>;

/** An environment variable that must be set (the message names it, never its value). */
export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signs in and returns the access token. Accounts with 2FA (staff) need `totpSecret` (base32): the code is computed
 * here. A code can be used once, so a failed step is retried with the next 30-second code.
 */
export async function signIn(label: string, email: string, password: string, totpSecret?: string): Promise<string> {
  const r = await call('POST', '/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`${label} sign-in failed: ${r.status} ${r.body?.error?.code ?? ''}`);
  if (!r.body.mfaRequired) return r.body.token;
  if (!totpSecret) throw new Error(`${label} has 2FA on: set its TOTP secret`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const m = await call('POST', '/auth/mfa', { mfaToken: r.body.mfaToken, code: totpAt(totpSecret, currentStep()) });
    if (m.status === 200) return m.body.token;
    if (m.status !== 401 && m.status !== 400) throw new Error(`${label} 2FA failed: ${m.status} ${m.body?.error?.code ?? ''}`);
    await sleep(31_000 - (Date.now() % 30_000)); // the code of this step was used already: wait for the next one
  }
  throw new Error(`${label} 2FA failed`);
}

/** A tiny PNG, e.g. a delivery proof on staging (DELIVERY_PROOF_REQUIRED). */
export const PROOF_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQz3+LFTEMLQkAZoJiwV7klB8AAAAASUVORK5CYII=',
  'base64',
);

/** Uploads the proof image to the order's chat as the seller and returns its id (null if the upload was refused). */
export async function uploadProof(seller: Api, roomId: string): Promise<string | null> {
  const r = await seller.post(`/chat/rooms/${roomId}/attachments`, PROOF_PNG, { 'content-type': 'image/png', 'x-filename': 'delivery.png' });
  return r.status === 201 ? r.body.id : null;
}

/** Delivers a manual order, attaching a proof when the order needs one. */
export async function deliver(seller: Api, orderId: string, payload = 'sent in-game'): Promise<Res> {
  const view = (await seller.get(`/orders/${orderId}`)).body;
  const proofAttachmentId = view?.proof_required ? await uploadProof(seller, view.room_id) : null;
  return seller.post(`/orders/${orderId}/deliver`, { payload, ...(proofAttachmentId ? { proofAttachmentId } : {}) });
}

/** Mock checkout (SANDBOX_MODE staging): pays the order as the hosted page would. */
export async function payMock(order: { payment_ref: string }) {
  const r = await fetch(`${API}/v1/payments/mock/checkout/${encodeURIComponent(order.payment_ref)}/pay`, {
    method: 'POST',
    headers: { accept: 'application/json', 'user-agent': 'bullizard-staging-tests' },
  });
  return r.status;
}
