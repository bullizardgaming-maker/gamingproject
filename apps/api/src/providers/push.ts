import webpush from 'web-push';
import { fetchPublic } from '../lib/netguard.js';

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  id: string;
  title: string;
  body: string;
  url: string | null;
  tag: string;
}

/** ok = delivered; gone = subscription expired/unsubscribed (delete it); retry = temporary failure. */
export type PushResult = 'ok' | 'gone' | 'retry';

export interface PushSender {
  readonly enabled: boolean;
  /** VAPID public key the browser needs to subscribe (null when push is off). */
  readonly publicKey: string | null;
  send(sub: PushSubscriptionKeys, msg: PushMessage): Promise<PushResult>;
}

export class NoPush implements PushSender {
  readonly enabled = false;
  readonly publicKey = null;
  async send(): Promise<PushResult> {
    return 'retry';
  }
}

/** Test double: records messages; endpoints listed in `gone` answer 410. */
export class FakePush implements PushSender {
  readonly enabled = true;
  readonly publicKey = 'fake-vapid-public-key';
  readonly sent: Array<{ endpoint: string; msg: PushMessage }> = [];
  readonly gone = new Set<string>();
  async send(sub: PushSubscriptionKeys, msg: PushMessage): Promise<PushResult> {
    if (this.gone.has(sub.endpoint)) return 'gone';
    this.sent.push({ endpoint: sub.endpoint, msg });
    return 'ok';
  }
}

/**
 * Standard Web Push (RFC 8030 + VAPID RFC 8292), which covers Chrome/Android (FCM), Firefox,
 * Edge and Safari/iOS web apps. The payload is encrypted for the browser (RFC 8291) by
 * web-push; the request itself goes out through the SSRF-guarded client.
 */
export class WebPushSender implements PushSender {
  readonly enabled = true;
  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
    private readonly guarded = true,
  ) {}

  async send(sub: PushSubscriptionKeys, msg: PushMessage): Promise<PushResult> {
    const req = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(msg),
      { vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey }, TTL: 24 * 3600, urgency: 'normal' },
    );
    const init = { method: req.method, headers: req.headers as Record<string, string>, body: req.body as Buffer | null, signal: AbortSignal.timeout(10_000) };
    try {
      const res = this.guarded ? await fetchPublic(req.endpoint, init as any) : await fetch(req.endpoint, init as any);
      if (res.status >= 200 && res.status < 300) return 'ok';
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status === 429 || res.status >= 500) return 'retry';
      return 'gone'; // 400/401/403: malformed or keys no longer valid for this subscription
    } catch {
      return 'retry';
    }
  }
}

/** Push services browsers use. Subscriptions pointing anywhere else are refused (no SSRF via push). */
export function isAllowedPushEndpoint(endpoint: string, allowed: string[]) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return allowed.some((h) => (h.startsWith('*.') ? url.hostname.endsWith(h.slice(1)) : url.hostname === h));
}
