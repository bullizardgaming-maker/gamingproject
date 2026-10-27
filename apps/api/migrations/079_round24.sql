-- Round 24 (claude/round-24-backend-brief.md): listing fields, delivery methods, staff-opened disputes, no phone.

-- §1 Public offer ID for reports: BZO + 12 characters, stable, unique, never the database id.
ALTER TABLE offers ADD COLUMN public_id text;
UPDATE offers SET public_id = 'BZO' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)) WHERE public_id IS NULL;
ALTER TABLE offers ALTER COLUMN public_id SET DEFAULT 'BZO' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
ALTER TABLE offers ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE offers ADD CONSTRAINT offers_public_id_format CHECK (public_id ~ '^BZO[0-9A-Z]{12}$');
CREATE UNIQUE INDEX offers_public_id ON offers (public_id);

-- §2 The delivery methods the seller ticked (null: every method of the game).
ALTER TABLE offers ADD COLUMN delivery_methods text[];

-- §1 Completed orders per listing, kept by trigger like users.completed_orders (migration 044).
ALTER TABLE offers ADD COLUMN sold_count integer NOT NULL DEFAULT 0;
CREATE FUNCTION orders_sold_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status = 'completed' THEN UPDATE offers SET sold_count = sold_count - 1 WHERE id = OLD.offer_id; END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'completed' THEN UPDATE offers SET sold_count = sold_count + 1 WHERE id = NEW.offer_id; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_sold_ins AFTER INSERT OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_sold_count();
CREATE TRIGGER orders_sold_upd AFTER UPDATE OF status, offer_id ON orders
  FOR EACH ROW WHEN ((OLD.status = 'completed') IS DISTINCT FROM (NEW.status = 'completed') OR OLD.offer_id IS DISTINCT FROM NEW.offer_id)
  EXECUTE FUNCTION orders_sold_count();
UPDATE offers f SET sold_count = c.n FROM (SELECT offer_id, count(*)::int AS n FROM orders WHERE status = 'completed' GROUP BY offer_id) c WHERE f.id = c.offer_id;

-- §1 Positive reviews (4 or 5 stars, visible), next to the rating the same trigger keeps.
ALTER TABLE users ADD COLUMN positive_review_count integer NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION seller_rating_refresh(sid uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE users u SET rating_avg = r.avg, review_count = r.n, positive_review_count = r.pos
    FROM (SELECT round(avg(rating)::numeric, 2) AS avg, count(*)::int AS n, (count(*) FILTER (WHERE rating >= 4))::int AS pos
            FROM reviews WHERE seller_id = sid AND NOT hidden) r
   WHERE u.id = sid
$$;
UPDATE users u SET positive_review_count = r.pos
  FROM (SELECT seller_id, (count(*) FILTER (WHERE rating >= 4))::int AS pos FROM reviews WHERE NOT hidden GROUP BY seller_id) r
 WHERE u.id = r.seller_id;

-- §3 The buyer's delivery choice on the order (seen by the buyer, the seller and staff only).
ALTER TABLE orders ADD COLUMN delivery_method text CHECK (delivery_method IN ('f2f', 'mail', 'market', 'uid'));
ALTER TABLE orders ADD COLUMN delivery_info jsonb;

-- §4 Disputes opened by staff from a support ticket, linked both ways.
ALTER TABLE disputes ADD COLUMN ticket_id uuid REFERENCES support_tickets(id);
ALTER TABLE disputes ADD COLUMN opened_by_staff uuid REFERENCES users(id);
ALTER TABLE support_tickets ADD COLUMN dispute_id uuid REFERENCES disputes(id);
CREATE UNIQUE INDEX disputes_ticket ON disputes (ticket_id) WHERE ticket_id IS NOT NULL;

-- §4 Chat "Stay safe": disputes are opened by support now. Only the sentence is replaced, so staff edits elsewhere stay.
UPDATE site_texts SET body = replace(replace(body,
         'Something wrong? Open a dispute from the order page.', 'If something is wrong, contact support.'),
         'If something is wrong, open a dispute from the order page.', 'If something is wrong, contact support.'),
       updated_at = now()
 WHERE key = 'chat_safety' AND locale = 'en';
UPDATE site_texts SET body = replace(body, 'في مشكلة؟ افتح نزاعًا من صفحة الطلب.', 'في مشكلة؟ تواصل مع الدعم.'), updated_at = now()
 WHERE key = 'chat_safety' AND locale = 'ar';

-- §6 Level 1 is a verified email only (no phone, CEO): every account with a verified email is level 1 or more.
UPDATE users SET kyc_tier = 1 WHERE kyc_tier < 1 AND email_verified_at IS NOT NULL;
