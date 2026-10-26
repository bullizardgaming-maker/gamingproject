import * as Sentry from '@sentry/node';
import { pino, type Logger as PinoLogger } from 'pino';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Config } from './config.js';
import type { Ctx, Logger } from './context.js';
import { many, maybeOne } from './db.js';

// ---------------------------------------------------------------------------
// Logging: JSON lines with secrets redacted.
// ---------------------------------------------------------------------------
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.refreshToken',
  '*.secret',
  '*.payload',
];

/** Keys that are secrets wherever they sit in a log object (Round 23d, item 14: nested too). */
export const SENSITIVE_KEYS = new Set(['password', 'newpassword', 'currentpassword', 'token', 'refreshtoken', 'mfatoken', 'secret', 'payload', 'authorization', 'cookie', 'set-cookie', 'state', 'api-key', 'apikey', 'otp', 'totp', 'recoverycode', 'otpcode', 'mfacode', 'verificationcode', 'authcode', 'oauthcode', 'card', 'pan', 'ssn']);
/**
 * Round 23e (item 13): `code` is a secret only where a client sent it — a sign-in or 2FA code in a request body, an
 * OAuth code in a query string. Everywhere else (`err.code`, `error.code`, Postgres SQLSTATEs) it is an error code that
 * logs need, so it stays.
 */
const REQUEST_PARTS = new Set(['body', 'query', 'params']);
/** Query strings that carry credentials: OAuth callbacks (code, state), reset and confirm links (token). */
const SECRET_QUERY = /[?&](code|state|token|access_token|id_token|refresh_token)=/i;
export function redactUrl(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  return SECRET_QUERY.test(url) || /\/callback(\/|$)/.test(url.slice(0, i)) ? `${url.slice(0, i)}?[redacted]` : url;
}
export function deepRedact<T>(v: T, depth = 0, fromClient = false): T {
  if (depth > 10 || v === null || typeof v !== 'object') return v;
  if (v instanceof Error || v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.map((x) => deepRedact(x, depth + 1, fromClient)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.has(key) || (fromClient && key === 'code')) out[k] = '[redacted]';
    else if (k === 'url' && typeof val === 'string') out[k] = redactUrl(val);
    else out[k] = deepRedact(val, depth + 1, fromClient || REQUEST_PARTS.has(key));
  }
  return out as T;
}

export function createLogger(cfg: Config): PinoLogger {
  return pino({
    level: cfg.LOG_LEVEL,
    base: { service: 'bullizard-api', env: cfg.APP_ENV },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { log: (obj) => deepRedact(obj) },
    serializers: {
      req: (req: { method?: string; url?: string; id?: unknown; headers?: Record<string, unknown>; remoteAddress?: string }) => ({
        id: req.id,
        method: req.method,
        url: redactUrl(req.url ?? ''),
        remoteAddress: req.remoteAddress,
      }),
    },
  });
}

/** Adapts pino to the (obj, msg) Logger interface domain code uses. */
export function asCtxLogger(log: PinoLogger): Logger {
  return {
    info: (o, m) => log.info(o as object, m),
    warn: (o, m) => log.warn(o as object, m),
    error: (o, m) => {
      log.error(o as object, m);
      const err = (o as any)?.err;
      if (err instanceof Error) Sentry.captureException(err, { extra: { message: m } });
      else if (m) Sentry.captureMessage(m, 'error');
    },
  };
}

// ---------------------------------------------------------------------------
// Error tracking
// ---------------------------------------------------------------------------
let sentryOn = false;
export function initSentry(cfg: Config) {
  if (!cfg.SENTRY_DSN || sentryOn) return;
  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.APP_ENV,
    tracesSampleRate: cfg.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend(event) {
      // Never ship credentials or cookies to the error tracker.
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      if (event.request) delete event.request.data;
      return event;
    },
  });
  sentryOn = true;
}
export const captureException = (err: unknown, extra?: Record<string, unknown>) => sentryOn && Sentry.captureException(err, { extra });

// ---------------------------------------------------------------------------
// Metrics (Prometheus). One registry per app instance.
// ---------------------------------------------------------------------------
export function createMetrics(ctx: Ctx) {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'bullizard-api' });
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const httpErrors = new Counter({ name: 'http_server_errors_total', help: '5xx responses', labelNames: ['route'], registers: [registry] });

  // Business health, computed on scrape.
  const gauges: Array<[string, string, () => Promise<Array<{ labels?: Record<string, string>; value: number }>>]> = [
    ['db_replica_lag_seconds', 'Replication lag of the read replica (-1 if unreachable; absent without a replica)', async () =>
      ctx.cfg.DATABASE_READ_URL ? [{ value: ctx.dbRead.lagSeconds ?? -1 }] : []],
    ['db_replica_in_use', '1 when stale-tolerant reads are served by the replica, 0 when they fell back to the primary', async () =>
      ctx.cfg.DATABASE_READ_URL ? [{ value: ctx.dbRead.usingReplica ? 1 : 0 }] : []],
    ['escrow_held_cents', 'Buyer money currently held in escrow (fiat)', async () => [{ value: await scalar(`SELECT COALESCE(SUM(amount_cents), 0)::bigint AS v FROM orders WHERE rail = 'fiat' AND status IN ('paid', 'delivered', 'disputed')`) }]],
    ['disputes_open', 'Open disputes', async () => [{ value: await scalar(`SELECT count(*)::int AS v FROM disputes WHERE status = 'open'`) }]],
    ['disputes_oldest_open_seconds', 'Age of the oldest open dispute', async () => [{ value: await scalar(`SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::int AS v FROM disputes WHERE status = 'open'`) }]],
    ['chargebacks_due_within_7d', 'Chargebacks not yet submitted with a deadline within 7 days', async () => [{ value: await scalar(`SELECT count(*)::int AS v FROM chargebacks WHERE status IN ('received', 'packet_ready') AND respond_by < now() + interval '7 days'`) }]],
    ['risk_flags_open', 'Fraud flags awaiting review', async () => [{ value: await scalar(`SELECT count(*)::int AS v FROM risk_flags WHERE status = 'open'`) }]],
    ['orders_paid_undelivered_1h', 'Paid orders not delivered after 1h (not under review)', async () => [{ value: await scalar(`SELECT count(*)::int AS v FROM orders WHERE status = 'paid' AND NOT escrow_frozen AND paid_at < now() - interval '1 hour'`) }]],
    ['emails', 'Emails by status (failed: last 24h)', async () => {
      const rows = await many<{ status: string; v: number }>(ctx.dbRead, `SELECT status, count(*)::int AS v FROM notifications WHERE status = 'pending' OR (status = 'failed' AND created_at > now() - interval '24 hours') GROUP BY status`);
      return ['pending', 'failed'].map((s) => ({ labels: { status: s }, value: rows.find((r) => r.status === s)?.v ?? 0 }));
    }],
    ['reconciliation_last_status', 'Last reconciliation: 0 ok, 1 mismatch, 2 error, -1 never run', async () => {
      const r = await maybeOne<{ status: string }>(ctx.dbRead, `SELECT status FROM reconciliation_runs WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1`);
      return [{ value: r ? { ok: 0, mismatch: 1, error: 2 }[r.status as 'ok'] ?? 2 : -1 }];
    }],
    ['reconciliation_last_run_age_seconds', 'Seconds since the last finished reconciliation', async () => [{ value: await scalar(`SELECT COALESCE(EXTRACT(EPOCH FROM now() - max(finished_at)), -1)::int AS v FROM reconciliation_runs WHERE finished_at IS NOT NULL`) }]],
    ['worker_job_last_success_age_seconds', 'Seconds since each background job last succeeded', async () => {
      const rows = await many<{ job: string; v: number }>(ctx.dbRead, `SELECT job, EXTRACT(EPOCH FROM now() - last_ok_at)::int AS v FROM worker_heartbeats`);
      return rows.map((r) => ({ labels: { job: r.job }, value: r.v }));
    }],
  ];

  async function scalar(sql: string) {
    return (await maybeOne<{ v: number }>(ctx.dbRead, sql))?.v ?? 0;
  }

  for (const [name, help, read] of gauges) {
    new Gauge({
      name: `bullizard_${name}`,
      help,
      labelNames: ['status', 'job'],
      registers: [registry],
      async collect() {
        this.reset();
        for (const s of await read()) {
          if (s.labels) this.set(s.labels, s.value);
          else this.set(s.value);
        }
      },
    });
  }

  return { registry, httpDuration, httpErrors };
}

// ---------------------------------------------------------------------------
// Worker heartbeats
// ---------------------------------------------------------------------------
export async function heartbeat(ctx: Ctx, job: string, error?: unknown) {
  if (error) {
    await ctx.db.query(
      `INSERT INTO worker_heartbeats (job, last_ok_at, last_error, last_error_at) VALUES ($1, to_timestamp(0), $2, now())
         ON CONFLICT (job) DO UPDATE SET last_error = $2, last_error_at = now()`,
      [job, String((error as Error)?.message ?? error).slice(0, 500)],
    );
  } else {
    await ctx.db.query(
      `INSERT INTO worker_heartbeats (job, last_ok_at) VALUES ($1, now()) ON CONFLICT (job) DO UPDATE SET last_ok_at = now()`,
      [job],
    );
  }
}
