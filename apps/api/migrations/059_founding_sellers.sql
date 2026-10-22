-- Founding Sellers (brief NEW 6): sellers who open their shop during the launch window carry a
-- badge for good and may put listings in free featured spots while the launch promo runs.
ALTER TABLE launch_settings ADD COLUMN founding_until timestamptz NOT NULL DEFAULT now() + interval '60 days';
ALTER TABLE launch_settings ADD COLUMN founding_featured_slots smallint NOT NULL DEFAULT 2 CHECK (founding_featured_slots BETWEEN 0 AND 10);
ALTER TABLE launch_settings ADD COLUMN featured_days smallint NOT NULL DEFAULT 7 CHECK (featured_days BETWEEN 1 AND 90);

ALTER TABLE offers ADD COLUMN featured_until timestamptz;
CREATE INDEX offers_featured_idx ON offers (featured_until) WHERE featured_until IS NOT NULL;

-- Stamped when a seller lists for the first time while the window is open; it never comes off.
ALTER TABLE users ADD COLUMN founding boolean NOT NULL DEFAULT false;
