-- Round 26b (claude/round-26b-create-offer.md): typed delivery speed, percent-or-fixed volume tiers, no max per order.

-- No seller-set maximum per order (CEO): the most a buyer may order is the stock. The column stays NULL and unused.
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_max_qty_above_min;
UPDATE offers SET max_qty = NULL WHERE max_qty IS NOT NULL;

-- Delivery time: any whole number of minutes from 1 to 72 hours (the Round 25 list values are among them).
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_delivery_minutes_positive;
UPDATE offers SET delivery_minutes = 4320 WHERE delivery_minutes > 4320;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_delivery_minutes_range;
ALTER TABLE offers ADD CONSTRAINT offers_delivery_minutes_range CHECK (delivery_minutes BETWEEN 1 AND 4320);

-- Volume tiers: {minQty, type: 'percent'|'fixed', value}. Round 25 tiers {minQty, percentOff} become percent tiers.
UPDATE offers SET volume_discounts = (
  SELECT COALESCE(jsonb_agg(
           CASE WHEN t ? 'type' THEN t
                ELSE jsonb_build_object('minQty', t->'minQty', 'type', 'percent', 'value', t->'percentOff') END
           ORDER BY (t->>'minQty')::bigint), '[]'::jsonb)
    FROM jsonb_array_elements(volume_discounts) t)
 WHERE jsonb_array_length(volume_discounts) > 0;
