# Dynamic scan (OWASP ZAP) against staging

`zap-staging.yaml` is a ZAP automation plan: signs in as the buyer test account, seeds the main API endpoints
(requestor job), spiders the web app (classic and AJAX), runs the active scan, and fails on any High alert. Money-moving,
admin, email-sending and sandbox endpoints are excluded. There is no OpenAPI import: Bullizard has no public seller API
(Round 23c).

What it covers from the launch gate: authentication (JSON login + bearer sessions), security headers (HSTS,
X-Content-Type-Options, clickjacking, CSP on the web app), CORS misconfiguration, cookie flags, rate limits (the scan
runs with a delay so 429s show up as expected behaviour, not errors), and file uploads (the chat attachment and
delivery-proof endpoints the web app calls get the upload/path-traversal rules).

How to run: GitHub → Actions → **staging ZAP scan** → Run workflow (`.github/workflows/staging-zap.yml`). It needs the
GitHub secrets `STAGING_BUYER_EMAIL`, `STAGING_BUYER_PASSWORD` and `STAGING_TEST_TOKEN` (and the same `STAGING_TEST_TOKEN`
on the staging API on Render: see `docs/STAGING.md` → "Staging test workflows"). Reports are uploaded as
the workflow artifact `zap-reports`. Locally: the command at the top of `zap-staging.yaml`.

Before running:
1. Staging is deployed (`docs/HOSTING.md`) and `STAGING_TEST_TOKEN` is set on the staging API (Turnstile is on there).
2. The buyer test account exists on staging, Tier 1, with a few orders so order pages exist.
3. Triage: every High is fixed and re-run; Mediums are fixed or accepted in writing by the CEO (gate rule). The workflow
   passes when only Medium (or lower) alerts are left (ZAP exit code 2) and fails on High (exit code 1) or a plan error.
