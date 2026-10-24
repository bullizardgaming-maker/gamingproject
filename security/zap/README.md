# Dynamic scan (OWASP ZAP) against staging

`zap-staging.yaml` is a ZAP automation plan: signs in as a buyer test account, spiders the web app and the API
(OpenAPI import), runs the active scan, and fails on any High alert. Money-moving and admin endpoints are excluded.

What it covers from the launch gate: authentication (JSON login + bearer sessions), security headers (HSTS,
X-Content-Type-Options, clickjacking, CSP on the web app), CORS misconfiguration, cookie flags, rate limits (the scan
runs with a delay so 429s show up as expected behaviour, not errors), and file uploads (the chat attachment and
delivery-proof endpoints are in the OpenAPI document and get the upload/path-traversal rules).

Before running:
1. Staging is deployed (`docs/HOSTING.md`) with `MERCHANT_API_ENABLED=true` on the staging API so `/v1/openapi.json` exists.
2. A throwaway buyer account exists on staging (`ZAP_USER` / `ZAP_PASS`), Tier 1, with a few orders so order pages exist.
3. Run the command at the top of `zap-staging.yaml`. Reports: `security/zap/reports/`.
4. Triage: every High is fixed and re-run; Mediums are fixed or accepted in writing by the CEO (gate rule).

Also in CI: `security/zap/baseline` is not needed — the baseline (passive) checks are covered by the same plan.
