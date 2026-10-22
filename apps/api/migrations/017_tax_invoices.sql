-- VAT/GST on the platform's commission, and commission invoices for sellers.
--
-- The commission is a service the platform supplies to the seller, so its tax depends on the
-- seller: a VAT-registered business elsewhere in the EU self-accounts (reverse charge); a
-- consumer seller or one in the platform's own country is charged the applicable rate.
-- Commission rates are VAT-inclusive, so sellers' payouts are unchanged: the tax part of the
-- commission is booked to tax_payable instead of treasury.

ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'gateway_clearing', 'escrow', 'treasury', 'reserve', 'seller_available', 'payouts',
  'platform_withdrawals', 'user_credit', 'fx_pnl',
  'tax_payable'             -- VAT/GST collected on commission, owed to tax authorities
));

-- Seller tax profile (what goes on their invoices and decides the tax treatment).
ALTER TABLE users
  ADD COLUMN tax_country        char(2),
  ADD COLUMN tax_id             text,              -- VAT/GST number, normalised (no spaces)
  ADD COLUMN tax_id_verified_at timestamptz,       -- VIES (or equivalent) confirmed it
  ADD COLUMN is_business        boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_address    text;

-- Rates, maintained by staff. valid_from lets a rate change be scheduled.
CREATE TABLE tax_rates (
  country    char(2) NOT NULL,
  rate_bps   integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 5000),
  name       text NOT NULL DEFAULT 'VAT',
  valid_from date NOT NULL DEFAULT '2000-01-01',
  PRIMARY KEY (country, valid_from)
);

-- EU standard rates and a few common GST/VAT regimes. Check them with your tax adviser before
-- going live and keep them current (PUT /v1/admin/tax/rates).
INSERT INTO tax_rates (country, rate_bps, name) VALUES
  ('AT', 2000, 'USt'), ('BE', 2100, 'BTW'), ('BG', 2000, 'ДДС'), ('HR', 2500, 'PDV'), ('CY', 1900, 'ΦΠΑ'),
  ('CZ', 2100, 'DPH'), ('DK', 2500, 'moms'), ('EE', 2400, 'km'), ('FI', 2550, 'ALV'), ('FR', 2000, 'TVA'),
  ('DE', 1900, 'USt'), ('GR', 2400, 'ΦΠΑ'), ('HU', 2700, 'ÁFA'), ('IE', 2300, 'VAT'), ('IT', 2200, 'IVA'),
  ('LV', 2100, 'PVN'), ('LT', 2100, 'PVM'), ('LU', 1700, 'TVA'), ('MT', 1800, 'VAT'), ('NL', 2100, 'btw'),
  ('PL', 2300, 'VAT'), ('PT', 2300, 'IVA'), ('RO', 2100, 'TVA'), ('SK', 2300, 'DPH'), ('SI', 2200, 'DDV'),
  ('ES', 2100, 'IVA'), ('SE', 2500, 'moms'),
  ('GB', 2000, 'VAT'), ('NO', 2500, 'MVA'), ('CH', 810, 'MWST'), ('AU', 1000, 'GST'), ('NZ', 1500, 'GST');

-- Tax locked on the order when the commission is earned (escrow release).
ALTER TABLE orders
  ADD COLUMN tax_country          char(2),
  ADD COLUMN tax_rate_bps         integer,
  ADD COLUMN tax_treatment        text CHECK (tax_treatment IN ('standard', 'reverse_charge', 'outside_scope')),
  ADD COLUMN commission_tax_cents bigint;

-- Gapless invoice numbering per series (tax law requires no gaps).
CREATE TABLE invoice_sequences (
  series text PRIMARY KEY,
  next   bigint NOT NULL DEFAULT 1
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  seller_id     uuid NOT NULL REFERENCES users(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,              -- exclusive
  currency      char(3) NOT NULL,
  net_cents     bigint NOT NULL,
  tax_cents     bigint NOT NULL,
  gross_cents   bigint NOT NULL,
  seller        jsonb NOT NULL,             -- snapshot: name, country, tax id, address
  issuer        jsonb NOT NULL,             -- snapshot: platform legal name, country, VAT id
  lines         jsonb NOT NULL,             -- one per order: id, completed_at, commission, tax, rate, treatment
  totals        jsonb NOT NULL,             -- per rate/treatment
  issued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, period_start, currency)
);
CREATE TRIGGER invoices_append_only BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Treasury withdrawals can also move collected tax to the company bank account to pay it over.
ALTER TABLE treasury_withdrawals ADD COLUMN source text NOT NULL DEFAULT 'treasury' CHECK (source IN ('treasury', 'tax_payable'));
