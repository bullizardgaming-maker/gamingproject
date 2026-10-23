import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().optional(), // defaults to http://localhost:PORT
  // Requests per minute per client IP (general limit; auth endpoints are stricter).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  // Which proxies may set X-Forwarded-For: "false" (direct), a hop count ("1" behind one
  // load balancer) or comma-separated addresses/CIDRs. Trusting everyone would let any
  // client pick its own IP and dodge rate limits and fraud checks.
  TRUST_PROXY: z.string().default('false'),
  // Header carrying the client's country, set by the edge (e.g. cf-ipcountry). Ignored unless set.
  GEO_COUNTRY_HEADER: z.string().toLowerCase().optional(),
  // Failed password/2FA attempts before an account is locked for a while (doubles each time).
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  // Bot checks: sign-up and password reset always; sign-in after this many failures from one IP in 15 minutes.
  CAPTCHA_PROVIDER: z.enum(['none', 'turnstile', 'hcaptcha']).default('none'),
  CAPTCHA_SITE_KEY: z.string().optional(),
  CAPTCHA_SECRET: z.string().optional(),
  CAPTCHA_AFTER_FAILED_LOGINS: z.coerce.number().int().min(1).default(3),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  // Bearer token required to scrape /metrics. Without it /metrics is disabled in production.
  METRICS_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().default('postgres://market:market@localhost:5432/market'),
  // Streaming replica for search, listings, profiles and metrics. Falls back to the primary if it lags.
  DATABASE_READ_URL: z.string().optional(),
  REPLICA_MAX_LAG_SECONDS: z.coerce.number().min(0).default(10),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-please-0000'),
  // Keyring for AES-256-GCM field encryption: "v1:<base64 32 bytes>,v2:<base64 32 bytes>". Last key encrypts.
  DATA_ENCRYPTION_KEYS: z.string().default('v1:ZGV2LW9ubHktZGF0YS1rZXktMzItYnl0ZXMtLS0tLS0='),
  // Separate key for deterministic fingerprints (inventory de-dup) and API key hashing.
  FINGERPRINT_KEY: z.string().default('dev-only-fingerprint-key'),
  // Linking Steam / Riot accounts to listings (domain/linkedAccounts.ts). Mock completes without
  // leaving the site; only allowed in production together with SANDBOX_MODE.
  PLATFORM_ACCOUNTS: z.enum(['mock', 'live']).default('mock'),
  STEAM_WEB_API_KEY: z.string().optional(),
  RIOT_CLIENT_ID: z.string().optional(),
  RIOT_CLIENT_SECRET: z.string().optional(),
  RIOT_ACCOUNT_REGION: z.enum(['americas', 'asia', 'europe']).default('europe'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe', 'nowpayments']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // NOWPayments (crypto in and out). Sandbox: https://api-sandbox.nowpayments.io with a sandbox account's key.
  NOWPAYMENTS_API_KEY: z.string().optional(),
  NOWPAYMENTS_IPN_SECRET: z.string().optional(),
  NOWPAYMENTS_API_URL: z.string().default('https://api.nowpayments.io'),
  NOWPAYMENTS_EMAIL: z.string().optional(),            // account login, needed for payouts
  NOWPAYMENTS_PASSWORD: z.string().optional(),
  NOWPAYMENTS_2FA_SECRET: z.string().optional(),       // base32; payouts are verified automatically with it
  NOWPAYMENTS_OUTCOME_CURRENCY: z.string().default('usdttrc20'),
  NOWPAYMENTS_SANDBOX_CASE: z.string().optional(),     // sandbox only: success | partially_paid | failed
  /** Seller withdrawals: fee in basis points, with a floor in settlement minor units (6%, at least $1.50). */
  WITHDRAWAL_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(600),
  WITHDRAWAL_FEE_MIN_CENTS: z.coerce.number().int().min(0).default(150),
  /** The on-chain MarketEscrow rail (USDC/USDT with the contract). Off at launch; NOWPayments covers crypto. */
  ONCHAIN_ESCROW_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Sellers must attach a photo/video of an in-game delivery before marking it delivered.
  DELIVERY_PROOF_REQUIRED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Seller Merchant API (API keys, webhooks, /v1/docs, the Developers page). Off at launch; the code stays. */
  MERCHANT_API_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Network-fee estimates shown at checkout (USD per coin code, buyer pays on top); JSON, e.g. {"usdttrc20":1,"eth":4}. */
  CRYPTO_NETWORK_FEES_JSON: z.string().default('{}'),
  /** Underpayments within this share of the price are accepted as paid in full (network dust, rounding). */
  CRYPTO_UNDERPAY_TOLERANCE_BPS: z.coerce.number().int().min(0).max(500).default(50),
  KYC_PROVIDER: z.enum(['mock', 'sumsub']).default('mock'),
  SUMSUB_APP_TOKEN: z.string().optional(),
  SUMSUB_SECRET_KEY: z.string().optional(),
  SUMSUB_WEBHOOK_SECRET: z.string().optional(),
  SUMSUB_LEVEL_NAME: z.string().default('basic-kyc-level'),
  EMAIL_PROVIDER: z.enum(['console', 'postmark']).default('console'),
  EMAIL_FROM: z.string().default('Bullizard <no-reply@bullizard.local>'),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  // Web Push (VAPID). Generate keys: npx web-push generate-vapid-keys. Push is off without them.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@bullizard.local'),
  PUSH_ALLOWED_HOSTS: z
    .string()
    .default('fcm.googleapis.com,updates.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com'),
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  // Sandbox deployments expose /v1/sandbox/* for sellers testing bots. Requires the mock payment provider.
  SANDBOX_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Undelivered manual orders are refunded automatically this long after the promised delivery time.
  // Days released money waits before it can be withdrawn, by seller track record (see domain/payoutholds.ts).
  PAYOUT_HOLD_DAYS_NEW: z.coerce.number().int().min(0).max(90).default(7),
  PAYOUT_HOLD_DAYS_ESTABLISHED: z.coerce.number().int().min(0).max(90).default(3),
  PAYOUT_HOLD_DAYS_TRUSTED: z.coerce.number().int().min(0).max(90).default(0),
  PAYOUT_HOLD_DAYS_WATCH: z.coerce.number().int().min(0).max(90).default(14),
  LATE_AUTO_REFUND_HOURS: z.coerce.number().int().min(1).default(48),
  // Seller debt collection: reminder days after a balance goes negative, then pause the shop.
  DEBT_REMINDER_DAYS: z.string().default('0,3,7').transform((v) => v.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)),
  DEBT_PAUSE_AFTER_DAYS: z.coerce.number().min(0).default(14),
  DEBT_CHECK_MINUTES: z.coerce.number().min(1).default(60),
  WATCH_CHECK_MINUTES: z.coerce.number().min(1).default(15).describe('How often price alerts are checked'),
  // Currencies & FX. Everything internal (escrow, ledger, balances) is in SETTLEMENT_CURRENCY.
  SETTLEMENT_CURRENCY: z.string().length(3).default('USD'),
  SUPPORTED_CURRENCIES: z.string().default('USD,EUR,EGP'),
  // ecb covers EUR; EGP is not an ECB currency, so 'live' merges ECB with the open exchange-rate API.
  FX_PROVIDER: z.enum(['static', 'ecb', 'live']).default('static'),
  FX_STATIC_RATES: z.string().default('{"EUR":0.92,"EGP":48.5}'),
  FX_SPREAD_BPS: z.coerce.number().int().min(0).max(1000).default(100),
  FX_MAX_AGE_HOURS: z.coerce.number().default(48),
  // Buying EUR/EGP ahead of seller payouts (domain/fxtopups.ts). none = planning only, record conversions by hand.
  FX_EXCHANGE_PROVIDER: z.enum(['none', 'mock', 'wise']).default('none'),
  WISE_API_URL: z.string().default('https://api.transferwise.com'),
  WISE_API_TOKEN: z.string().optional(),
  WISE_PROFILE_ID: z.string().optional(),
  FX_TOPUP_BUFFER_BPS: z.coerce.number().int().min(0).max(10_000).default(500),
  FX_TOPUP_MIN_CENTS: z.coerce.number().int().min(1).default(10_000),
  // Proposals costing up to this much (settlement currency) execute without a person approving. 0 = always ask.
  FX_TOPUP_AUTO_APPROVE_CENTS: z.coerce.number().int().min(0).default(0),
  // Tax on commission and invoices. The platform's legal entity:
  PLATFORM_LEGAL_NAME: z.string().default('Bullizard Ltd'),
  PLATFORM_TAX_COUNTRY: z.string().length(2).toUpperCase().default('IE'),
  PLATFORM_VAT_ID: z.string().optional(),
  PLATFORM_ADDRESS: z.string().default(''),
  // Non-EU countries where the platform is registered for VAT/GST on digital services (e.g. "GB,NO").
  TAX_REGISTERED_COUNTRIES: z.string().default(''),
  VAT_VALIDATION: z.enum(['none', 'vies']).default('none'),
  INVOICE_SERIES: z.string().regex(/^[A-Z0-9-]{1,10}$/).default('BZ'),
  // AML. Sanctions lists: 'ofac' downloads the OFAC SDN list; SANCTIONS_EXTRA_LISTS adds others as
  // "name=url" pairs in the simple CSV format (ref,kind,name,program), e.g. EU/UK/UN exports from your data vendor.
  SANCTIONS_SOURCE: z.enum(['none', 'ofac']).default('none'),
  SANCTIONS_OFAC_SDN_URL: z.string().default('https://www.treasury.gov/ofac/downloads/sdn.csv'),
  SANCTIONS_OFAC_ALT_URL: z.string().default('https://www.treasury.gov/ofac/downloads/alt.csv'),
  SANCTIONS_EXTRA_LISTS: z.string().optional(),
  SANCTIONS_HOLD_SCORE: z.coerce.number().min(0).max(1).default(0.9),   // name similarity that pauses payouts
  SANCTIONS_REVIEW_SCORE: z.coerce.number().min(0).max(1).default(0.75), // opens a case for review only
  SANCTIONS_RESCREEN_DAYS: z.coerce.number().int().min(1).default(30),
  AML_RAPID_WITHDRAWAL_CENTS: z.coerce.number().int().default(500_000),
  AML_THRESHOLD_CENTS: z.coerce.number().int().default(100_000),         // structuring band: 80-100% of this
  AML_VOLUME_SPIKE_MIN_CENTS: z.coerce.number().int().default(500_000),
  AML_BUYER_CONCENTRATION_MIN_CENTS: z.coerce.number().int().default(200_000),
  AML_NEW_ACCOUNT_VOLUME_CENTS: z.coerce.number().int().default(300_000),
  // Promotions & referrals
  // Uploaded evidence (chat screenshots)
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  MALWARE_SCANNER: z.enum(['clamd', 'dev']).default('dev'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().default(3310),
  // Data retention (days). Orders, the ledger, payouts and chargebacks are kept for accounting
  // and legal claims and are not purged here; see docs/ARCHITECTURE.md.
  RETENTION_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  RETENTION_CHAT_DAYS: z.coerce.number().int().min(30).default(730),          // after the order closes
  RETENTION_INQUIRY_CHAT_DAYS: z.coerce.number().int().min(7).default(180),  // pre-sale chats, after the last message
  RETENTION_DELIVERED_ITEMS_DAYS: z.coerce.number().int().min(30).default(365),
  RETENTION_FRAUD_SIGNALS_DAYS: z.coerce.number().int().min(30).default(730),
  RETENTION_ORDER_IP_DAYS: z.coerce.number().int().min(30).default(540),     // chargebacks can arrive ~540 days later
  RETENTION_SESSIONS_DAYS: z.coerce.number().int().min(1).default(90),       // after expiry or sign-out
  RETENTION_NOTIFICATIONS_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_INBOX_DAYS: z.coerce.number().int().min(7).default(180),
  RETENTION_WEBHOOK_DELIVERIES_DAYS: z.coerce.number().int().min(1).default(90),
  // Weekly retention digest to staff with analytics access (Monday, UTC), with alerts when a rate crosses a line.
  COHORT_DIGEST_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  COHORT_ALERT_SELLER_CHURN_PCT: z.coerce.number().min(0).max(100).default(20), // alert when last month's seller churn is above this
  COHORT_ALERT_REPEAT_PCT: z.coerce.number().min(0).max(100).default(25),       // alert when the 90-day repeat rate is below this
  RETENTION_SECURITY_LOGS_DAYS: z.coerce.number().int().min(1).default(90),  // CSP reports, one-time codes, reset links
  RECON_INTERVAL_HOURS: z.coerce.number().default(24),
  RECON_TOLERANCE_CENTS: z.coerce.number().default(0),
  FRAUD_GNN_URL: z.string().optional(),
  // shadow: record the graph model's score next to the heuristic but act on the heuristic only.
  // enforce: act on the higher of the two. Switch to enforce once the model report backs it.
  FRAUD_GNN_MODE: z.enum(['off', 'shadow', 'enforce']).default('shadow'),
  // A completed order with no fraud signal this long after payment counts as legitimate (past chargeback windows).
  FRAUD_LABEL_LEGIT_DAYS: z.coerce.number().int().min(1).default(120),
  FRAUD_FREEZE_THRESHOLD: z.coerce.number().default(0.8),
  FRAUD_REVIEW_THRESHOLD: z.coerce.number().default(0.5),
  // Off-platform contact: the offence that bans (1 = instant ban on the first offence). Earlier ones warn.
  OFFPLATFORM_SUSPEND_STRIKES: z.coerce.number().int().min(1).default(3),
  ORDER_PAYMENT_TTL_MINUTES: z.coerce.number().default(30),
  TOS_VERSION: z.string().default('2026-09-01'),
  // Admin/arbiter actions need a session signed in with a second factor (PCI DSS 8.4). Defaults to on in production.
  STAFF_MFA_REQUIRED: z.enum(['true', 'false']).optional(),
  RUN_WORKER_IN_PROCESS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Web3 escrow
  ESCROW_CHAIN_ID: z.coerce.number().default(31337),
  ESCROW_CONTRACT_ADDRESS: z.string().default('0x0000000000000000000000000000000000000000'),
  // Who signs escrow terms: an AWS KMS secp256k1 key (production) or a private key in env (dev/tests).
  ESCROW_SIGNER: z.enum(['local', 'aws_kms']).default('local'),
  ESCROW_KMS_KEY_ID: z.string().optional(),
  ESCROW_SIGNER_PRIVATE_KEY: z.string().optional(),
  ESCROW_ALLOW_LOCAL_KEY_IN_PRODUCTION: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ESCROW_TOKEN_USDC: z.string().default('0x0000000000000000000000000000000000000000'),
  ESCROW_TOKEN_USDT: z.string().default('0x0000000000000000000000000000000000000000'),
  CRYPTO_INDEXER_SECRET: z.string().default('dev-only-indexer-secret'),
  ESCROW_RPC_URL: z.string().optional(),
  ESCROW_START_BLOCK: z.coerce.number().default(0),
});

export type Config = z.infer<typeof Env>;

/**
 * Local development reads `.env` from the repo root (or the current directory). Variables already
 * in the environment win, so Docker, Render and CI, which set them directly, are unaffected.
 */
function loadDotEnv() {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') return;
  for (const dir of [process.cwd(), resolve(process.cwd(), '..', '..')]) {
    const file = resolve(dir, '.env');
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch {
      /* unreadable .env: run on the environment alone */
    }
    return;
  }
}

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  loadDotEnv();
  const cfg = Env.parse({ ...process.env, ...overrides });
  if (cfg.SANDBOX_MODE && (cfg.PAYMENT_PROVIDER !== 'mock' || cfg.KYC_PROVIDER !== 'mock')) {
    throw new Error('SANDBOX_MODE requires PAYMENT_PROVIDER=mock and KYC_PROVIDER=mock');
  }
  if (cfg.NODE_ENV === 'production' && cfg.PLATFORM_ACCOUNTS === 'mock' && !cfg.SANDBOX_MODE) {
    throw new Error('PLATFORM_ACCOUNTS=live is required in production (mock links are for the sandbox)');
  }
  if (cfg.NODE_ENV === 'production' && cfg.MALWARE_SCANNER === 'dev') {
    throw new Error('MALWARE_SCANNER=clamd is required in production');
  }
  if (cfg.NODE_ENV === 'production' && cfg.ESCROW_SIGNER === 'local' && cfg.ESCROW_SIGNER_PRIVATE_KEY && !cfg.ESCROW_ALLOW_LOCAL_KEY_IN_PRODUCTION) {
    throw new Error('Use ESCROW_SIGNER=aws_kms in production: the escrow signing key must not sit in an environment variable');
  }
  if (cfg.ESCROW_SIGNER === 'aws_kms' && !cfg.ESCROW_KMS_KEY_ID) throw new Error('ESCROW_KMS_KEY_ID is required with ESCROW_SIGNER=aws_kms');
  if (cfg.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'DATA_ENCRYPTION_KEYS', 'FINGERPRINT_KEY', 'CRYPTO_INDEXER_SECRET'] as const) {
      if (!process.env[key]) throw new Error(`${key} must be set explicitly in production`);
    }
  }
  return cfg;
}
