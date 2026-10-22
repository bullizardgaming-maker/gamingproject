-- Release rule at launch: standard orders (currency, items, top-ups) are held until the buyer
-- confirms; there is no 72-hour auto-release. If the buyer never confirms, staff release the
-- order by hand, never before 24 hours after delivery, and a seller can ask support to look at it.
-- Accounts keep the 14-day insurance window with its auto-release.
ALTER TABLE orders DROP CONSTRAINT orders_protection_check;
ALTER TABLE orders ADD CONSTRAINT orders_protection_check CHECK (protection IN ('inspection_72h', 'insurance_14d', 'until_confirmed'));
-- Orders already in their 72-hour window keep it; new standard orders get no deadline.
ALTER TABLE orders ADD COLUMN released_by uuid REFERENCES users(id);
ALTER TABLE orders ADD COLUMN release_note text;
