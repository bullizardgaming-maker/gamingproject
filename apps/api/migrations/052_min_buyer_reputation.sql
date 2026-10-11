-- Sellers can require an established buyer (reputation level "good": three or more completed
-- orders, no chargebacks, no pattern of lost disputes or negative ratings) on high-value
-- listings. Opt-in per listing; checked when the order is made.
ALTER TABLE offers ADD COLUMN min_buyer_reputation text CHECK (min_buyer_reputation IN ('good'));
