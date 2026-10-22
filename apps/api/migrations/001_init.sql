-- Core schema for the marketplace.
-- Money is stored as integer minor units (cents). Rates are basis points (1 bp = 0.01%).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Identity & verification
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  display_name        text NOT NULL,
  role                text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'arbiter', 'admin')),
  kyc_tier            smallint NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 2),
  email_verified_at   timestamptz,
  phone               text,
  phone_verified_at   timestamptz,
  legal_name          text,                 -- populated from eKYC, used to match Original Owner Proof
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspension_reason   text,
  withdrawals_frozen  boolean NOT NULL DEFAULT false,
  offplatform_strikes integer NOT NULL DEFAULT 0,
  stripe_account_id   text,                 -- Stripe Connect connected account for payouts
  wallet_address      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  target      text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON verification_codes (user_id, channel, created_at DESC);

CREATE TABLE kyc_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  provider     text NOT NULL,
  external_id  text NOT NULL,
  level        text NOT NULL CHECK (level IN ('tier2_individual', 'tier2_business')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  result       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  slug            text PRIMARY KEY,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('account', 'currency', 'item', 'key', 'boosting', 'gift_card', 'topup', 'video_game')),
  -- 'high' => 14-day asset insurance window, 'standard' => 72-hour inspection
  risk_class      text NOT NULL CHECK (risk_class IN ('standard', 'high')),
  promo_rate_bps  integer            -- flat promotional commission overriding seller tier
);

CREATE TABLE offers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id            uuid NOT NULL REFERENCES users(id),
  category_slug        text NOT NULL REFERENCES categories(slug),
  game                 text NOT NULL,
  title                text NOT NULL,
  description          text NOT NULL DEFAULT '',
  price_cents          bigint NOT NULL CHECK (price_cents > 0),
  currency             char(3) NOT NULL DEFAULT 'USD',
  delivery_mode        text NOT NULL CHECK (delivery_mode IN ('auto', 'manual')),
  -- manual offers track stock here; auto offers derive stock from inventory_items
  stock                integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold  integer NOT NULL DEFAULT 5,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  owner_proof_status   text NOT NULL DEFAULT 'none' CHECK (owner_proof_status IN ('none', 'pending', 'verified', 'rejected')),
  version              integer NOT NULL DEFAULT 0,   -- optimistic lock
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON offers (category_slug, status);
CREATE INDEX ON offers (seller_id);

CREATE TABLE owner_proofs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id            uuid NOT NULL REFERENCES offers(id),
  seller_id           uuid NOT NULL REFERENCES users(id),
  registration_email  text NOT NULL,
  registration_date   date NOT NULL,
  billing_name        text,
  evidence            jsonb NOT NULL DEFAULT '{}',  -- screenshot URLs, CD key, legacy security answers (encrypted refs)
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  reviewed_by         uuid REFERENCES users(id),
  review_note         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Auto-delivery inventory. Payload is AES-256-GCM encrypted at rest.
CREATE TABLE inventory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position      bigserial,       -- upload order: stock is allocated FIFO
  offer_id      uuid NOT NULL REFERENCES offers(id),
  seller_id     uuid NOT NULL REFERENCES users(id),
  ciphertext    text NOT NULL,
  fingerprint   text NOT NULL,   -- HMAC of plaintext, used for de-duplication without decrypting
  status        text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'delivered', 'revoked')),
  order_id      uuid,
  version       integer NOT NULL DEFAULT 0,   -- optimistic lock
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  UNIQUE (seller_id, fingerprint)
);
CREATE INDEX ON inventory_items (offer_id, status, position);

-- ---------------------------------------------------------------------------
-- Orders & escrow
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id             uuid NOT NULL REFERENCES users(id),
  seller_id            uuid NOT NULL REFERENCES users(id),
  offer_id             uuid NOT NULL REFERENCES offers(id),
  quantity             integer NOT NULL CHECK (quantity > 0),
  unit_price_cents     bigint NOT NULL,
  amount_cents         bigint NOT NULL,
  currency             char(3) NOT NULL,
  commission_bps       integer NOT NULL,
  commission_cents     bigint NOT NULL,
  seller_net_cents     bigint NOT NULL,
  seller_tier          text NOT NULL,
  rail                 text NOT NULL CHECK (rail IN ('fiat', 'crypto')),
  status               text NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled', 'charged_back')),
  protection           text NOT NULL CHECK (protection IN ('inspection_72h', 'insurance_14d')),
  protection_ends_at   timestamptz,
  escrow_frozen        boolean NOT NULL DEFAULT false,   -- set by fraud engine; blocks auto-release
  seller_protected     boolean NOT NULL DEFAULT true,    -- false for "High Risk - Secondary Market" listings
  payment_provider     text,
  payment_ref          text,
  payment_expires_at   timestamptz,
  tos_version          text NOT NULL,
  tos_accepted_at      timestamptz NOT NULL,
  buyer_ip             inet,
  buyer_ip_country     text,
  buyer_device         text,
  risk_score           numeric(5,4),
  idempotency_key      text,
  version              integer NOT NULL DEFAULT 0,
  paid_at              timestamptz,
  delivered_at         timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, idempotency_key)
);
CREATE INDEX ON orders (buyer_id, created_at DESC);
CREATE INDEX ON orders (seller_id, created_at DESC);
CREATE INDEX ON orders (status, protection_ends_at);
CREATE UNIQUE INDEX ON orders (payment_provider, payment_ref) WHERE payment_ref IS NOT NULL;

-- Immutable audit trail of every state transition.
CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid,
  reason      text,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_events (order_id, id);

-- Point-in-time snapshot of the listing the buyer saw ("Not as Described" evidence).
CREATE TABLE offer_snapshots (
  order_id   uuid PRIMARY KEY REFERENCES orders(id),
  snapshot   jsonb NOT NULL,
  sha256     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Payment-time risk and card verification data (never contains PAN — hosted checkout only).
CREATE TABLE payment_details (
  order_id          uuid PRIMARY KEY REFERENCES orders(id),
  provider          text NOT NULL,
  avs_result        text,
  cvv_result        text,
  card_brand        text,
  card_last4        text,
  card_fingerprint  text,
  billing_country   text,
  ip_country        text,
  raw               jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Account-order "Security Changeover" checklist.
CREATE TABLE security_checklists (
  order_id     uuid PRIMARY KEY REFERENCES orders(id),
  items        jsonb NOT NULL,
  completed_at timestamptz
);

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL UNIQUE REFERENCES orders(id),
  opened_by       uuid NOT NULL REFERENCES users(id),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_buyer', 'resolved_seller')),
  resolution_note text,
  resolved_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Double-entry ledger
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_accounts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id  uuid REFERENCES users(id),          -- NULL for platform accounts
  kind      text NOT NULL CHECK (kind IN ('gateway_clearing', 'escrow', 'treasury', 'reserve', 'seller_available', 'payouts')),
  currency  char(3) NOT NULL,
  UNIQUE NULLS NOT DISTINCT (owner_id, kind, currency)
);

CREATE TABLE ledger_entries (
  id          bigserial PRIMARY KEY,
  txn_id      uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_cents bigint NOT NULL,           -- positive = credit to the account, negative = debit
  order_id    uuid REFERENCES orders(id),
  memo        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id);
CREATE INDEX ON ledger_entries (order_id);
CREATE INDEX ON ledger_entries (txn_id);

CREATE TABLE withdrawals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     char(3) NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  provider_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Chat (the immutable arbitration ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE chat_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid UNIQUE REFERENCES orders(id),
  offer_id    uuid REFERENCES offers(id),
  buyer_id    uuid NOT NULL REFERENCES users(id),
  seller_id   uuid NOT NULL REFERENCES users(id),
  last_seq    bigint NOT NULL DEFAULT 0,
  last_hash   text NOT NULL DEFAULT repeat('0', 64),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON chat_rooms (offer_id, buyer_id) WHERE order_id IS NULL;

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES chat_rooms(id),
  seq         bigint NOT NULL,                 -- monotonic, gapless, server-assigned
  sender_id   uuid REFERENCES users(id),       -- NULL for system messages
  kind        text NOT NULL CHECK (kind IN ('text', 'system', 'delivery', 'warning')),
  body        text NOT NULL,
  flags       text[] NOT NULL DEFAULT '{}',
  prev_hash   text NOT NULL,
  hash        text NOT NULL,                   -- sha256 chain: tamper evidence for arbitration
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, seq)
);

-- ---------------------------------------------------------------------------
-- Merchant API & webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  prefix      text NOT NULL UNIQUE,
  key_hash    text NOT NULL,
  scopes      text[] NOT NULL,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  url               text NOT NULL,
  secret_ciphertext text NOT NULL,
  events            text[] NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: rows are inserted in the same transaction as the business event.
CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- doubles as the idempotency key
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id),
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX ON webhook_deliveries (status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Fraud graph
-- ---------------------------------------------------------------------------
-- Each row is an edge user --(kind,value)--> shared entity (device, subnet, wallet, card).
CREATE TABLE risk_signals (
  user_id    uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('device', 'ip_subnet', 'wallet', 'card')),
  value      text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, value)
);
CREATE INDEX ON risk_signals (kind, value);

CREATE TABLE risk_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  order_id    uuid REFERENCES orders(id),
  score       numeric(5,4) NOT NULL,
  reasons     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'confirmed')),
  reviewed_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Chargebacks
-- ---------------------------------------------------------------------------
CREATE TABLE chargebacks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  provider_ref  text UNIQUE,
  network       text NOT NULL CHECK (network IN ('visa', 'mastercard')),
  reason_code   text NOT NULL,
  category      text NOT NULL CHECK (category IN ('fraud', 'not_as_described', 'credit_not_processed')),
  amount_cents  bigint NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  respond_by    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'packet_ready', 'submitted', 'won', 'lost')),
  evidence      jsonb,
  packet_pdf    bytea,
  packet_sha256 text
);

-- PCI DSS 11.6.1: record CSP violations raised on payment pages.
CREATE TABLE csp_reports (
  id          bigserial PRIMARY KEY,
  document_uri text,
  blocked_uri  text,
  directive    text,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for evidentiary tables
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER chat_messages_append_only BEFORE UPDATE OR DELETE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER offer_snapshots_append_only BEFORE UPDATE OR DELETE ON offer_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER chat_messages_no_truncate BEFORE TRUNCATE ON chat_messages
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE ON order_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
