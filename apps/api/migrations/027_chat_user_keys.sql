-- Per-user chat keys (crypto-shredding). New messages from a user are encrypted with that
-- user's own key, and the hash chain covers a keyed digest of the text instead of the text
-- itself. Destroying a user's key erases everything they wrote while every room's chain
-- still verifies. Messages written before this migration keep the original format.

CREATE TABLE chat_user_keys (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  key_ciphertext text,                 -- the user's 32-byte key, wrapped by the data keyring; NULL once destroyed
  created_at     timestamptz NOT NULL DEFAULT now(),
  shredded_at    timestamptz,
  shred_reason   text
);

ALTER TABLE chat_messages
  ADD COLUMN hash_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN body_mac text,            -- v2: HMAC-SHA256(sender key, text); SHA-256 of the text for system messages
  ADD COLUMN body_sealed text;         -- v2 user messages: AES-256-GCM(sender key), bound to room and seq
