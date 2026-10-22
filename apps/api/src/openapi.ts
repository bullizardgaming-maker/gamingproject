import { z } from 'zod';
import * as S from './api-schemas.js';
import { SandboxChargebackBody, SandboxOrderBody } from './routes/sandbox.js';
import { WEBHOOK_EVENTS } from './domain/webhooks.js';

/**
 * OpenAPI 3.1 document for the seller (merchant) API, webhooks and sandbox,
 * generated from the zod schemas the routes validate with.
 */
const json = (schema: z.ZodTypeAny, io: 'input' | 'output' = 'output') => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
};

const body = (schema: z.ZodTypeAny) => ({ required: true, content: { 'application/json': { schema: json(schema, 'input') } } });
const ok = (schema: z.ZodTypeAny, description = 'OK', status = '200') => ({ [status]: { description, content: { 'application/json': { schema: json(schema) } } } });
const errors = {
  '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '401': { description: 'Missing or invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '403': { description: 'API key lacks the required scope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
};

function queryParams(schema: z.ZodObject<any>) {
  const js = json(schema, 'input') as { properties: Record<string, any>; required?: string[] };
  return Object.entries(js.properties).map(([name, s]) => ({
    name,
    in: 'query',
    required: js.required?.includes(name) ?? false,
    description: s.description,
    schema: { ...s, description: undefined },
  }));
}
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
const scope = (s: string) => [{ apiKey: [s] }];

export function buildOpenApi(opts: { serverUrl: string; sandbox: boolean }) {
  const paths: Record<string, unknown> = {
    '/v1/merchant/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List your orders',
        description: 'Newest first. For polling, pass `since` = the time of your last poll.',
        security: scope('orders:read'),
        parameters: queryParams(S.MerchantOrdersQuery),
        responses: { ...ok(z.array(S.MerchantOrder)), ...errors },
      },
    },
    '/v1/merchant/orders/{id}': {
      get: { tags: ['Orders'], summary: 'Get one order', security: scope('orders:read'), parameters: [idParam()], responses: { ...ok(S.MerchantOrder), ...errors } },
    },
    '/v1/merchant/orders/{id}/deliver': {
      post: {
        tags: ['Orders'],
        summary: 'Deliver a paid order',
        description: 'Starts the buyer’s 72-hour inspection window (14 days for accounts). Only orders in status `paid`.',
        security: scope('orders:write'),
        parameters: [idParam()],
        requestBody: body(S.DeliverBody),
        responses: { '200': { description: 'Delivered' }, ...errors, '409': { description: 'Order is not in status paid' }, '423': { description: 'Order is under security review' } },
      },
    },
    '/v1/merchant/inventory': {
      post: {
        tags: ['Inventory'],
        summary: 'Upload stock for instant delivery',
        description: 'Up to 10,000 items per request. Items are encrypted at rest; exact duplicates of items you uploaded before are skipped.',
        security: scope('inventory:write'),
        requestBody: body(S.InventoryUploadBody),
        responses: { ...ok(S.InventoryResult), ...errors },
      },
    },
    '/v1/merchant/prices': {
      patch: {
        tags: ['Listings'],
        summary: 'Change prices in bulk',
        description: 'Up to 500 updates. Pass `version` to avoid overwriting a newer edit; conflicting items come back with `ok: false`.',
        security: scope('offers:write'),
        requestBody: body(S.PricesBody),
        responses: { ...ok(S.PricesResult), ...errors },
      },
    },
    '/v1/merchant/chat/{id}/messages': {
      post: {
        tags: ['Chat'],
        summary: 'Send a message in an order chat',
        description: 'Use the order’s `chat_room_id`. Sharing external contacts or payment methods is flagged and repeated attempts suspend the account.',
        security: scope('chat:write'),
        parameters: [idParam()],
        requestBody: body(S.ChatMessageBody),
        responses: { '201': { description: 'Sent' }, ...errors },
      },
    },
    '/v1/merchant/invoices': {
      get: { tags: ['Reports'], summary: 'List your commission invoices', security: scope('reports:read'), responses: { '200': { description: 'Newest first' }, ...errors } },
    },
    '/v1/merchant/invoices/{id}/pdf': {
      get: {
        tags: ['Reports'],
        summary: 'Download an invoice as PDF',
        security: scope('reports:read'),
        parameters: [idParam()],
        responses: { '200': { description: 'PDF', content: { 'application/pdf': {} } }, ...errors, '404': { description: 'Not found' } },
      },
    },
    '/v1/merchant/reports/{kind}': {
      get: {
        tags: ['Reports'],
        summary: 'Accounting export: sales, statement, payouts or invoices',
        description:
          'CSV (default) or JSON. Amounts are integer cents with a currency column. `statement` is your balance ledger with opening, running and closing balances; `sales` includes commission, the tax inside it, and what was credited in your payout currency.',
        security: scope('reports:read'),
        parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['sales', 'statement', 'payouts', 'invoices', 'credit_notes'] } }, ...queryParams(S.ExportQuery)],
        responses: { '200': { description: 'The export', content: { 'text/csv': {}, 'application/json': {} } }, ...errors },
      },
    },
    '/v1/merchant/webhooks/deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhook deliveries',
        description: 'Defaults to deliveries that are failing and still being retried. Includes the payload, last HTTP status and error.',
        security: scope('webhooks:manage'),
        parameters: queryParams(S.WebhookDeliveriesQuery),
        responses: { '200': { description: 'Deliveries, newest first' }, ...errors },
      },
    },
    '/v1/merchant/webhooks/deliveries/{id}/redeliver': {
      post: {
        tags: ['Webhooks'],
        summary: 'Send a delivery again now',
        description: 'Resets its retry budget. The event id (and `Idempotency-Key`) is unchanged, so you can de-duplicate.',
        security: scope('webhooks:manage'),
        parameters: [idParam()],
        responses: { '200': { description: 'Queued' }, ...errors, '404': { description: 'Not yours, or the endpoint is disabled' } },
      },
    },
    '/v1/merchant/webhooks/{id}/replay': {
      post: {
        tags: ['Webhooks'],
        summary: 'Re-queue all dead deliveries of an endpoint',
        description: 'Use after fixing an outage on your side. Up to 5,000 of the newest dead deliveries.',
        security: scope('webhooks:manage'),
        parameters: [idParam()],
        requestBody: { required: false, content: { 'application/json': { schema: json(S.ReplayBody, 'input') } } },
        responses: { '200': { description: '`{ requeued }`' }, ...errors },
      },
    },
  };

  if (opts.sandbox) {
    const sb = (summary: string, extra: Record<string, unknown> = {}) => ({ tags: ['Sandbox'], summary, security: [{ apiKey: [] }], responses: { '200': { description: 'OK' }, ...errors }, ...extra });
    Object.assign(paths, {
      '/v1/sandbox/verify-me': { post: sb('Mark your sandbox account identity-verified with payouts enabled') },
      '/v1/sandbox/orders': { post: sb('A simulated buyer buys and pays for one of your listings', { requestBody: body(SandboxOrderBody) }) },
      '/v1/sandbox/orders/{id}/confirm': { post: sb('Simulated buyer confirms receipt (releases escrow)', { parameters: [idParam()] }) },
      '/v1/sandbox/orders/{id}/dispute': { post: sb('Simulated buyer opens a dispute', { parameters: [idParam()] }) },
      '/v1/sandbox/orders/{id}/expire-protection': { post: sb('Jump to the end of the protection window', { parameters: [idParam()] }) },
      '/v1/sandbox/orders/{id}/chargeback': { post: sb('Simulate a card chargeback', { parameters: [idParam()], requestBody: body(SandboxChargebackBody) }) },
      '/v1/sandbox/webhooks/flush': { post: sb('Deliver queued webhooks immediately') },
    });
  }

  const webhooks = Object.fromEntries(
    WEBHOOK_EVENTS.map((event) => [
      event,
      {
        post: {
          summary: event,
          description: (S.WEBHOOK_PAYLOADS[event] as z.ZodTypeAny).description,
          parameters: [
            { name: 'X-Hook-Signature', in: 'header', required: true, schema: { type: 'string' }, description: 'Hex HMAC-SHA256 of the raw request body, keyed with your endpoint secret. Compare in constant time.' },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' }, description: 'Equals the event id; the same on every retry.' },
            { name: 'X-Hook-Event', in: 'header', required: true, schema: { type: 'string' } },
            { name: 'X-Hook-Attempt', in: 'header', required: true, schema: { type: 'integer' } },
          ],
          requestBody: body(S.WEBHOOK_PAYLOADS[event]),
          responses: { '2XX': { description: 'Acknowledge. Anything else is retried with exponential backoff (30s up to 6h, 12 attempts).' } },
        },
      },
    ]),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'Bullizard Seller API',
      version: '1.0.0',
      description:
        'Automate your shop: read orders, upload stock, change prices, deliver and reply to buyers. ' +
        'Create API keys in the web app under API (identity-verified sellers only). Every API action is recorded exactly like a website action.' +
        (opts.sandbox ? '\n\nThis is the **sandbox**: payments and identity checks are simulated; no real money moves.' : ''),
    },
    servers: [{ url: opts.serverUrl }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'API key: `Authorization: Bearer mk_<prefix>_<secret>`. Scopes are set when the key is created.' },
      },
      schemas: { Error: json(S.ErrorResponse) },
    },
    paths,
    webhooks,
  };
}
