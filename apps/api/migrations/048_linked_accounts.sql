-- Linked game accounts. A seller signs in to Steam or Riot from Bullizard, which proves they
-- control that account today. They can attach it to an account listing: buyers see "verified
-- Steam account, created 2012" (never the account name), staff see it next to the Original
-- Owner Proof, and one platform account can only be linked to one Bullizard user at a time,
-- so the same account can't be listed by two sellers.
CREATE TABLE linked_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  provider            text NOT NULL CHECK (provider IN ('steam', 'riot')),
  external_id         text NOT NULL,
  display_name        text NOT NULL,
  profile_url         text,
  account_created_at  timestamptz,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  unlinked_at         timestamptz,
  unlink_reason       text
);
CREATE UNIQUE INDEX linked_accounts_one_owner ON linked_accounts (provider, external_id) WHERE unlinked_at IS NULL;
CREATE INDEX linked_accounts_user ON linked_accounts (user_id) WHERE unlinked_at IS NULL;

-- One-time state for the sign-in round trip (CSRF and replay protection).
CREATE TABLE link_states (
  nonce       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  provider    text NOT NULL,
  expires_at  timestamptz NOT NULL
);

ALTER TABLE offers ADD COLUMN linked_account_id uuid REFERENCES linked_accounts(id);

-- When an account listing's order completes, the account has changed hands: the seller's link
-- is released (so the buyer can link it) and the listing no longer claims it.
CREATE FUNCTION orders_release_linked_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE la uuid;
BEGIN
  SELECT linked_account_id INTO la FROM offers WHERE id = NEW.offer_id;
  IF la IS NOT NULL THEN
    UPDATE linked_accounts SET unlinked_at = now(), unlink_reason = 'sold' WHERE id = la AND unlinked_at IS NULL;
    UPDATE offers SET linked_account_id = NULL WHERE linked_account_id = la;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_linked_account_sold AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION orders_release_linked_account();
