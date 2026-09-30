const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'arbiter' | 'admin';
  kyc_tier: number;
  status: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  withdrawals_frozen: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const TOKEN_KEY = 'mkt.token';
export const session = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
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

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Device-Fingerprint': deviceFingerprint(), ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`${BASE}/v1${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) session.set(null);
    throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

// ---------------------------------------------------------------------------
// Realtime: one shared socket, auto-reconnect, per-room resync by last seq.
// ---------------------------------------------------------------------------
export interface ChatMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string | null;
  kind: 'text' | 'system' | 'delivery' | 'warning';
  body: string;
  flags: string[];
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

  connect() {
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
    ws.onclose = () => {
      this.ws = null;
      if (!session.token) return;
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
