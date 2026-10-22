-- Cart checkout: one card payment covering several orders (one per listing, so each seller's
-- escrow, delivery, disputes and refunds stay separate). Orders in a checkout share its PSP
-- payment reference; captures, refunds and chargebacks are split back to the orders.
CREATE TABLE checkouts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id                  uuid NOT NULL REFERENCES users(id),
  status                    text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'paid', 'cancelled')),
  payment_provider          text,
  payment_ref               text UNIQUE,
  presentment_amount_cents  bigint,
  presentment_currency      text,
  idempotency_key           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  paid_at                   timestamptz,
  UNIQUE (buyer_id, idempotency_key)
);
ALTER TABLE orders ADD COLUMN checkout_id uuid REFERENCES checkouts(id);
CREATE INDEX orders_checkout ON orders (checkout_id) WHERE checkout_id IS NOT NULL;
-- A payment reference is unique per order, except across the orders of one checkout.
DROP INDEX IF EXISTS orders_payment_provider_payment_ref_idx;
CREATE UNIQUE INDEX orders_payment_ref_single ON orders (payment_provider, payment_ref) WHERE payment_ref IS NOT NULL AND checkout_id IS NULL;
CREATE INDEX orders_payment_ref ON orders (payment_ref) WHERE payment_ref IS NOT NULL;
