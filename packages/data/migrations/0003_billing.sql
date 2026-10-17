-- Spendcap D1 schema: hosted billing (commercial)
-- 0003_billing.sql
--
-- The OSS self-hosted core does NOT need this table. It is applied only on
-- the hosted control plane, where Stripe webhooks mark orgs as subscribed
-- to the flat "Spendcap Pro" plan. Self-hosters can skip this migration.

CREATE TABLE subscriptions (
  org_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  status TEXT,
  current_period_end TEXT
);
