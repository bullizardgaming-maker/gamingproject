-- Bundles: one listing made of several of the seller's own instant-delivery listings, at one
-- price. A bundle has no inventory of its own: buying it reserves the parts' items against the
-- order, and its stock is how many complete sets the parts allow.
ALTER TABLE offers ADD COLUMN is_bundle boolean NOT NULL DEFAULT false;
CREATE TABLE bundle_items (
  bundle_offer_id    uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  component_offer_id uuid NOT NULL REFERENCES offers(id),
  quantity           integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  position           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_offer_id, component_offer_id)
);
CREATE INDEX bundle_items_component ON bundle_items (component_offer_id);

-- Units available to buy now, for any listing: manual stock, instant inventory, or for a bundle
-- the complete sets (0 if any part is paused or removed). The single definition every query uses.
CREATE FUNCTION offer_available(oid uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN f.is_bundle THEN
             CASE WHEN EXISTS (SELECT 1 FROM bundle_items b JOIN offers c ON c.id = b.component_offer_id
                                WHERE b.bundle_offer_id = f.id AND c.status <> 'active') THEN 0
                  ELSE COALESCE((SELECT min((SELECT count(*) FROM inventory_items i WHERE i.offer_id = b.component_offer_id AND i.status = 'available') / b.quantity)
                                   FROM bundle_items b WHERE b.bundle_offer_id = f.id), 0)::int END
           WHEN f.delivery_mode = 'auto' THEN (SELECT count(*)::int FROM inventory_items i WHERE i.offer_id = f.id AND i.status = 'available')
           ELSE f.stock
         END
    FROM offers f WHERE f.id = oid
$$;
