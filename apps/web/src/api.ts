import { moneyLocale, t, type MessageKey } from './i18n';
import en from './i18n/en';
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/**
 * Demo builds (VITE_DEMO=true, e.g. Vercel previews with no backend) answer every API call from an
 * in-browser mock with sample data. The mock is loaded lazily, so normal builds never fetch it.
 */
export const DEMO = import.meta.env.VITE_DEMO === 'true';
/** Where the API lives ('' = same origin, behind the web server's /v1 proxy). */
export const API_ORIGIN = BASE;
/** A file the API serves (e.g. a shop banner); data: URLs (demo mode) pass through. */
export const assetUrl = (path: string) => (path.startsWith('data:') ? path : BASE + path);
const demo = () => import('./demo/mock');

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'arbiter' | 'support' | 'lead' | 'finance' | 'compliance' | 'marketing' | 'admin';
  kyc_tier: number;
  status: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  withdrawals_frozen: boolean;
  totp_enabled: boolean;
  payouts_enabled: boolean;
  /** Language for emails and notifications. */
  locale?: string;
  session_mfa?: boolean;
  /** Character names / UIDs remembered per game (lower-case key) after the first order. */
  handover_names?: Record<string, string>;
  /** Seller onboarding: set once the rules test is passed. */
  rules_passed_at?: string | null;
  selling_restricted_at?: string | null;
  seller_since?: string | null;
  /** Newsletter consent (Round 23a). */
  news_opt_in?: boolean;
  news_opt_in_at?: string | null;
}

/**
 * The message people see for an API error (copy deck §2.13): `err.<code>` when the key exists,
 * otherwise the server's own message (validation text stays useful); `err.generic` for 5xx and
 * unknown failures, `err.network` when the request never reached the API.
 */
export function errorMessage(status: number, code: string, serverMessage?: string): string {
  if (code === 'network') return t('err.network');
  // Round 23f (copy deck §9.2): the code's own text first, so account_locked (429) and scanner_unavailable (503) say
  // what happened instead of "too many tries" or the generic error.
  const key = `err.${code}`;
  if (code && key in en) return t(key as MessageKey);
  if (code === 'too_many_requests' || status === 429) return t('err.too_many');
  if (status >= 500 || status === 0 || !serverMessage || code === 'internal') return t('err.generic');
  return serverMessage;
}

export class ApiError extends Error {
  /** The API's own message, before localisation. */
  public serverMessage: string;
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(errorMessage(status, code, message));
    this.serverMessage = message;
  }
}

const TOKEN_KEY = 'mkt.token';
/**
 * Round 23d (privacy, item 13): the access token lives in memory only; what persists is the httpOnly refresh cookie.
 * A new tab or a reload gets a token by exchanging the cookie (see SessionProvider). The demo build has no cookie, so
 * it keeps the token in localStorage — demo data only.
 */
let memoryToken: string | null = null;
/** Set while a reload/new tab is still exchanging the refresh cookie, so the app does not flash "signed out". */
const BOOT_KEY = 'mkt.signed-in';
/** Set once this browser has tried the cookie exchange without the flag (the cookie is httpOnly: JS cannot see it). */
const PROBED_KEY = 'mkt.session-probed';
/**
 * Round 23e (item 11): a token stored by an older build (before Round 23d) is removed on load. That browser was signed
 * in, so it is treated as signed in: the refresh cookie is exchanged as on any reload.
 */
let legacySignedIn = false;
if (!DEMO) {
  try {
    if (localStorage.getItem(TOKEN_KEY) !== null) {
      localStorage.removeItem(TOKEN_KEY);
      legacySignedIn = true;
    }
  } catch {
    /* storage unavailable */
  }
}
export const session = {
  get token() {
    if (!DEMO) return memoryToken;
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  /** True when this browser signed in before and may still hold a refresh cookie. */
  get maybeSignedIn() {
    try {
      return legacySignedIn || localStorage.getItem(BOOT_KEY) === '1';
    } catch {
      return legacySignedIn;
    }
  },
  /**
   * Round 23e (item 11): a refresh cookie can exist without the flag (storage cleared, a build from before the flag).
   * Each browser tries the exchange once without it; a cookie found that way counts as signed in.
   */
  takeProbe() {
    if (DEMO) return false;
    try {
      if (localStorage.getItem(PROBED_KEY) === '1') return false;
      localStorage.setItem(PROBED_KEY, '1');
      return true;
    } catch {
      return false;
    }
  },
  set(token: string | null) {
    memoryToken = token;
    if (!token) legacySignedIn = false;
    try {
      if (DEMO) {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
      }
      if (token) localStorage.setItem(BOOT_KEY, '1');
      else localStorage.removeItem(BOOT_KEY);
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event('session'));
  },
};

/** Coarse, privacy-preserving device fingerprint used as one fraud-graph signal. */
function deviceFingerprint(): string {
  const key = 'mkt.device';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return 'no-storage';
  }
}

let refreshing: Promise<boolean> | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One refresh call; 'race' means another tab rotated the cookie a moment ago (409 refresh_superseded). */
async function refreshOnce(): Promise<'ok' | 'race' | 'failed'> {
  const res = await fetch(`${BASE}/v1/auth/refresh`, { method: 'POST', credentials: 'include' }).catch(() => null);
  if (!res) return 'race'; // network blip: retry like a race, never sign out for it
  if (res.ok) {
    session.set((await res.json()).token);
    return 'ok';
  }
  return res.status === 409 ? 'race' : 'failed';
}

/**
 * Exchange the httpOnly refresh cookie for a new access token. Single-flight in this tab (parallel 401s trigger one
 * refresh) and, where the browser has Web Locks, across tabs (Round 23e, item 11): tabs take turns, so the second one
 * uses the cookie the first just received. A 409 (another tab rotated the cookie a moment ago; its Set-Cookie may not
 * have landed yet) is retried with a short backoff instead of signing this tab out.
 */
export function refreshAccessToken(): Promise<boolean> {
  if (DEMO) return Promise.resolve(false);
  refreshing ??= (async () => {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await wait(150 * 2 ** attempt);
        const r = await refreshOnce();
        if (r === 'ok') return true;
        if (r === 'failed') {
          session.set(null);
          return false;
        }
      }
      return false; // still racing: keep the tab as it is (signed-in flag kept), the next call tries again
    };
    const locks = (navigator as Navigator & { locks?: { request: (name: string, cb: () => Promise<boolean>) => Promise<boolean> } }).locks;
    return locks ? locks.request('bz-auth-refresh', run) : run();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { 'X-Device-Fingerprint': deviceFingerprint(), ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  if (DEMO) {
    const { demoFetch } = await demo();
    const r = await demoFetch(method, path, init.body, session.token);
    if (r.status === 204) return undefined as T;
    const d = r.data as any;
    if (r.status >= 400) throw new ApiError(r.status, d.error?.code ?? 'error', d.error?.message ?? '', d.error?.details);
    return d as T;
  }
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }).catch(() => {
    throw new ApiError(0, 'network', 'Network request failed');
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !retried && session.token && !path.startsWith('/auth/') && (await refreshAccessToken())) {
      return api<T>(path, init, true);
    }
    throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? '', data.error?.details);
  }
  return data as T;
}

/** Upload a file as the raw request body (images); demo mode stores it as a data: URL instead. */
/** Round 23f (copy deck §9.3): what an upload is doing, for "Uploading 42%" / "Checking the file…". */
export type UploadProgress = { phase: 'uploading'; pct: number } | { phase: 'scanning' };

/** A request whose upload progress can be watched (fetch cannot report it). */
function xhrSend(method: string, url: string, headers: Record<string, string>, body: Blob, onProgress?: (p: UploadProgress) => void, withCredentials = true) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = withCredentials;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.({ phase: 'uploading', pct: Math.min(100, Math.round((e.loaded / e.total) * 100)) });
    xhr.upload.onload = () => onProgress?.({ phase: 'scanning' }); // every byte sent: the server scans it now
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Network request failed'));
    xhr.send(body);
  });
}

export async function apiUpload<T = any>(path: string, file: File, onProgress?: (p: UploadProgress) => void): Promise<T> {
  if (DEMO) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    return api<T>(path, { body: { dataUrl, type: file.type, size: file.size, name: file.name } });
  }
  const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream', 'X-Device-Fingerprint': deviceFingerprint() };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (onProgress) {
    const r = await xhrSend('POST', `${BASE}/v1${path}`, headers, file, onProgress);
    if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, r.data.error?.code ?? 'error', r.data.error?.message ?? '', r.data.error?.details);
    return r.data as T;
  }
  const res = await fetch(`${BASE}/v1${path}`, { method: 'POST', headers, credentials: 'include', body: file }).catch(() => {
    throw new ApiError(0, 'network', 'Network request failed');
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? '', data.error?.details);
  return data as T;
}

/** Videos the API accepts in one request (under Cloudflare's 100 MB limit); larger ones go straight to storage. */
export const MAX_VIDEO_BYTES = 95 * 1024 * 1024;

/**
 * Chat evidence / delivery proof (Round 23a). Images and videos up to 95 MB are posted to the API; a larger video is
 * PUT straight to object storage with a signed URL (when the API has one) and then confirmed, so it never crosses
 * Cloudflare. Without object storage a larger video gets the translated size message before anything is sent.
 */
export async function uploadChatFile<T = any>(roomId: string, file: File, onProgress?: (p: UploadProgress) => void): Promise<T> {
  const isVideo = file.type.startsWith('video/');
  // The size message carries the API's limit (95 MB through the API, 100 MB direct) — copy deck §9.3.
  const tooLarge = (maxMb = MAX_VIDEO_BYTES / 1_048_576) => Object.assign(new ApiError(413, 'file_too_large', ''), { message: t('upload.videoTooLarge', { maxMb }) });
  try {
    if (!isVideo || file.size <= MAX_VIDEO_BYTES) return await apiUpload<T>(`/chat/rooms/${roomId}/attachments`, file, onProgress);
  } catch (err) {
    if (isVideo && !DEMO && err instanceof ApiError && err.code === 'file_too_large') throw tooLarge(err.details?.maxMb);
    throw err;
  }
  if (DEMO) throw tooLarge();
  let start: { id: string; url: string; method: 'PUT'; headers: Record<string, string> };
  try {
    start = await api(`/chat/rooms/${roomId}/attachments/direct`, { body: { fileName: file.name, contentType: file.type === 'video/webm' ? 'video/webm' : 'video/mp4', bytes: file.size } });
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'direct_upload_unavailable' || err.code === 'file_too_large')) throw tooLarge(err.details?.maxMb);
    throw err;
  }
  const put = await xhrSend(start.method, start.url, start.headers, file, onProgress, false).catch(() => null);
  if (!put || put.status < 200 || put.status >= 300) throw new ApiError(put?.status ?? 0, 'network', 'Upload failed');
  onProgress?.({ phase: 'scanning' });
  return api<T>(`/chat/attachments/${start.id}/complete`, { body: {} });
}

export async function signOut() {
  if (DEMO) return session.set(null);
  await fetch(`${BASE}/v1/auth/logout`, { method: 'POST', credentials: 'include', headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} }).catch(() => {});
  session.set(null);
}

export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat(moneyLocale(), { style: 'currency', currency }).format(cents / 100);

// ---------------------------------------------------------------------------
// Realtime: one shared socket, auto-reconnect, per-room resync by last seq.
// ---------------------------------------------------------------------------
export interface ChatMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string | null;
  kind: 'text' | 'system' | 'delivery' | 'warning' | 'attachment' | 'system_order';
  /** null when the author's chat history was erased. */
  body: string | null;
  erased?: boolean;
  flags: string[];
  /** System messages: a code and parameters rendered in the reader's language (the body is the English text). */
  code?: string | null;
  params?: Record<string, unknown> | null;
  hash: string;
  created_at: string;
}

type Listener = (frame: any) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private rooms = new Map<string, number>(); // roomId -> last seen seq
  private backoff = 500;

  private url() {
    const origin = BASE || window.location.origin;
    return origin.replace(/^http/, 'ws') + '/v1/ws';
  }

  private demoWired = false;

  connect() {
    if (DEMO) {
      // No socket in demo builds: the mock pushes frames directly; sending falls back to REST.
      if (!this.demoWired) {
        this.demoWired = true;
        void demo().then(({ onDemoFrame }) => onDemoFrame((frame) => this.listeners.forEach((l) => l(frame))));
      }
      return;
    }
    if (this.ws || !session.token) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: session.token }));
    ws.onmessage = (ev) => {
      const frame = JSON.parse(ev.data);
      if (frame.type === 'ready') {
        this.backoff = 500;
        for (const [roomId, afterSeq] of this.rooms) ws.send(JSON.stringify({ type: 'subscribe', roomId, afterSeq }));
      }
      const msgs: ChatMessage[] = frame.type === 'history' ? frame.messages : frame.type === 'message' ? [frame.message] : [];
      for (const m of msgs) if ((this.rooms.get(m.room_id) ?? 0) < m.seq) this.rooms.set(m.room_id, m.seq);
      this.listeners.forEach((l) => l(frame));
    };
    ws.onclose = async (ev) => {
      this.ws = null;
      if (!session.token) return;
      // Access token expired while connected or before auth: refresh, then reconnect.
      if (ev.code === 4401 && !(await refreshAccessToken())) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
  }

  subscribe(roomId: string, fn: Listener) {
    this.connect();
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, 0);
    this.listeners.add(fn);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', roomId, afterSeq: 0 }));
    return () => {
      this.listeners.delete(fn);
      this.rooms.delete(roomId);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', roomId }));
    };
  }

  listen(fn: Listener) {
    this.connect();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(roomId: string, body: string) {
    const clientMsgId = crypto.randomUUID();
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Not connected. Reconnecting…');
    this.ws.send(JSON.stringify({ type: 'message', roomId, body, clientMsgId }));
    return clientMsgId;
  }
}

export const realtime = new Realtime();

/** Authenticated binary download (e.g. representment PDFs). */
export async function apiBlob(path: string): Promise<Blob> {
  if (DEMO) {
    const { demoBlob } = await demo();
    return demoBlob(path, session.token);
  }
  const res = await fetch(`${BASE}/v1${path}`, { headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} }).catch(() => {
    throw new ApiError(0, 'network', 'Network request failed');
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? '', data.error?.details);
  }
  return res.blob();
}

/** Fetch an authenticated file (PDF, CSV) and hand it to the browser as a download. */
export async function download(path: string, filename: string) {
  const url = URL.createObjectURL(await apiBlob(path));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface Permissions {
  permissions: string[];
}

