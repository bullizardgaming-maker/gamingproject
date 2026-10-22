-- Help centre support tickets, optionally linked to an order. Staff with support.manage work
-- the queue; internal notes are never shown to the customer.
CREATE TABLE support_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          bigint GENERATED ALWAYS AS IDENTITY (START WITH 10001) UNIQUE,
  user_id         uuid NOT NULL REFERENCES users(id),
  order_id        uuid REFERENCES orders(id),
  category        text NOT NULL CHECK (category IN ('order', 'payment', 'account', 'selling', 'report', 'other')),
  subject         text NOT NULL,
  -- open: waiting on staff · pending: waiting on the customer · resolved: done (reopens on reply)
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  assigned_to     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  resolved_at     timestamptz
);
CREATE INDEX support_tickets_user ON support_tickets (user_id, updated_at DESC);
CREATE INDEX support_tickets_queue ON support_tickets (status, priority, updated_at);

CREATE TABLE support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  staff       boolean NOT NULL,
  internal    boolean NOT NULL DEFAULT false CHECK (staff OR NOT internal),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_ticket ON support_messages (ticket_id, created_at);
