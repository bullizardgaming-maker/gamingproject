-- Game-specific listing fields (server, region, platform, rank…). Definitions live in code
-- (src/domain/attributeSets.ts); values are validated against them on write.
ALTER TABLE offers ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object');
-- Game pages filter one game at a time, so index the pairs a filter reads.
CREATE INDEX offers_game_attributes ON offers (lower(game), category_slug) WHERE status = 'active';
