-- Front-end requests (2026-10-23): currency sold by amount, seller badges and languages, localized
-- site texts, and chat system events as codes so the app can show them in the reader's language.

-- 1. Currency listings sold by amount. `price_cents` stays the price of one unit (quantity is in
--    units); these say what a unit is ("M" of silver = 1,000,000) and the smallest order.
ALTER TABLE offers
  ADD COLUMN unit_label text,
  ADD COLUMN unit_size  bigint,
  ADD COLUMN min_qty    integer NOT NULL DEFAULT 1 CHECK (min_qty >= 1);

-- 2. Seller badges (up to two of the ones they have earned) and 3. languages they trade in.
ALTER TABLE users
  ADD COLUMN badges    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN languages text[] NOT NULL DEFAULT '{}';

-- 8a. Site texts per locale; English is the fallback.
ALTER TABLE site_texts ADD COLUMN locale text NOT NULL DEFAULT 'en';
ALTER TABLE site_texts DROP CONSTRAINT site_texts_pkey;
ALTER TABLE site_texts ADD PRIMARY KEY (key, locale);

-- 8b. System chat messages carry a code and parameters next to the English body.
ALTER TABLE chat_messages
  ADD COLUMN code   text,
  ADD COLUMN params jsonb;
