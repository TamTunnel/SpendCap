# Spendcap

Budgets that actually block. A self-hosted Cloudflare Workers proxy that sits
in front of your LLM providers and **refuses the call before the money is
spent** — not after.

> **Demo:** once published, the live dashboard demo (with the 60s explainer
> video) will be at `https://tamtunnel.github.io/SpendCap/` —
> [`#video`](https://tamtunnel.github.io/SpendCap/#video).
> Until then, open `demo-site/index.html` locally.

## 1. The problem

Agent fleets burn through hundreds of dollars a day. A runaway loop, a
misconfigured retry policy, or one agent discovering a frontier model at 3am
can torch a week's budget before anyone notices.

Existing tools — Langfuse, Helicone, and every other observability dashboard —
tell you about it *after the money is gone*. They alert. They chart. They do
not stop the request. When your "budget" is a Slack alert that fires at 140%
of target, you don't have a budget. You have a post-mortem.

## 2. The solution, in plain terms

Spendcap is a toll booth, not a dashboard. You point your agents' OpenAI client
at Spendcap instead of OpenAI directly. Every request passes through a budget
check first:

1. Your agent asks Spendcap to make a model call.
2. Spendcap estimates the worst-case cost — from the estimated input size
   (~4 chars/token over the request messages, priced at the higher of the
   input/output rates) plus the full `max_tokens` budget as output tokens —
   and **atomically reserves it** against the key's budget. If the budget is
   blown, the call is rejected right there — nothing reaches the provider,
   nothing is billed.
3. Only then does the request go to the real provider. Afterward, Spendcap
   settles the reservation against the actual token usage and records a few
   numbers (token counts, cost) for your dashboard.

Because the reserve and the spend live in one atomic step, two agents can't
both sneak under the limit at the same time — the classic race that makes
"check-then-call" budgets leak. And because cost routing is deterministic
tiers (cheap → standard → frontier, cheapest model in the tier), you always
know exactly why a request went where it did. No ML black box: v1 routing is
deliberately boring.

## 3. Quick start (self-host)

Prerequisites: Node 20+, a Cloudflare account, `wrangler` logged in.

```bash
# 1. Install
npm install

# 2. Build everything (also typechecks the whole monorepo)
npx tsc -b

# 3. Create the D1 database, then paste the database_id into
#    packages/proxy/wrangler.toml and packages/dashboard/wrangler.toml
npx wrangler d1 create spendcap

# 4. Apply the migrations (0001: core schema, 0002: pricing seeds,
#    0004: budget uniqueness). 0003 (hosted billing) is only needed for the
#    hosted tier — self-hosters skip it.
for f in packages/data/migrations/0001_init.sql packages/data/migrations/0002_seed_pricing.sql packages/data/migrations/0004_budget_unique.sql; do
  npx wrangler d1 execute spendcap --remote --file "$f"
done

# 5. Secrets — local dev reads packages/proxy/.dev.vars and
#    packages/dashboard/.dev.vars (see .dev.vars.example files; never commit
#    real values). Set the SAME value on both workers:
#    PROVIDER_KEYS_SECRET  random 32+ bytes; encrypts provider keys at rest
#                          (the proxy decrypts, the dashboard encrypts)
#    ADMIN_TOKEN           random token for the dashboard admin API (dashboard only)

# 6. Run the workers locally (proxy and dashboard are separate workers,
#    so give them different ports; the dashboard API is on 8787 to match the
#    CLI's default SPENDCAP_API)
npx wrangler dev --config packages/dashboard/wrangler.toml --port 8787
npx wrangler dev --config packages/proxy/wrangler.toml --port 8788
#    Deploy for real: npx wrangler deploy --config packages/proxy/wrangler.toml
#    (then packages/dashboard/wrangler.toml)
```

Create a key, a budget, and a provider key via the CLI (it talks to the
*dashboard* API):

```bash
export SPENDCAP_API=http://localhost:8787
export SPENDCAP_ADMIN_TOKEN=<your ADMIN_TOKEN>

# Mint a virtual key for your fleet (the full key is shown once)
node packages/cli/dist/src/index.js keys create \
  --project fleet-1 --env live --name "prod agents"

# Cap that project at $50/day — the proxy enforces this, hard
node packages/cli/dist/src/index.js budgets set \
  --scope fleet-1 --period daily --limit-cents 5000

# Store your provider's API key (AES-GCM-encrypted in D1; the plaintext never
# persists). Use the project id as --org: self-host is single-tenant, so a
# key's org defaults to its project.
node packages/cli/dist/src/index.js provider-keys set \
  --org fleet-1 --provider openai-compatible --key sk-your-provider-key
```

Point your agents at the proxy — any OpenAI-compatible client works:

```python
from openai import OpenAI
client = OpenAI(
    base_url="http://localhost:8788/v1",  # your deployed worker URL in prod
    api_key="sc_live_...",                # the key you just minted
)
```

That's it. Requests that would exceed the budget now fail fast with
`budget_exceeded` instead of a surprise invoice.

## 4. Architecture

```
 agent ──▶ Spendcap proxy ──▶ BudgetEnforcer DO ──▶ provider (OpenAI/Anthropic/…)
                │                    │
                │  1. authorize +    │  atomic check-and-reserve
                │     reserve        │  (single-threaded per scope:
                │  2. stream         │   no check-then-call race)
                │  3. settle        │
                ▼                    ▼
           D1 (system of record: keys, budgets, usage, pricing)
```

- **Proxy** (`packages/proxy`): streaming pass-through. It never stores
  prompts — request/response bodies flow through; only token counts and cost
  are recorded.
- **BudgetEnforcer DO** (`packages/budget`): a Durable Object per budget scope.
  Single-threaded execution gives you an atomic check-and-reserve: the
  reservation and the spend decision happen in one step, so concurrent agents
  can't double-spend the same budget.
- **D1** (`packages/data`): the system of record — API keys (hash-only),
  budgets, per-call usage, pricing table. Migrations live in
  `packages/data/migrations/`.
- **DO-batched ingestion**: usage writes are buffered in the DO and flushed to
  D1 in batches (~50:1). D1's free tier allows 100k writes/day and 100 bound
  parameters per statement; batching is what keeps a busy fleet inside those
  caps instead of burning them on per-call writes. If D1's hard cap is hit,
  the flush reports `delayed` counts and the caller retries — enforcement
  itself keeps working because live budget state lives in the DO, not D1.
- **Auth** (`packages/auth`): virtual keys (`sc_live_`/`sc_test_`, hash-only
  storage), scopes, per-key model allow-lists and rate limits.
- **Arbitrage** (`packages/arbitrage`): deterministic tier routing
  (cheap → standard → frontier). **Not ML** — a pure function of the pricing
  table and your policy. ML-based confidence routing is explicitly a v2 item.
- **Guardrails** (`packages/guardrails`): velocity anomaly detection on the
  burn rate (flags spikes vs. baseline, with an absolute floor so penny
  traffic never pages anyone).
- **Dashboard** (`packages/dashboard`) + **CLI** (`packages/cli`): the
  self-hosted UI and the key/budget management CLI.
- **Commercial** (`commercial/`): hosted-tier only — Stripe billing and
  multi-tenant orgs. Self-hosters don't need it (see FAQ).

### Free-tier limits (honest numbers)

On Cloudflare's free tier the binding constraint is ~**50k metered calls/day**
(Durable Object RPC limits), with D1's 100k writes/day absorbed by the
~50:1 write batching. Past that, you're on Workers Paid — the architecture
doesn't change, only the caps. There is no SOC 2 and no data-residency story
in v1; the self-hosted answer to both is "run it in your own account."

## 5. FAQs

**How is this different from Langfuse / Helicone?**
They're observability: traces, dashboards, alerts — after the spend. Spendcap
is enforcement: the proxy refuses the call *before* the provider bills you.
Use them together if you want (traces there, budgets here); they solve
different halves of the problem.

**Do you store my prompts?**
Never — by construction, not by policy. The proxy streams request/response
bodies straight through. What lands in D1 is token counts, cost cents, model,
key hash, and timestamps. There is a test asserting the usage tables contain
no prompt/body/content/message columns, so a regression would fail the build.

**What happens when D1 caps hit?**
Writes are batched ~50:1 in the Durable Object, so normal fleets stay far
under the 100k writes/day free cap. If the hard cap is ever hit, usage flushes
report `delayed` (not lost) and retry; budget *enforcement* is unaffected
because live counters live in the DO. If you're consistently near caps,
that's the signal to move to Workers Paid.

**Self-host vs. hosted?**
Self-host is the full OSS core: proxy, budgets, dashboard, CLI — Apache-2.0,
your Cloudflare account, your data, no call-home. The hosted tier
(`commercial/`) adds multi-tenant orgs and Stripe billing so you don't run
infrastructure; it's a flat **$49/mo "Spendcap Pro"**, no usage-based billing
(deliberately out of scope in v1). Self-hosters can ignore `commercial/`
entirely.

**Is the routing "AI-powered"?**
No, and that's the point. v1 routing is deterministic tiers + heuristics — a
pure function you can read in `packages/arbitrage/src/router.ts`. ML
confidence routing is a v2 roadmap item, not a v1 claim.

**What model actually served my request?**
The default routing policy is `mode: auto` capped at the **standard** tier:
a priced hint at or below standard is honored, but a frontier hint (e.g.
`claude-opus-4.7`) is clamped to the cheapest standard-tier model (currently
`claude-sonnet-4.5`) rather than served as-is. The substitution is never
silent — every proxied success response carries an
`x-spendcap-routed-model` header with the model that actually served it.

**How long is the `x-spendcap-task` label kept?**
The task label (from the `x-spendcap-task` request header) is truncated to
128 characters at the proxy before anything is stored — it is part of the
usage rollup's unique key, so unbounded values would blow up cardinality.

**Does `sc_test_` sandbox anything?**
No — `sc_test_` vs `sc_live_` is a label on the key, not a sandbox. Test keys
enforce budgets exactly like live keys and their calls reach the real
provider. The prefix exists so you can tell them apart in the dashboard.

**What about very long streams?**
Reservations expire after 5 minutes. If a stream runs longer than that, the
reservation is swept and a later settle throws `unknown or expired
reservation` — the usage row is never written and the original estimate stays
held in `spentCents` until the budget period rolls over. Size budgets
accordingly for multi-minute streaming workloads; a second overlapping call
during that window reserves fresh budget.

## 6. Repository best practices

Monorepo layout (npm workspaces, one `package.json` per package):

```
packages/
  proxy/        streaming LLM proxy (Worker)
  budget/       BudgetEnforcer Durable Object (atomic check-and-reserve)
  auth/         virtual API keys (sc_live_/sc_test_), scopes, rate limits
  data/         D1 schema, migrations, pricing math, batched usage ingestion
  arbitrage/    deterministic tier routing (NOT ML — see above)
  guardrails/   velocity anomaly detection on burn rate
  dashboard/    self-hosted UI (Worker)
  cli/          `spendcap` CLI: keys create/revoke/rotate, budgets set
commercial/     *** hosted tier only — self-hosters skip this ***
  billing/      Stripe Checkout + webhooks for the $49/mo Pro plan
  multitenant/  org/project CRUD for the hosted control plane
```

- `packages/` is the OSS core: everything needed to self-host. `commercial/`
  is the hosted control plane's companion (billing, multi-tenancy) — it
  depends on the core, never the other way around.
- Run everything: `npx tsc -b` (build + typecheck), `npm test` (vitest
  workspace: `workers` pool for Worker/DO/D1 tests via miniflare, `node` pool
  for the rest).
- Conventions: strict TS, `?raw` SQL imports for migrations in tests, no
  network in unit tests (Stripe webhook tests use Stripe's own test helpers
  against an in-memory D1 stand-in; the one live-Stripe path is a documented
  manual test).
- Changes are tracked in [CHANGELOG.md](./CHANGELOG.md) — keep it under
  `[Unreleased]` until the first publish.
- License: Apache-2.0. See [LICENSE](./LICENSE).
