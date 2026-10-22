-- What is on sale depends on the launch phase (brief CHANGE 10): phase 1 opens currency, items and
-- top-ups; phase 2 adds accounts and boosting; phase 3 keys, gift cards and video games. Staff move
-- the phase forward when each is ready; closed categories are hidden and cannot be listed in.
ALTER TABLE categories ADD COLUMN phase smallint NOT NULL DEFAULT 1;
UPDATE categories SET phase = CASE slug WHEN 'accounts' THEN 2 WHEN 'boosting' THEN 2 WHEN 'keys' THEN 3 WHEN 'gift-cards' THEN 3 WHEN 'video-games' THEN 3 ELSE 1 END;

CREATE TABLE launch_settings (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  phase      smallint NOT NULL DEFAULT 1 CHECK (phase BETWEEN 1 AND 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO launch_settings DEFAULT VALUES;

CREATE OR REPLACE FUNCTION category_open(slug text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT c.phase <= (SELECT phase FROM launch_settings) FROM categories c WHERE c.slug = $1
$$;
