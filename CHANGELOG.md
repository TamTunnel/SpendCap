# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **Revoke/budget changes now reach the warm DO** (`packages/budget`,
  `packages/dashboard`): new `invalidateKey(keyHash)` / `reloadScope(scopeId)`
  DO RPCs; the dashboard calls them after key revoke/rotate, budget set, and
  budget-scope change. Migration `0004_budget_unique` adds
  `UNIQUE(scope_id, period)` on `budgets` so duplicate budget rows can't
  silently shadow each other.
- **CLI ↔ dashboard contract aligned** (`packages/cli`): `keys revoke/rotate`
  hit `POST /api/keys/:hash/revoke|rotate`, `keys create` sends `projectId`,
  `budgets set` posts `{scopeType:'project', scopeId, period, limitCents}` to
  `POST /api/budgets`, and new `provider-keys set` posts to
  `POST /api/provider-keys`. Covered by a contract test driving the CLI's HTTP
  client against the dashboard worker.
- **Dashboard-created keys enforce budgets** (`packages/dashboard`): new keys
  get `budget_scope_id = project_id` (was NULL → nothing enforced) and
  `org_id = project_id`; new `POST /api/budgets` (upsert + DO reload) and
  `PATCH /api/keys/:hash` (rename / re-scope) routes.
- **Provider-key provisioning** (`packages/dashboard`, `packages/cli`):
  `POST /api/provider-keys` (admin auth) AES-GCM-encrypts the key with
  `PROVIDER_KEYS_SECRET` (now required on the dashboard worker too) before D1
  insert; the README quickstart includes the step.
- **Velocity guardrail unit fix** (`packages/guardrails`): event timestamps
  are milliseconds — the window math no longer mixes ms with seconds
  (~1000x more sensitive, as documented).
- **Input-aware cost estimates** (`packages/data`, `packages/proxy`): the
  pre-flight reserve prices estimated input tokens (from request size) at the
  higher of input/output rates plus the full `max_tokens` /
  `max_completion_tokens` budget as output; README wording updated.
- **Model allow-lists enforced** (`packages/budget`, `packages/proxy`): the
  proxy routes before authorizing and passes `routedModel`; the DO denies with
  `model_not_allowed` (→ HTTP 403) when the routed model is outside the key's
  `allowedModels`.
- **Routed model reported** (`packages/proxy`): every proxied success response
  carries `x-spendcap-routed-model`; the default policy's standard-tier clamp
  is documented in the README (no silent substitution).
- **Usage rollup idempotency** (`packages/data`): `flushUsageBatch` uses
  `INSERT … ON CONFLICT DO NOTHING … RETURNING id` and only rolls up rows the
  insert actually wrote — retrying a batch can no longer double-count
  `usage_daily`.
- **Provider-key crypto fails closed** (`packages/proxy`): encrypt/decrypt
  throw on an unset `PROVIDER_KEYS_SECRET` instead of deriving SHA-256("").
- **`x-spendcap-task` bounded** (`packages/proxy`): truncated to 128 chars at
  the proxy (documented) before storage.
- **Settle hardening** (`packages/budget`): rejects non-finite/negative costs
  and token counts, verifies the key hash matches the reservation, and binds
  the usage record to the reservation's key/project (caller values ignored).
- **401 unification** (`packages/budget`, `packages/proxy`): revoked and
  unknown keys return the identical `{code:'key_not_found', message:'unknown
  API key'}` body (no key enumeration).
- **Idle memory prune** (`packages/budget`): authorize lazily drops rate
  windows, spend events, pause timers, cached key configs, and last-seen
  markers for keys idle >1h.
- **Stripe `customer.subscription.deleted`** (`commercial/billing`): flips the
  subscription row to `status='canceled'`.
- **Proxy error paths settle with the real project id** (`packages/proxy`):
  `authorizeAndReserve` now returns `projectId` from the authorized key
  config; every settle — including error paths — carries it, never `''`.

### Added

- **Streaming LLM proxy** (`packages/proxy`): OpenAI-compatible pass-through
  worker on Cloudflare Workers. Request/response bodies stream through
  untouched — only token counts and cost are recorded, never prompts.
- **BudgetEnforcer Durable Object** (`packages/budget`): atomic
  check-and-reserve per budget scope. The reserve and the spend decision happen
  in one single-threaded step, so concurrent agents can't double-spend a
  budget. Rejects with `budget_exceeded` before any provider call is made.
- **Virtual API keys** (`packages/auth`): `sc_live_`/`sc_test_` keys, hash-only
  storage, per-key scopes, model allow-lists, and per-minute rate limits;
  create/revoke/rotate via CLI.
- **D1 system of record** (`packages/data`): schema migrations
  (`0001_init`, `0002_seed_pricing`, `0003_billing`), pricing math with
  conservative ceiling estimates, and DO-batched usage ingestion (~50:1) that
  stays under D1's write and parameter caps; flushes report `delayed` (not
  lost) on hard-cap failure.
- **Deterministic tier routing** (`packages/arbitrage`): cheap → standard →
  frontier model tiers, cheapest-in-tier by live pricing table. Pure function,
  zero I/O — explicitly not ML (v2 roadmap).
- **Velocity guardrails** (`packages/guardrails`): burn-rate anomaly detection
  against a baseline, with an absolute floor so penny-level traffic never
  alerts.
- **Self-hosted dashboard** (`packages/dashboard`) and **`spendcap` CLI**
  (`packages/cli`): key management and daily/monthly budget administration.
- **Hosted billing** (`commercial/billing`): Stripe Checkout for the flat
  $49/mo "Spendcap Pro" plan (price via `STRIPE_PRICE_ID`) plus a signature-
  verified webhook handler that upserts `subscriptions`. Usage-based billing
  is deliberately out of scope for v1.
- **Hosted multi-tenancy** (`commercial/multitenant`): org/project CRUD for
  the hosted control plane, on the same `orgs`/`projects` tables the OSS core
  ships.
