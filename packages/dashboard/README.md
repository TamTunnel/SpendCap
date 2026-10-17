# spendcap-dashboard

Self-hosted Spendcap UI + admin API. One Worker serves the JSON API under
`/api/*`; the static page in `public/` is served by the `[site]` bucket
(`wrangler dev` / Pages-style deploys serve it; the worker itself 404s
non-API paths).

## Auth

Every `/api/*` route requires:

```
Authorization: Bearer <ADMIN_TOKEN>
```

Missing or wrong token → `401 {"error":"unauthorized"}`. If `ADMIN_TOKEN`
is unset the worker fails closed (everything 401s).

- Production: `wrangler secret put ADMIN_TOKEN`
- Local dev: `cp .dev.vars.example .dev.vars` and edit it (gitignored).
  `wrangler.toml` carries only a `CHANGE_ME_BEFORE_DEPLOY` placeholder.

The dashboard page prompts for the token on first load and keeps it in
`sessionStorage` only — never written to disk.

## API

All responses are JSON.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/overview` | `{totalCostCents, calls, todayCostCents, activeKeys}` — all-time totals, today's UTC spend, non-revoked key count |
| `GET` | `/api/spend?groupBy=key\|model\|task\|day&days=30` | Aggregated rows from `usage_daily`. `days` clamps to 1–365. `groupBy=key` joins key name/prefix. |
| `GET` | `/api/budgets` | Budget definitions from D1 plus **live** state from the `BUDGET_DO` gateway (`getState(scopeId)` → `{scopeId, period, limitCents, spentCents, remainingCents}`). If the DO doesn't answer, `live` is `null` and the definition still returns. |
| `GET` | `/api/keys` | Key rows: hash, prefix, name, project id, env, revoked flag. The full secret is never stored and never returned here. |
| `POST` | `/api/keys` | Body `{name, projectId, env: "live"\|"test"}` → mints a key via `@tamtunnel/spendcap-auth`. Returns the **full secret exactly once** (`201`). Save it — it can't be recovered. |
| `POST` | `/api/keys/:hash/revoke` | Revokes the key. Second call → `404`. |
| `POST` | `/api/keys/:hash/rotate` | Mints a replacement (same name/project/env), revokes the old hash, returns the **new full secret once** (`201`). Rotating a revoked key → `409`. |

## UI

`public/index.html` — no build step, vanilla JS + canvas:

- KPI cards: today spend, last-30-day spend, total calls, blocked calls
  (blocked-call tracking isn't in the MVP — the card says so plainly).
- Spend-by-day bar chart (canvas), budget bars (live vs limit, red past 90%),
  breakdown tables by key / model / task.

## Security notes

- Full key secrets leave the API exactly once (create/rotate responses).
  Everything else sees only the SHA-256 hash.
- The usage tables store token counts and cost only — there is no prompt-body
  column anywhere in the schema (asserted in `packages/data` tests).
