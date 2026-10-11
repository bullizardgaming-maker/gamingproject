-- Handover check. When the buyer of a delivered account signs in to that platform account from
-- Bullizard, the account has demonstrably changed hands: the matching checklist step is ticked
-- and the buyer may release escrow early, with their explicit consent.
ALTER TABLE security_checklists
  ADD COLUMN handover_platform text,
  ADD COLUMN handover_at       timestamptz;

-- A sign-in started from an order page carries the order, so the callback can send the buyer back there.
ALTER TABLE link_states ADD COLUMN order_id uuid REFERENCES orders(id);
