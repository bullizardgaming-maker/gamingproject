import type {
  ChatMessage,
  InventoryResult,
  InventoryUpload,
  Invoice,
  ListOrdersQuery,
  MerchantOrder,
  PriceResult,
  PriceUpdate,
  ReportJson,
  ReportKind,
  ReportQuery,
  WebhookDeliveriesQuery,
  WebhookDelivery,
} from './types.js';

export * from './types.js';
export { constructWebhookEvent, verifyWebhookSignature, WebhookVerificationError } from './webhooks.js';

export interface BullizardOptions {
  /** A seller API key (`mk_...`) from Account → Developers. Give it only the scopes your bot needs. */
  apiKey: string;
  /** Default https://api.bullizard.com. Use your sandbox URL while testing. */
  baseUrl?: string;
  /** Retries for rate limits (429) on any call, and for network errors and 5xx on reads. Default 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** An API error: `status` is the HTTP status and `code` the machine-readable error code (e.g. `insufficient_scope`). */
export class BullizardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'BullizardError';
  }
}

type Query = Record<string, string | number | undefined>;
const qs = (q: Query = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bullizard seller API client.
 *
 *   const bz = new Bullizard({ apiKey: process.env.BULLIZARD_API_KEY! });
 *   for await (const order of bz.orders.poll({ status: 'paid' })) await bz.orders.deliver(order.id, 'your code');
 */
export class Bullizard {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: BullizardOptions) {
    if (!opts.apiKey?.startsWith('mk_')) throw new Error('Bullizard: apiKey must be a seller API key (mk_...)');
    this.baseUrl = (opts.baseUrl ?? 'https://api.bullizard.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Low-level request. `raw` returns the Response (for files). */
  async request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
    const read = method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'bullizard-sdk-js/0.1.0',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // A write might have reached the server; only reads are safe to repeat after a network error.
        if (read && attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      const retryable = res.status === 429 || (read && res.status >= 500);
      if (retryable && attempt < this.maxRetries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } };
        throw new BullizardError(res.status, data.error?.code ?? 'http_error', data.error?.message ?? `Request failed (${res.status})`, data.error?.details, res.headers.get('x-request-id') ?? data.error?.requestId);
      }
      if (opts.raw) return res as unknown as T;
      if (res.status === 204) return undefined as T;
      const type = res.headers.get('content-type') ?? '';
      return (type.includes('application/json') ? await res.json() : await res.text()) as T;
    }
  }

  readonly orders = {
    /** Your orders, newest first. Scope: orders:read. */
    list: (query: ListOrdersQuery = {}) => this.request<MerchantOrder[]>('GET', `/merchant/orders${qs(query as Query)}`),
    get: (id: string) => this.request<Record<string, unknown>>('GET', `/merchant/orders/${encodeURIComponent(id)}`),
    /** Deliver a manual order. `payload` (codes, credentials, notes) is stored encrypted and shown only to the buyer. Scope: orders:write. */
    deliver: (id: string, payload?: string) => this.request<Record<string, unknown>>('POST', `/merchant/orders/${encodeURIComponent(id)}/deliver`, payload === undefined ? {} : { payload }),
    /**
     * Incremental polling: yields every order updated since the last poll, once per change, then
     * waits `intervalMs` and polls again. Stops when `signal` aborts.
     */
    poll: (query: Omit<ListOrdersQuery, 'since'> & { since?: string; intervalMs?: number; signal?: AbortSignal } = {}) => this.pollOrders(query),
  };

  private async *pollOrders(query: Omit<ListOrdersQuery, 'since'> & { since?: string; intervalMs?: number; signal?: AbortSignal }): AsyncGenerator<MerchantOrder> {
    let since = query.since ?? new Date(0).toISOString();
    const seen = new Map<string, string>();
    while (!query.signal?.aborted) {
      const startedAt = new Date().toISOString();
      const batch = await this.orders.list({ status: query.status, limit: query.limit ?? 200, since });
      for (const o of batch.reverse()) {
        const version = `${o.status}|${o.delivered_at}|${o.completed_at}`;
        if (seen.get(o.id) === version) continue;
        seen.set(o.id, version);
        yield o;
      }
      since = startedAt;
      if (seen.size > 10_000) seen.clear();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, query.intervalMs ?? 15_000);
        query.signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }

  readonly inventory = {
    /** Upload codes for an auto-delivery listing (up to 10,000 per call; duplicates are skipped). Scope: inventory:write. */
    upload: (input: InventoryUpload) => this.request<InventoryResult>('POST', '/merchant/inventory', input),
  };

  readonly prices = {
    /** Reprice several listings at once; each update succeeds or fails on its own. Scope: offers:write. */
    update: async (updates: PriceUpdate[]) => (await this.request<{ results: PriceResult[] }>('PATCH', '/merchant/prices', { updates })).results,
  };

  readonly chat = {
    /** Message the buyer in an order's chat (the recorded channel arbiters read). Scope: chat:write. */
    send: (roomId: string, body: string) => this.request<ChatMessage>('POST', `/merchant/chat/${encodeURIComponent(roomId)}/messages`, { body }),
  };

  readonly invoices = {
    /** Monthly commission invoices. Scope: reports:read. */
    list: () => this.request<Invoice[]>('GET', '/merchant/invoices'),
    /** The invoice PDF as bytes. */
    pdf: async (id: string) => new Uint8Array(await (await this.request<Response>('GET', `/merchant/invoices/${encodeURIComponent(id)}/pdf`, undefined, { raw: true })).arrayBuffer()),
  };

  readonly reports = {
    /** Accounting export rows as JSON. Scope: reports:read. */
    get: (kind: ReportKind, query: ReportQuery = {}) => this.request<ReportJson>('GET', `/merchant/reports/${kind}${qs({ ...query, format: 'json' } as Query)}`),
    /** The same export as CSV text (amounts in cents; formula-safe). */
    csv: (kind: ReportKind, query: ReportQuery = {}) => this.request<string>('GET', `/merchant/reports/${kind}${qs({ ...query, format: 'csv' } as Query)}`),
  };

  readonly webhooks = {
    /** Deliveries to your endpoints, default the ones still failing. Scope: webhooks:manage. */
    deliveries: (query: WebhookDeliveriesQuery = {}) => this.request<WebhookDelivery[]>('GET', `/merchant/webhooks/deliveries${qs(query as Query)}`),
    /** Send one delivery again (same event id). */
    redeliver: (deliveryId: string) => this.request<WebhookDelivery>('POST', `/merchant/webhooks/deliveries/${encodeURIComponent(deliveryId)}/redeliver`),
    /** Re-queue every dead delivery for an endpoint, e.g. after your outage. */
    replay: (endpointId: string, since?: string) => this.request<{ requeued: number }>('POST', `/merchant/webhooks/${encodeURIComponent(endpointId)}/replay`, since ? { since } : {}),
  };
}

export default Bullizard;
