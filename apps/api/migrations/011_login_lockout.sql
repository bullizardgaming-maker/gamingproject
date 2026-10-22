-- Per-account throttle for password and 2FA guessing (per-IP limits alone can be spread over many IPs).
ALTER TABLE users
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN login_locked_until timestamptz,
  ADD COLUMN login_lock_count int NOT NULL DEFAULT 0;
