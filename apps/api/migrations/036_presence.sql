-- Presence and responsiveness shown to buyers: "online now" (signed-in activity in the last few
-- minutes) and a seller's typical first-reply time in chat over the last 90 days.
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN response_minutes integer;
ALTER TABLE users ADD COLUMN response_sample integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN response_computed_at timestamptz;
-- Sellers may hide their online status (response time still shows).
ALTER TABLE users ADD COLUMN show_online boolean NOT NULL DEFAULT true;
