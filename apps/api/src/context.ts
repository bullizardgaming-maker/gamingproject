import type { Config } from './config.js';
import type { Db } from './db.js';
import { createPool } from './db.js';
import { Keyring } from './lib/crypto.js';
import type { PubSub } from './lib/pubsub.js';
import { createPubSub } from './lib/pubsub.js';
import { MockPaymentProvider } from './providers/payments/mock.js';
import { StripePaymentProvider } from './providers/payments/stripe.js';
import type { PaymentProvider } from './providers/payments/types.js';
import { MockKycProvider } from './providers/kyc/mock.js';
import { SumsubKycProvider } from './providers/kyc/sumsub.js';
import type { KycProvider } from './providers/kyc/types.js';
import { EcbFxProvider, StaticFxProvider, type FxProvider } from './domain/fx.js';
import { ClamdScanner, EicarOnlyScanner, LocalEncryptedStorage, S3Storage, type FileStorage, type MalwareScanner } from './providers/files.js';
import { NoCaptcha, SiteverifyCaptcha, type CaptchaVerifier } from './providers/captcha.js';
import {
  ConsoleMessenger,
  MockPhoneChecker,
  PostmarkMessenger,
  RoutingMessenger,
  TwilioLookupChecker,
  TwilioSmsMessenger,
  type Messenger,
  type PhoneChecker,
} from './providers/messaging.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything a domain function needs. Constructed once per process. */
export interface Ctx {
  cfg: Config;
  db: Db;
  keyring: Keyring;
  pubsub: PubSub;
  payments: PaymentProvider;
  kyc: KycProvider;
  messenger: Messenger;
  phoneChecker: PhoneChecker;
  fx: FxProvider;
  storage: FileStorage;
  scanner: MalwareScanner;
  captcha: CaptchaVerifier;
  log: Logger;
  apiBaseUrl: string;
}

export function createContext(cfg: Config, log: Logger, overrides: Partial<Ctx> = {}): Ctx {
  const apiBaseUrl = cfg.PUBLIC_API_URL ?? `http://localhost:${cfg.PORT}`;
  const keyring = overrides.keyring ?? new Keyring(cfg.DATA_ENCRYPTION_KEYS);
  const payments =
    overrides.payments ??
    (cfg.PAYMENT_PROVIDER === 'stripe'
      ? new StripePaymentProvider(required(cfg.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'), required(cfg.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET'))
      : new MockPaymentProvider(cfg.JWT_SECRET, apiBaseUrl));
  const kyc =
    overrides.kyc ??
    (cfg.KYC_PROVIDER === 'sumsub'
      ? new SumsubKycProvider(
          required(cfg.SUMSUB_APP_TOKEN, 'SUMSUB_APP_TOKEN'),
          required(cfg.SUMSUB_SECRET_KEY, 'SUMSUB_SECRET_KEY'),
          required(cfg.SUMSUB_WEBHOOK_SECRET, 'SUMSUB_WEBHOOK_SECRET'),
          cfg.SUMSUB_LEVEL_NAME,
        )
      : new MockKycProvider(cfg.JWT_SECRET));
  return {
    cfg,
    db: overrides.db ?? createPool(cfg.DATABASE_URL),
    keyring,
    pubsub: overrides.pubsub ?? createPubSub(cfg.REDIS_URL),
    payments,
    kyc,
    messenger: overrides.messenger ?? buildMessenger(cfg, log),
    storage: overrides.storage ?? buildStorage(cfg, keyring),
    scanner: overrides.scanner ?? (cfg.MALWARE_SCANNER === 'clamd' ? new ClamdScanner(cfg.CLAMD_HOST, cfg.CLAMD_PORT) : new EicarOnlyScanner()),
    captcha:
      overrides.captcha ??
      (cfg.CAPTCHA_PROVIDER === 'none' ? new NoCaptcha() : new SiteverifyCaptcha(cfg.CAPTCHA_PROVIDER, required(cfg.CAPTCHA_SECRET, 'CAPTCHA_SECRET'))),
    fx: overrides.fx ?? (cfg.FX_PROVIDER === 'ecb' ? new EcbFxProvider() : new StaticFxProvider(JSON.parse(cfg.FX_STATIC_RATES))),
    phoneChecker:
      overrides.phoneChecker ??
      (cfg.SMS_PROVIDER === 'twilio'
        ? new TwilioLookupChecker(required(cfg.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'), required(cfg.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'))
        : new MockPhoneChecker()),
    log,
    apiBaseUrl: overrides.apiBaseUrl ?? apiBaseUrl,
  };
}

function buildStorage(cfg: Config, keyring: Keyring): FileStorage {
  if (cfg.STORAGE_PROVIDER === 's3') return new S3Storage(required(cfg.S3_BUCKET, 'S3_BUCKET'), cfg.S3_REGION, cfg.S3_ENDPOINT);
  return new LocalEncryptedStorage(cfg.STORAGE_DIR, keyring);
}

function buildMessenger(cfg: Config, log: Logger): Messenger {
  const consoleOut = new ConsoleMessenger((m) => log.info(m));
  const email =
    cfg.EMAIL_PROVIDER === 'postmark' ? new PostmarkMessenger(required(cfg.POSTMARK_SERVER_TOKEN, 'POSTMARK_SERVER_TOKEN'), cfg.EMAIL_FROM) : consoleOut;
  const sms =
    cfg.SMS_PROVIDER === 'twilio'
      ? new TwilioSmsMessenger(required(cfg.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'), required(cfg.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'), required(cfg.TWILIO_FROM, 'TWILIO_FROM'))
      : consoleOut;
  return new RoutingMessenger({ email, sms });
}

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required for the selected provider`);
  return v;
}
