-- Refunds after escrow was released (e.g. an account reclaimed by its original owner, goods
-- proven invalid after the window). The buyer is refunded; the seller's share is clawed back
-- from their balance (which may go negative: a debt repaid from future sales) or paid by the
-- platform; the commission and the tax inside it are returned, documented by a credit note.

CREATE TABLE post_release_refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),   -- settlement currency, refunded to the buyer
  paid_by          text NOT NULL CHECK (paid_by IN ('seller', 'platform', 'reserve')),
  seller_cents     bigint NOT NULL,                            -- seller's share (clawed back or covered)
  commission_cents bigint NOT NULL,                            -- commission returned
  tax_cents        bigint NOT NULL,                            -- tax inside the returned commission
  card_cents       bigint NOT NULL,                            -- returned to the card (settlement)
  provider_ref     text,
  reason           text NOT NULL,
  decided_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON post_release_refunds (order_id);

CREATE TABLE credit_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  seller_id     uuid NOT NULL REFERENCES users(id),
  order_id      uuid NOT NULL REFERENCES orders(id),
  refund_id     uuid NOT NULL UNIQUE REFERENCES post_release_refunds(id),
  invoice_id    uuid REFERENCES invoices(id),                  -- the invoice it corrects, if already issued
  currency      char(3) NOT NULL,
  net_cents     bigint NOT NULL,                               -- amounts credited back (positive)
  tax_cents     bigint NOT NULL,
  gross_cents   bigint NOT NULL,
  tax_country   char(2),
  tax_rate_bps  integer,
  tax_treatment text,
  reason        text NOT NULL,
  seller        jsonb NOT NULL,
  issuer        jsonb NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER credit_notes_append_only BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
