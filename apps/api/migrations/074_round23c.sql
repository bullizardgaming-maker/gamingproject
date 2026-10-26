-- Round 23c (CEO): Bullizard offers no API keys, seller API or seller webhooks. Pre-launch, no real data: drop the
-- tables. The NOWPayments IPN (/v1/payments/webhook/nowpayments) and the other provider webhooks are unaffected. Idempotent.
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS api_keys;
