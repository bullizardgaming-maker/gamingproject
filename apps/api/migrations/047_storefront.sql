-- Seller storefronts: a banner image, a short intro, an accent colour from a fixed palette
-- (so contrast stays readable) and up to four pinned listings shown first on the shop page.
ALTER TABLE users
  ADD COLUMN shop_intro text NOT NULL DEFAULT '' CHECK (char_length(shop_intro) <= 600),
  ADD COLUMN shop_accent text NOT NULL DEFAULT 'steel' CHECK (shop_accent IN ('steel', 'teal', 'amber', 'rose', 'violet')),
  ADD COLUMN shop_pinned uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(shop_pinned) <= 4);

-- The banner file lives in file storage (encrypted like chat images, so key rotation covers it).
CREATE TABLE shop_banners (
  seller_id    uuid PRIMARY KEY REFERENCES users(id),
  storage_key  text NOT NULL,
  sha256       text NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  key_version  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
