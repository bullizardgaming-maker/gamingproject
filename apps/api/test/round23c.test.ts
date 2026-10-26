import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { createContext } from '../src/context.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { LOCALES } from '../src/domain/locales/index.js';
import { TEMPLATES, render, type TemplateName } from '../src/domain/notifications.js';
import type { CaptchaVerifier } from '../src/providers/captcha.js';
import { buildApp } from '../src/server.js';
import { TEMPLATE_DATA } from './fixtures/template-data.js';
import { client, makeUser, setup, type Harness } from './helpers.js';

/** Round 23c: follow-ups 11–13, no seller API (CEO), staging test workflows. */
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(repo(p), 'utf8');
const silent = { info() {}, warn() {}, error() {} };

const prodEnv = (extra: Record<string, string> = {}) =>
  ({
    NODE_ENV: 'production',
    JWT_SECRET: 'x'.repeat(40),
    DATA_ENCRYPTION_KEYS: 'v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=',
    FINGERPRINT_KEY: 'fp',
    CRYPTO_INDEXER_SECRET: 'idx',
    PLATFORM_ACCOUNTS: 'live',
    MALWARE_SCANNER: 'clamd',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test',
    SMS_PROVIDER: 'twilio',
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    ORIGIN_SHARED_SECRET: 'origin',
    ...extra,
  }) as any;
const stagingEnv = (extra: Record<string, string> = {}) =>
  prodEnv({ APP_ENV: 'staging', MALWARE_SCANNER: 'dev', SANDBOX_MODE: 'true', PLATFORM_ACCOUNTS: 'mock', PAYMENT_PROVIDER: 'mock', KYC_PROVIDER: 'mock', SMS_PROVIDER: 'console', ...extra });

let h: Harness;
beforeAll(async () => {
  h = await setup({ SANDBOX_MODE: 'true' });
});
afterAll(async () => h.close());

describe('follow-up 11: a blank optional key means unset', () => {
  /** Keys a Render blueprint leaves to the dashboard (`sync: false`). */
  const syncFalseKeys = (file: string) => {
    const doc = parseYaml(read(file));
    const vars = [...(doc.envVarGroups ?? []).flatMap((g: any) => g.envVars), ...(doc.services ?? []).flatMap((s: any) => s.envVars ?? [])];
    return [...new Set(vars.filter((v: any) => v.sync === false).map((v: any) => v.key as string))];
  };
  // What each deployment cannot start without; every other sync:false key is optional.
  const REQUIRED = new Set(['DATA_ENCRYPTION_KEYS', 'RESEND_API_KEY', 'TURNSTILE_SECRET', 'ORIGIN_SHARED_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']);

  it('boots with every optional sync:false key of render.yaml (staging) and render.production.yaml set to ""', () => {
    for (const [file, base] of [['render.yaml', stagingEnv()], ['render.production.yaml', prodEnv()]] as const) {
      const optional = syncFalseKeys(file).filter((k) => !REQUIRED.has(k));
      expect(optional, file).toEqual(expect.arrayContaining(['BREVO_API_KEY', 'BREVO_LIST_ID_EN', 'BREVO_LIST_ID_AR']));
      const blanks = Object.fromEntries(optional.map((k) => [k, '']));
      const cfg = loadConfig({ ...base, ...blanks });
      expect(cfg.BREVO_LIST_ID_EN, file).toBeUndefined();
      expect(cfg.BREVO_LIST_ID_AR, file).toBeUndefined();
      expect(cfg.BREVO_API_KEY, file).toBeUndefined();
      for (const k of optional) {
        const v = (cfg as any)[k];
        expect(v === '' || v === 0, `${file}: ${k} must be unset, got ${JSON.stringify(v)}`).toBe(false);
      }
    }
  });

  it('applies to every optional key, numbers and defaults included; set values still parse', () => {
    const cfg = loadConfig({ PORT: '', RATE_LIMIT_PER_MINUTE: ' ', SENTRY_DSN: '', BREVO_LIST_ID_EN: '', PUBLIC_WEB_URL: '', LOG_LEVEL: '' } as any);
    expect(cfg).toMatchObject({ PORT: 4000, RATE_LIMIT_PER_MINUTE: 300, PUBLIC_WEB_URL: 'http://localhost:5173', LOG_LEVEL: 'info' });
    expect(cfg.SENTRY_DSN).toBeUndefined();
    expect(cfg.BREVO_LIST_ID_EN).toBeUndefined();
    expect(loadConfig({ BREVO_LIST_ID_EN: '7', BREVO_LIST_ID_AR: '8' } as any)).toMatchObject({ BREVO_LIST_ID_EN: 7, BREVO_LIST_ID_AR: 8 });
    expect(() => loadConfig({ BREVO_LIST_ID_EN: '0' } as any)).toThrow(); // a real value is still checked
    expect(() => loadConfig(prodEnv({ JWT_SECRET: '' }))).toThrow(/JWT_SECRET must be set explicitly/); // blank is not "set"
  });
});

describe('follow-up 12: every email has an HTML and a plain-text part, Arabic right to left', () => {
  // Staff alerts (English only) read a few more fields.
  const STAFF_DATA = { ...TEMPLATE_DATA, alerts: [], summary: ['ok'], roles: ['support'], by: 'Admin', issues: 0, started_at: 'today', week_ending: '2026-10-25' };
  it('renders every template in every language as an HTML document plus text', () => {
    for (const locale of LOCALES) {
      for (const name of Object.keys(TEMPLATES) as TemplateName[]) {
        const r = render(h.ctx, name, STAFF_DATA, locale);
        const at = `${locale}:${name}`;
        expect(r.text.length, at).toBeGreaterThan(10);
        expect(r.html, at).toMatch(new RegExp(`^<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">`));
        expect(r.html, at).toContain('<meta charset="utf-8">');
        expect(r.html, at).toContain('</body></html>');
        // The same words in both parts (first line of the text, HTML-escaped).
        const first = r.text.split('\n')[0]!.split(/https?:\/\//)[0]!.slice(0, 40).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        expect(r.html, at).toContain(first);
      }
    }
  });

  it('the verification-code email has the same layout (Arabic: dir="rtl" lang="ar")', async () => {
    for (const locale of ['ar', 'en'] as const) {
      const u = await makeUser(h, { tier: 0 });
      await u.api.put('/v1/me/locale', { locale });
      await u.api.post('/v1/verify/email/send');
      const mail = h.messenger.lastTo(u.email)!;
      expect(mail.body).toMatch(/\d{6}/);
      expect(mail.html).toMatch(new RegExp(`<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">`));
      expect(mail.html).toContain(mail.body.match(/\d{6}/)![0]);
    }
  });
});

describe('follow-up 13: a build URL that is not a URL names the variable', () => {
  it('vite.config.ts fails with "VITE_API_URL must be an https URL, got …"', async () => {
    const vite = await import('../../web/vite.config.ts');
    expect(() => vite.csp('false')).toThrow("VITE_API_URL must be an https URL, got 'false'");
    expect(() => vite.csp('https://api.bullizard.com', { uploadOrigin: 'false' })).toThrow("VITE_UPLOAD_ORIGIN must be an https URL, got 'false'");
    expect(() => vite.csp('ftp://api.bullizard.com')).toThrow(/VITE_API_URL must be an https URL/);
    expect(() => vite.csp('http://api.bullizard.com')).toThrow(/VITE_API_URL must be an https URL/);
    expect(vite.csp('https://api-staging.bullizard.com/v1', { uploadOrigin: 'https://acc.r2.cloudflarestorage.com/bucket' })).toContain(
      'connect-src \'self\' ws: wss: https://api-staging.bullizard.com wss://api-staging.bullizard.com https://acc.r2.cloudflarestorage.com',
    );
    expect(vite.csp('http://localhost:4000')).toContain('http://localhost:4000'); // local builds
  });
});

describe('no seller API (CEO, Round 23c)', () => {
  it('has no API keys, merchant routes, seller webhooks or public API docs; provider callbacks remain', async () => {
    const seller = await makeUser(h, { tier: 2 });
    for (const [method, url] of [
      ['GET', '/v1/developer/api-keys'], ['POST', '/v1/developer/api-keys'], ['GET', '/v1/developer/webhooks'], ['POST', '/v1/developer/webhooks'],
      ['GET', '/v1/merchant/orders'], ['PATCH', '/v1/merchant/prices'], ['GET', '/v1/merchant/webhooks/deliveries'],
      ['GET', '/v1/openapi.json'], ['GET', '/v1/docs/'], ['POST', '/v1/sandbox/webhooks/flush'],
    ] as const) {
      expect(h.app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      const res = await h.app.inject({ method, url, headers: { authorization: `Bearer ${seller.token}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // An mk_ key is just an invalid session token now.
    expect((await client(h.app, 'mk_abcdefgh_' + 'x'.repeat(30)).get('/v1/me')).status).toBe(401);
    expect(h.app.hasRoute({ method: 'POST', url: '/v1/payments/webhook/:provider' })).toBe(true); // NOWPayments IPN
    expect(h.app.hasRoute({ method: 'POST', url: '/v1/sandbox/orders' })).toBe(true); // staging test helpers stay
    expect((await client(h.app).get('/v1/features')).body).not.toHaveProperty('merchantApi');
  });

  it('migration 074 dropped the tables; config, SDKs and the Developers page are gone', async () => {
    const { rows } = await h.ctx.db.query(`SELECT to_regclass('api_keys') AS a, to_regclass('webhook_endpoints') AS b, to_regclass('webhook_deliveries') AS c`);
    expect(rows[0]).toEqual({ a: null, b: null, c: null });
    expect(loadConfig({ MERCHANT_API_ENABLED: 'true' } as any)).not.toHaveProperty('MERCHANT_API_ENABLED');
    expect(existsSync(repo('sdks'))).toBe(false);
    expect(existsSync(repo('apps/web/src/pages/Developers.tsx'))).toBe(false);
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/sdk/i);
    for (const f of ['render.yaml', 'render.production.yaml', '.env.example', 'apps/web/src/demo/mock.ts', 'apps/web/src/main.tsx', 'apps/web/src/lib/features.ts']) {
      expect(read(f), f).not.toMatch(/MERCHANT_API|merchantApi|\/developer\/|developers/);
    }
    for (const f of readdirSync(repo('apps/web/src/i18n'))) expect(read(`apps/web/src/i18n/${f}`), f).not.toMatch(/api key|developers|webhook|\bSDK\b/i);
  });
});

describe('staging test logins (STAGING_TEST_TOKEN)', () => {
  const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(8);

  it('is only accepted with APP_ENV=staging, never in production', () => {
    expect(loadConfig(stagingEnv({ STAGING_TEST_TOKEN: TOKEN })).STAGING_TEST_TOKEN).toBe(TOKEN);
    expect(loadConfig(stagingEnv({ STAGING_TEST_TOKEN: '' })).STAGING_TEST_TOKEN).toBeUndefined();
    expect(() => loadConfig(prodEnv({ STAGING_TEST_TOKEN: TOKEN }))).toThrow(/STAGING_TEST_TOKEN is only allowed with APP_ENV=staging/);
    expect(() => loadConfig(prodEnv({ APP_ENV: 'production', STAGING_TEST_TOKEN: TOKEN }))).toThrow(/only allowed with APP_ENV=staging/);
    expect(() => loadConfig({ STAGING_TEST_TOKEN: TOKEN } as any)).toThrow(/only allowed with APP_ENV=staging/); // development, test
    expect(() => loadConfig(stagingEnv({ STAGING_TEST_TOKEN: 'short' }))).toThrow(/at least 32 characters/);
    // The production blueprint does not carry it at all.
    expect(read('render.production.yaml')).not.toContain('STAGING_TEST_TOKEN');
    expect(read('render.yaml')).toContain('key: STAGING_TEST_TOKEN');
  });

  it('a sign-in with X-Staging-Test-Token skips Turnstile on staging only', async () => {
    const failing: CaptchaVerifier = { enabled: true, verify: async () => false } as any;
    const base = loadConfig({ TRUST_PROXY: 'true', RATE_LIMIT_PER_MINUTE: '100000', AUTH_RATE_LIMIT_PER_MINUTE: '100000' } as any);
    const mk = async (cfg: Config) => {
      const app = await buildApp(createContext({ ...cfg, CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_AFTER_FAILED_LOGINS: 0 }, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), messenger: h.messenger, captcha: failing }));
      await app.ready();
      return app;
    };
    const staging = await mk({ ...base, APP_ENV: 'staging', STAGING_TEST_TOKEN: TOKEN });
    // Belt and braces: even if a production config somehow carried the token, the route ignores it.
    const production = await mk({ ...base, APP_ENV: 'production', STAGING_TEST_TOKEN: TOKEN });
    try {
      const u = await makeUser(h);
      const creds = { email: u.email, password: 'correct horse battery' };
      expect((await client(staging).post('/v1/auth/login', creds)).body.error.code).toBe('captcha_required');
      expect((await client(staging, undefined, { 'x-staging-test-token': TOKEN.slice(0, -1) + 'x' }).post('/v1/auth/login', creds)).body.error.code).toBe('captcha_required');
      expect((await client(staging, undefined, { 'x-staging-test-token': TOKEN.slice(0, 20) }).post('/v1/auth/login', creds)).body.error.code).toBe('captcha_required');
      const ok = await client(staging, undefined, { 'x-staging-test-token': TOKEN }).post('/v1/auth/login', creds);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.token).toBeTruthy();
      expect((await client(production, undefined, { 'x-staging-test-token': TOKEN }).post('/v1/auth/login', creds)).body.error.code).toBe('captcha_required');
    } finally {
      await staging.close();
      await production.close();
    }
  });
});

describe('staging test workflows', () => {
  const ALLOWED_SECRETS = new Set([
    'STAGING_TEST_TOKEN', 'STAGING_STAFF_EMAIL', 'STAGING_STAFF_PASSWORD', 'STAGING_STAFF_TOTP_SECRET',
    'STAGING_BUYER_EMAIL', 'STAGING_BUYER_PASSWORD', 'STAGING_SELLER_EMAIL', 'STAGING_SELLER_PASSWORD',
  ]);
  const FILES = ['staging-money-paths.yml', 'staging-zap.yml', 'staging-load.yml', 'staging-kill-switch.yml'];

  it('are manual, staging-only, serialized, and read credentials only from secrets', () => {
    for (const f of FILES) {
      const text = read(`.github/workflows/${f}`);
      const wf = parseYaml(text);
      expect(wf.on, f).toHaveProperty('workflow_dispatch');
      expect(wf.on.schedule, `${f}: the schedule stays off`).toBeUndefined();
      expect(wf.concurrency, f).toMatchObject({ group: 'staging-tests', 'cancel-in-progress': false });
      expect(wf.permissions, f).toEqual({ contents: 'read' });
      const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]!);
      expect(secrets.length, f).toBeGreaterThan(0);
      for (const s of secrets) expect(ALLOWED_SECRETS.has(s), `${f}: ${s}`).toBe(true);
      expect(text, f).not.toMatch(/ORIGIN|X-Origin-Auth|api\.bullizard\.com/); // through Cloudflare like any client; never production
      expect(text, f).toContain('api-staging.bullizard.com');
      expect(text, f).not.toMatch(/echo .*\$\{\{ *secrets|set -x/); // never printed
    }
    const kill = parseYaml(read('.github/workflows/staging-kill-switch.yml'));
    const last = kill.jobs['kill-switch'].steps.at(-1);
    expect(last).toMatchObject({ if: 'always()', run: 'npx tsx scripts/kill-switch.ts --resume-only' });
  });

  it('the ZAP plan seeds the API without an OpenAPI document and signs in with the test token', () => {
    const plan = parseYaml(read('security/zap/zap-staging.yaml'));
    const types = plan.jobs.map((j: any) => j.type);
    expect(types).not.toContain('openapi');
    expect(types.slice(0, 2)).toEqual(['replacer', 'requestor']);
    expect(plan.jobs[0].rules[0]).toMatchObject({ matchType: 'req_header', matchString: 'X-Staging-Test-Token', replacementString: '${STAGING_TEST_TOKEN}' });
    expect(plan.jobs.find((j: any) => j.type === 'exitStatus').parameters.errorLevel).toBe('high');
    expect(plan.env.contexts[0].excludePaths).toEqual(expect.arrayContaining(['${STAGING_API}/v1/payments/.*', '${STAGING_API}/v1/admin/.*', '${STAGING_API}/v1/sandbox/.*']));
  });
});
