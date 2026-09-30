import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().optional(), // defaults to http://localhost:PORT
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  // Bearer token required to scrape /metrics. Without it /metrics is disabled in production.
  METRICS_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().default('postgres://market:market@localhost:5432/market'),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-please-0000'),
  // Keyring for AES-256-GCM field encryption: "v1:<base64 32 bytes>,v2:<base64 32 bytes>". Last key encrypts.
  DATA_ENCRYPTION_KEYS: z.string().default('v1:ZGV2LW9ubHktZGF0YS1rZXktMzItYnl0ZXMtLS0tLS0='),
  // Separate key for deterministic fingerprints (inventory de-dup) and API key hashing.
  FINGERPRINT_KEY: z.string().default('dev-only-fingerprint-key'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  KYC_PROVIDER: z.enum(['mock', 'sumsub']).default('mock'),
  SUMSUB_APP_TOKEN: z.string().optional(),
  SUMSUB_SECRET_KEY: z.string().optional(),
  SUMSUB_WEBHOOK_SECRET: z.string().optional(),
  SUMSUB_LEVEL_NAME: z.string().default('basic-kyc-level'),
  EMAIL_PROVIDER: z.enum(['console', 'postmark']).default('console'),
  EMAIL_FROM: z.string().default('Bullizard <no-reply@bullizard.local>'),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  // Sandbox deployments expose /v1/sandbox/* for sellers testing bots. Requires the mock payment provider.
  SANDBOX_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Undelivered manual orders are refunded automatically this long after the promised delivery time.
  LATE_AUTO_REFUND_HOURS: z.coerce.number().int().min(1).default(48),
  // Currencies & FX. Everything internal (escrow, ledger, balances) is in SETTLEMENT_CURRENCY.
  SETTLEMENT_CURRENCY: z.string().length(3).default('USD'),
  SUPPORTED_CURRENCIES: z.string().default('USD,EUR,GBP'),
  FX_PROVIDER: z.enum(['static', 'ecb']).default('static'),
  FX_STATIC_RATES: z.string().default('{"EUR":0.92,"GBP":0.79}'),
  FX_SPREAD_BPS: z.coerce.number().int().min(0).max(1000).default(100),
  FX_MAX_AGE_HOURS: z.coerce.number().default(48),
  // Promotions & referrals
  REFERRAL_REWARD_CENTS: z.coerce.number().int().min(0).default(500),
  REFERRAL_MIN_ORDER_CENTS: z.coerce.number().int().min(0).default(1000),
  REFERRAL_MONTHLY_CAP: z.coerce.number().int().min(0).default(20),
  // Uploaded evidence (chat screenshots)
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  MALWARE_SCANNER: z.enum(['clamd', 'dev']).default('dev'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().default(3310),
  RECON_INTERVAL_HOURS: z.coerce.number().default(24),
  RECON_TOLERANCE_CENTS: z.coerce.number().default(0),
  FRAUD_GNN_URL: z.string().optional(),
  FRAUD_FREEZE_THRESHOLD: z.coerce.number().default(0.8),
  FRAUD_REVIEW_THRESHOLD: z.coerce.number().default(0.5),
  OFFPLATFORM_SUSPEND_STRIKES: z.coerce.number().default(3),
  ORDER_PAYMENT_TTL_MINUTES: z.coerce.number().default(30),
  TOS_VERSION: z.string().default('2026-09-01'),
  // Admin/arbiter actions need a session signed in with a second factor (PCI DSS 8.4). Defaults to on in production.
  STAFF_MFA_REQUIRED: z.enum(['true', 'false']).optional(),
  RUN_WORKER_IN_PROCESS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Web3 escrow
  ESCROW_CHAIN_ID: z.coerce.number().default(31337),
  ESCROW_CONTRACT_ADDRESS: z.string().default('0x0000000000000000000000000000000000000000'),
  ESCROW_SIGNER_PRIVATE_KEY: z.string().optional(),
  ESCROW_TOKEN_USDC: z.string().default('0x0000000000000000000000000000000000000000'),
  ESCROW_TOKEN_USDT: z.string().default('0x0000000000000000000000000000000000000000'),
  CRYPTO_INDEXER_SECRET: z.string().default('dev-only-indexer-secret'),
  ESCROW_RPC_URL: z.string().optional(),
  ESCROW_START_BLOCK: z.coerce.number().default(0),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const cfg = Env.parse({ ...process.env, ...overrides });
  if (cfg.SANDBOX_MODE && (cfg.PAYMENT_PROVIDER !== 'mock' || cfg.KYC_PROVIDER !== 'mock')) {
    throw new Error('SANDBOX_MODE requires PAYMENT_PROVIDER=mock and KYC_PROVIDER=mock');
  }
  if (cfg.NODE_ENV === 'production' && cfg.MALWARE_SCANNER === 'dev') {
    throw new Error('MALWARE_SCANNER=clamd is required in production');
  }
  if (cfg.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'DATA_ENCRYPTION_KEYS', 'FINGERPRINT_KEY', 'CRYPTO_INDEXER_SECRET'] as const) {
      if (!process.env[key]) throw new Error(`${key} must be set explicitly in production`);
    }
  }
  return cfg;
}
