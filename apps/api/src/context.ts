import type { Config } from './config.js';
import type { Db } from './db.js';
import { ReadPool, createPool } from './db.js';
import { Keyring } from './lib/crypto.js';
import type { PubSub } from './lib/pubsub.js';
import { createPubSub } from './lib/pubsub.js';
import { MockPaymentProvider } from './providers/payments/mock.js';
import { StripePaymentProvider } from './providers/payments/stripe.js';
import { NowPaymentsProvider } from './providers/payments/nowpayments.js';
import type { PaymentProvider } from './providers/payments/types.js';
import { MockKycProvider } from './providers/kyc/mock.js';
import { SumsubKycProvider } from './providers/kyc/sumsub.js';
import type { KycProvider } from './providers/kyc/types.js';
import { EcbFxProvider, StaticFxProvider, getRate, type FxProvider } from './domain/fx.js';
import { MockFxExchange, WiseFxExchange, type FxExchange } from './providers/fxexchange.js';
import { ClamdScanner, EicarOnlyScanner, LocalEncryptedStorage, S3Storage, type FileStorage, type MalwareScanner } from './providers/files.js';
import { AwsKmsSigner, LocalKeySigner, type EscrowSigner } from './providers/signer.js';
import { NoPush, WebPushSender, type PushSender } from './providers/push.js';
import { NoVatValidator, ViesValidator, type VatValidator } from './providers/vat.js';
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
import { createViewDeduper, type ViewDeduper } from './lib/viewDedupe.js';
import { LivePlatformAccounts, MockPlatformAccounts, type PlatformAccounts } from './providers/platformAccounts.js';
export interface Ctx {
  cfg: Config;
  db: Db;
  /** Replica-backed pool for stale-tolerant reads; the primary when no replica is configured. */
  dbRead: ReadPool;
  keyring: Keyring;
  pubsub: PubSub;
  /** Listing-view de-duplication: Redis when configured (exact across nodes), else this process's memory. */
  views: ViewDeduper;
  payments: PaymentProvider;
  kyc: KycProvider;
  messenger: Messenger;
  phoneChecker: PhoneChecker;
  fx: FxProvider;
  /** Executes currency purchases for FX top-ups; null when they are recorded by hand. */
  fxExchange: FxExchange | null;
  storage: FileStorage;
  scanner: MalwareScanner;
  captcha: CaptchaVerifier;
  vat: VatValidator;
  push: PushSender;
  /** Null when crypto escrow is not configured. */
  escrowSigner: EscrowSigner | null;
  platformAccounts: PlatformAccounts;
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
      : cfg.PAYMENT_PROVIDER === 'nowpayments'
        ? new NowPaymentsProvider({
            apiKey: required(cfg.NOWPAYMENTS_API_KEY, 'NOWPAYMENTS_API_KEY'),
            ipnSecret: required(cfg.NOWPAYMENTS_IPN_SECRET, 'NOWPAYMENTS_IPN_SECRET'),
            apiUrl: cfg.NOWPAYMENTS_API_URL,
            email: cfg.NOWPAYMENTS_EMAIL,
            password: cfg.NOWPAYMENTS_PASSWORD,
            twoFactorSecret: cfg.NOWPAYMENTS_2FA_SECRET,
            outcomeCurrency: cfg.NOWPAYMENTS_OUTCOME_CURRENCY,
          })
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
  const db = overrides.db ?? createPool(cfg.DATABASE_URL);
  const ctx: Ctx = {
    cfg,
    db,
    dbRead: overrides.dbRead ?? new ReadPool(db, cfg.DATABASE_READ_URL ? createPool(cfg.DATABASE_READ_URL, undefined, { connectTimeoutMs: 5_000 }) : null, cfg.REPLICA_MAX_LAG_SECONDS),
    keyring,
    pubsub: overrides.pubsub ?? createPubSub(cfg.REDIS_URL),
    views: overrides.views ?? createViewDeduper(cfg.REDIS_URL),
    payments,
    kyc,
    messenger: overrides.messenger ?? buildMessenger(cfg, log),
    storage: overrides.storage ?? buildStorage(cfg, keyring),
    scanner: overrides.scanner ?? (cfg.MALWARE_SCANNER === 'clamd' ? new ClamdScanner(cfg.CLAMD_HOST, cfg.CLAMD_PORT) : new EicarOnlyScanner()),
    captcha:
      overrides.captcha ??
      (cfg.CAPTCHA_PROVIDER === 'none' ? new NoCaptcha() : new SiteverifyCaptcha(cfg.CAPTCHA_PROVIDER, required(cfg.CAPTCHA_SECRET, 'CAPTCHA_SECRET'))),
    push:
      overrides.push ??
      (cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY
        ? new WebPushSender(cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY, cfg.VAPID_SUBJECT, cfg.NODE_ENV === 'production')
        : new NoPush()),
    platformAccounts:
      overrides.platformAccounts ??
      (cfg.PLATFORM_ACCOUNTS === 'live'
        ? new LivePlatformAccounts({ steamApiKey: cfg.STEAM_WEB_API_KEY, riotClientId: cfg.RIOT_CLIENT_ID, riotClientSecret: cfg.RIOT_CLIENT_SECRET, riotAccountRegion: cfg.RIOT_ACCOUNT_REGION })
        : new MockPlatformAccounts()),
    vat: overrides.vat ?? (cfg.VAT_VALIDATION === 'vies' ? new ViesValidator() : new NoVatValidator()),
    escrowSigner:
      overrides.escrowSigner !== undefined
        ? overrides.escrowSigner
        : cfg.ESCROW_SIGNER === 'aws_kms'
          ? new AwsKmsSigner(cfg.ESCROW_KMS_KEY_ID!)
          : cfg.ESCROW_SIGNER_PRIVATE_KEY
            ? new LocalKeySigner(cfg.ESCROW_SIGNER_PRIVATE_KEY)
            : null,
    fx: overrides.fx ?? (cfg.FX_PROVIDER === 'ecb' ? new EcbFxProvider() : new StaticFxProvider(JSON.parse(cfg.FX_STATIC_RATES))),
    phoneChecker:
      overrides.phoneChecker ??
      (cfg.SMS_PROVIDER === 'twilio'
        ? new TwilioLookupChecker(required(cfg.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'), required(cfg.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'))
        : new MockPhoneChecker()),
    log,
    apiBaseUrl: overrides.apiBaseUrl ?? apiBaseUrl,
    fxExchange: null,
  };
  ctx.fxExchange = overrides.fxExchange !== undefined ? overrides.fxExchange : buildFxExchange(cfg, ctx);
  return ctx;
}

function buildFxExchange(cfg: Config, ctx: Ctx): FxExchange | null {
  if (cfg.FX_EXCHANGE_PROVIDER === 'wise') {
    return new WiseFxExchange({ baseUrl: cfg.WISE_API_URL, token: required(cfg.WISE_API_TOKEN, 'WISE_API_TOKEN'), profileId: required(cfg.WISE_PROFILE_ID, 'WISE_PROFILE_ID') });
  }
  if (cfg.FX_EXCHANGE_PROVIDER === 'mock') {
    if (cfg.NODE_ENV === 'production') throw new Error('FX_EXCHANGE_PROVIDER=mock is not allowed in production');
    // Rates are per 1 unit of the settlement currency, so from -> to is rate(to) / rate(from).
    return new MockFxExchange(async (from, to) => (await getRate(ctx, ctx.db, to)) / (await getRate(ctx, ctx.db, from)));
  }
  return null;
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
