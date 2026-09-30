import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),
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
  if (cfg.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'DATA_ENCRYPTION_KEYS', 'FINGERPRINT_KEY', 'CRYPTO_INDEXER_SECRET'] as const) {
      if (!process.env[key]) throw new Error(`${key} must be set explicitly in production`);
    }
  }
  return cfg;
}
