-- A proposal on a buyer request can point at one of the seller's existing listings instead of
-- a new price: accepting it sends the buyer to that listing rather than creating a private one.
ALTER TABLE request_proposals ADD COLUMN listing_offer_id uuid REFERENCES offers(id);
