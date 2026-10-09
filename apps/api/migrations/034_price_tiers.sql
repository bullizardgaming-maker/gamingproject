-- Quantity price tiers: [{"minQty": 10, "priceCents": 450}, …] — the unit price for orders of at
-- least minQty, ascending. An order pays the lowest applicable unit price (never above the base).
ALTER TABLE offers ADD COLUMN price_tiers jsonb NOT NULL DEFAULT '[]';
