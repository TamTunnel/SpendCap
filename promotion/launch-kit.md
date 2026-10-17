# SpendCap Launch Kit — DRAFTS ONLY, nothing posted

All copy in P's voice: blunt, technical, no hype. P approves everything before it goes live.
Grounding: ~/workspace/spendcap/README.md + code. Claims flagged [VERIFY] need a live check first.

---

## 1. Show HN post

**Title:** Show HN: SpendCap – budgets that actually block for LLM agent fleets

**Body:**

SpendCap is an OpenAI-compatible proxy that refuses the call *before* the provider bills you. Budgets are enforced pre-flight with an atomic check-and-reserve — over budget means a 402 `budget_exceeded`, not a Slack alert at 140% of target.

Why I built it: I run agent fleets and got tired of post-mortem billing. Every observability tool I tried (Langfuse, Helicone) tells you about the spend after it's gone. They're dashboards. This is a toll booth.

How it works: point your OpenAI client at the proxy with a virtual key (`sc_live_...`). Each request gets a worst-case cost estimate reserved atomically in a Durable Object — concurrent agents can't double-spend the same budget (the classic check-then-call race is structurally impossible). Then the request streams through to your provider. Settle reconciles against actual usage. Prompts are never stored — streaming pass-through, only token counts and cost land in the DB, and there's a test that fails the build if a prompt-shaped column ever appears.

It's open-core (Apache-2.0): proxy, budgets, dashboard, CLI all self-host for $0 on your own Cloudflare account. Hosted Pro is $49/mo flat if you'd rather not run infra.

Honest limits, since you'll ask:
- Routing ("arbitrage") v1 is deterministic tiers + heuristics — cheap → standard → frontier, cheapest model in the tier. It is deliberately NOT ML. ML confidence routing is v2.
- OpenAI-compatible endpoints only in v1. No Anthropic-native passthrough, no embeddings/images.
- `sc_test_` keys are a label, not a sandbox — they hit the real provider.
- No SSO, no SOC 2, no data-residency story. Self-host is the answer to all three for now.
- Free-tier Cloudflare caps you around ~50k metered calls/day.

180/180 tests green. Demo (with 60s video): https://tamtunnel.github.io/SpendCap/
Repo: https://github.com/TamTunnel/SpendCap

Tear it apart — especially the reservation logic. That's the part the product is named for.

---

## 2. X thread (7 tweets)

1/ I got tired of finding out about my agent fleet's spend after the money was gone. So I built the thing I actually wanted: a proxy that refuses the call before the provider bills you.

2/ SpendCap sits between your agents and the provider. Every request gets a worst-case cost reserved atomically first. Over budget → 402 budget_exceeded. Nothing reaches the provider. Nothing is billed.

3/ The key bit: reserve and spend-decision happen in one atomic step (Durable Object, single-threaded per budget scope). Two agents can't both sneak under the limit at once. Check-then-call budgets leak. This one can't.

4/ Prompts are never stored. Streaming pass-through — request/response bodies flow through, only token counts and cost hit the DB. There's a test that fails the build if a prompt-shaped column ever shows up in the schema.

5/ It also routes: deterministic tiers (cheap → standard → frontier), cheapest model in the tier. Deliberately NOT ML — a pure function you can read. A frontier hint gets clamped to standard and the response tells you what actually served it (x-spendcap-routed-model).

6/ Open-core, Apache-2.0. Self-host for $0 on your Cloudflare account, or hosted Pro at $49/mo flat. Demo + 60s video: https://tamtunnel.github.io/SpendCap/

7/ Honest gaps: OpenAI-compatible only, no SSO/SOC 2, test keys still hit the real provider. If you run agent fleets, try to break the reservation logic — that's the part I'd most like attacked. Repo: https://github.com/TamTunnel/SpendCap

---

## 3. Reddit r/selfhosted post

**Title:** [Self-hosted] SpendCap — OpenAI-compatible proxy that enforces LLM budgets pre-flight (Apache-2.0)

**Body:**

I run agent fleets and kept getting surprised by the bill, so I built SpendCap: a self-hosted proxy on Cloudflare Workers that blocks over-budget calls *before* they reach the provider (402 `budget_exceeded`), instead of alerting you after.

Why self-host matters here: it's a cost governor — it necessarily sits in front of all your LLM traffic. The whole core is Apache-2.0 and runs in your own Cloudflare account: proxy, budget enforcement, dashboard, CLI. No call-home, no account with me needed. Your data never leaves your account.

The part I'm proudest of: budget checks are atomic (check-and-reserve in a Durable Object, single-threaded per scope), so concurrent agents can't race past the limit. And prompts are never stored — streaming pass-through, only token counts/cost recorded.

It also does deterministic model routing (cheap → standard → frontier tiers, cheapest in tier — explicitly not ML) and per-agent/per-task cost accounting via virtual keys (`sc_live_...`) plus an `x-spendcap-task` header.

Limits, honestly: OpenAI-compatible endpoints only in v1, no SSO, free-tier Cloudflare gets you ~50k metered calls/day. Test keys are label-only (they still hit the provider).

Repo: https://github.com/TamTunnel/SpendCap — README has the full quick start (`wrangler d1 create`, four migrations, deploy). Happy to answer anything about the reservation logic or the self-host setup.

---

## 4. Reddit r/LocalLLaMA post

**Title:** SpendCap — put budgets and metering in front of your local model server (open-core, self-hosted)

**Body:**

If you're serving local models (Ollama / vLLM / llama.cpp with the OpenAI-compatible endpoint) to a fleet of agents — or mixing local and API models — this might be useful: SpendCap is a self-hosted proxy that meters every call and enforces hard budgets pre-flight.

The LocalLLaMA angle: point it at your local endpoint, add a $0 pricing row for your local model [VERIFY: confirm the pricing upsert path is documented for CLI users, not just the cron], and you get per-agent/per-task cost accounting across the homelab plus the ability to tier-route: local/free for the easy stuff, API models only when the policy allows. Over budget → 402, nothing fires.

It's Apache-2.0, runs on your own Cloudflare account (Workers + D1 free tier, ~50k calls/day), prompts never stored by construction. The routing is deterministic tiers, not ML — a pure function you can read.

Not going to pretend it's built for local-first: v1 assumes OpenAI-compatible endpoints (which covers most local servers) and the pricing table ships with API models seeded. But the BYOK model means your keys stay yours, encrypted at rest.

Repo: https://github.com/TamTunnel/SpendCap. Curious whether the local-serving crowd would want anything specific — e.g. first-class $0/local tier presets.

---

## 5. Helicone migration guide

**Who this is for:** Helicone is in maintenance mode (security and bug fixes only) after the Mintlify acquisition, and the team is telling users to plan a migration. If you used Helicone as a proxy in front of your providers, here's the move.

**The one-line diff:**

```diff
- base_url="https://oai.helicone.ai/v1",  # [VERIFY] confirm exact Helicone base URL + Helicone-Auth header pattern
+ base_url="https://spendcapproxy.lzzo.net/v1",
- api_key=os.environ["HELICONE_API_KEY"],
+ api_key="sc_live_...",  # mint via the SpendCap CLI: spendcap keys create
```

**Concept mapping:**

| Helicone | SpendCap |
|---|---|
| Provider keys stored in Helicone | `spendcap provider-keys set --org <project> --provider openai-compatible --key sk-...` (AES-GCM in your D1) |
| Sessions / custom properties | `x-spendcap-task` request header (truncated to 128 chars, part of the usage rollup key) |
| Per-user cost breakdowns | Dashboard: spend by key / agent / task / model / day (keys are per-agent) |
| Rate limits | Per-key rate limits (unchanged concept) |
| Alerts on spend | Hard budgets: over-budget calls get 402 `budget_exceeded` pre-flight — this is the point, not an alert |
| Caching | No equivalent in v1 — out of scope, stated openly |
| Request/response logging | Off by default, permanently — prompts are never stored (this is a feature, not a gap) |

**What changes:** budgets become enforcement instead of notifications. Your provider keys move to your own D1 (BYOK — you hold them, encrypted). Per-request log fidelity goes down (no bodies, ever); cost fidelity goes up (atomic reservation, not estimates).

**What doesn't:** your client code stays OpenAI-compatible. Streaming works the same. You still bring your own provider keys.

**Cost of the switch:** self-host is $0 on your Cloudflare account (Apache-2.0). If you were on Helicone Pro ($79/mo), the equivalent managed tier here is $49/mo flat.

---

## 6. Comparison one-pager outline (SpendCap vs Helicone vs LiteLLM vs Portkey)

*For the website comparison page. Honest, including where competitors win. Pricing/claims below from Oct 2026 research — re-verify before publishing.*

**Frame:** "Observability tells you. Gateways route you. SpendCap stops the call."

| | SpendCap | Helicone | LiteLLM | Portkey (Prisma AIRS) |
|---|---|---|---|---|
| What it is | Cost-enforcement proxy | Observability + gateway (maintenance mode) | OSS LLM proxy | Enterprise AI gateway |
| Budget enforcement | **Atomic pre-flight block (402)** — the product | Alerts, not enforcement | Key budgets you operate yourself | Guardrail budgets; alerting-centric |
| Prompt storage | Never, by construction | Configurable logging (on by default historically [VERIFY]) | Your DB, your choice | Yes, by design |
| Routing | Deterministic tiers (v1), cheapest-in-tier | Multi-provider routing + fallbacks | YAML routing, 100+ providers | 1,600+ models, semantic cache, guardrails |
| Providers | OpenAI-compatible (v1) | Broad | 100+ | 1,600+ |
| Caching | No (v1) | Yes | Yes | Semantic caching |
| Compliance | None (self-host is the answer) | — [VERIFY] | — | SOC 2, HIPAA, ISO 27001 |
| License | Apache-2.0 (open-core) | Apache-2.0 | MIT | Gateway MIT; platform proprietary |
| Price signal | Self-host $0; Pro $49/mo flat | Pro $79/mo; Team $799/mo | Free OSS; enterprise tier | $49/mo per 100k logs |
| Vendor status | Independent, new | Mintlify-owned, maintenance mode | Independent (53.8k stars); survived Mar 2026 PyPI compromise | Palo Alto Networks-owned |

**Where competitors win, stated plainly:**
- **Helicone:** mature per-request logging and trace fidelity — if you want to *see* every request body, we will never do that. (Also: it's the thing you're migrating from, so the guide above is the bridge.)
- **LiteLLM:** provider breadth (100+) and the biggest OSS community in the category. If you need exotic providers or Bedrock/Vertex nuance on day one, start there.
- **Portkey:** enterprise checkbox compliance (SOC 2, HIPAA), semantic caching, guardrails. If your security review requires certs, we're not your vendor in v1.

**Where SpendCap wins:** it's the only one where "budget" means the call doesn't happen. Everything else is downstream of that property.

**Honest footer for the page:** "v1 is OpenAI-compatible only, deterministic routing only, no SSO/SAML. If any of those are load-bearing for you, check back — the roadmap is public."
