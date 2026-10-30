-- Round 26: listing features (B1–B10) and the crypto payments console (A3).

-- B1 Maximum per order (null: no cap); never below the minimum.
ALTER TABLE offers ADD COLUMN max_qty bigint CHECK (max_qty IS NULL OR max_qty >= 1);
ALTER TABLE offers ADD CONSTRAINT offers_max_qty_above_min CHECK (max_qty IS NULL OR max_qty >= min_qty);

-- B2 Soft delete keeps the row for order history; when it happened.
ALTER TABLE offers ADD COLUMN removed_at timestamptz;
UPDATE offers SET removed_at = updated_at WHERE status = 'removed' AND removed_at IS NULL;

-- B3 Which listing a copy was made from (for the seller's "duplicated to" view).
ALTER TABLE offers ADD COLUMN duplicated_from uuid REFERENCES offers(id);

-- B4 Currency listings are titled by the API (game · server · faction); existing ones are rebuilt once.
UPDATE offers f SET title = concat_ws(' · ', f.game,
    NULLIF(COALESCE(f.attributes->>'server', f.attributes->>'league', f.attributes->>'region', f.attributes->>'platform'), ''),
    NULLIF(f.attributes->>'faction', ''))
  FROM categories c WHERE c.slug = f.category_slug AND c.kind = 'currency' AND f.status <> 'removed';
