-- Spendcap D1 migration: seed/example model pricing (USD per 1M tokens).
-- 0002_seed_pricing.sql
--
-- seed/example — refresh via cron in production. These are illustrative 2026
-- prices so a fresh deploy has something sane to estimate against; the
-- pricing cron overwrites them via refreshPricing(). Do not treat them as
-- live quotes.

INSERT INTO pricing (model, input_per_1m, output_per_1m, updated_at) VALUES
  ('gpt-5.5', 5.00, 25.00, '2026-10-17T00:00:00.000Z'),
  ('claude-opus-4.7', 5.00, 30.00, '2026-10-17T00:00:00.000Z'),
  ('claude-sonnet-4.5', 3.00, 15.00, '2026-10-17T00:00:00.000Z'),
  ('gemini-2.5-flash-lite', 0.10, 0.40, '2026-10-17T00:00:00.000Z'),
  ('deepseek-v4-flash', 0.14, 0.28, '2026-10-17T00:00:00.000Z')
ON CONFLICT(model) DO UPDATE SET
  input_per_1m = excluded.input_per_1m,
  output_per_1m = excluded.output_per_1m,
  updated_at = excluded.updated_at;
