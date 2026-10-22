-- Human order IDs (brief NEW 11): order#7F3AK2Q, shown everywhere a person reads an order.
ALTER TABLE orders ADD COLUMN ref text UNIQUE;
-- Existing orders get one; new ones are assigned on insert by the application.
UPDATE orders SET ref = 'order#' || upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=01IOl', 'ABCDEFGH'), 1, 7)) WHERE ref IS NULL;

-- Official order messages (brief NEW 9): server-only chat messages rendered in a frame users cannot imitate.
ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_kind_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_kind_check CHECK (kind IN ('text', 'system', 'delivery', 'warning', 'attachment', 'system_order'));

-- Staff-managed site texts (brief NEW 10: the "Stay safe" panel in every order chat).
CREATE TABLE site_texts (
  key        text PRIMARY KEY,
  body       text NOT NULL,
  link_label text NOT NULL DEFAULT '',
  link_href  text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO site_texts (key, body, link_label, link_href) VALUES
  ('chat_safety',
   E'Keep the whole trade in this chat. Never pay or deliver anywhere else: deals made outside Bullizard are not in escrow and not protected.\nSharing outside contacts can get your account banned right away.\nThe payment is released only when the buyer confirms delivery. If something is wrong, open a dispute from the order page.',
   'Rules and policies', '/help/report-a-user');
