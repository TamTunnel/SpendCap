# Spendcap demo site

A self-contained, no-build-step demo of the Spendcap dashboard at
[`index.html`](index.html). It exists so anyone can see what Spendcap looks
like without deploying the proxy, the BudgetEnforcer Durable Object, or D1.

## What it is

- `index.html` — a single static file adapted from the real dashboard UI
  (`packages/dashboard/public/index.html`). Dark dev-tool styling, animated
  KPI counters, a canvas 30-day spend chart, live-feeling budget bars,
  breakdown tables (by key / agent / task / model), a proxy log panel, and a
  pricing section.
- `spendcap-demo.mp4` — a 60-second explainer video: screen capture of the
  demo with slow-zoom motion and on-screen text captions
  (title → KPIs → chart → budgets → proxy log → pricing). h264, 1080p30,
  8.4 MB. No narration — this machine has no TTS available, so captions
  carry the story.

## The data is fictional

Every number, key prefix (`sc_live_…`), agent name, budget, and log line is
made-up **sample data** embedded in the page's `SAMPLE_DATA` object. The page
says so three ways: a pulsing "LIVE DEMO — SAMPLE DATA" badge in the header,
"sample fleet" labels on the KPI section, and a "Demo only" footer note. No
real traffic, no real spend, no backend calls — open the file in any browser
and it just works.

## How it maps to the real product

| Demo element | Real product |
|---|---|
| KPI cards (today / 30-day / calls / blocked) | `GET /api/overview` + `GET /api/spend?groupBy=day` on the dashboard Worker |
| 30-day bar chart | Daily rollup from D1 usage table |
| Budget bars (94% warn, 100% blocked) | `GET /api/budgets` → BudgetEnforcer Durable Object live state (atomic check-and-reserve) |
| `402 budget_exceeded` log line | The proxy refusing a call **pre-flight** when a budget is exhausted — the product's core promise |
| `gpt-5.5 → deepseek-v4-flash, saved $1.42` line | Deterministic model arbitrage tiers (cheap → standard → frontier), not ML routing |
| Pricing tiers | Self-host OSS (Apache-2.0, $0), Hosted Pro ($49/mo flat), Enterprise (custom) |

The demo deliberately mirrors the real dashboard's look so the video can
stand in as the product's explainer; the real dashboard requires an admin
token and a live API.
