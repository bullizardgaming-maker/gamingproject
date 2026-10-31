-- Seller holidays and promised delivery times for manually delivered orders.

ALTER TABLE users
  ADD COLUMN shop_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN shop_paused_until timestamptz,          -- NULL = paused until the seller resumes
  ADD COLUMN shop_pause_message text;

ALTER TABLE offers ADD COLUMN delivery_hours integer NOT NULL DEFAULT 24 CHECK (delivery_hours BETWEEN 1 AND 168);

ALTER TABLE orders
  ADD COLUMN delivery_due_at timestamptz,
  ADD COLUMN late_notified_at timestamptz;
CREATE INDEX orders_delivery_due_idx ON orders (delivery_due_at) WHERE status = 'paid';
