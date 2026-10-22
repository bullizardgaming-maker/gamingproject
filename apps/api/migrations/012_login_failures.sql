-- Failed sign-ins per client IP: after a few, sign-in asks for a CAPTCHA from that IP.
CREATE TABLE login_failures (
  id         bigserial PRIMARY KEY,
  ip         text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_ip ON login_failures (ip, created_at);
