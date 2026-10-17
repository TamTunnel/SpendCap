// Spendcap data layer: pricing math + D1 usage persistence.
//
// PricingTable holds USD-per-1M-token prices. usage_detail keeps one row per
// settled call (never prompt bodies — the schema has no such column);
// usage_daily keeps the pre-aggregated rollup the dashboard reads.

export type PricingTable = Record<string, { inputPer1M: number; outputPer1M: number }>;

export class UnknownModelError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`unknown model: ${model}`);
    this.name = 'UnknownModelError';
    this.model = model;
  }
}

export interface UsageRecord {
  /** Unique per call (dedupe key for usage_detail). */
  id: string;
  /** ISO 8601 timestamp; the UTC calendar day is derived from this. */
  createdAt: string;
  projectId: string;
  keyHash: string;
  model: string;
  /** From the proxy's x-spendcap-task header. */
  task: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

function priceFor(model: string, pricing: PricingTable): { inputPer1M: number; outputPer1M: number } {
  const p = pricing[model];
  if (!p) throw new UnknownModelError(model);
  return p;
}

/**
 * Conservative pre-flight estimate: input tokens (estimated from the request
 * size by the caller) are priced at the HIGHER of the input/output rates, and
 * the entire maxTokens budget is assumed to come back as output tokens
 * (output is usually priced higher). Always rounds UP so the budget
 * reservation never under-covers the call.
 *
 * estInputTokens exists because a 200k-token prompt with max_tokens:16
 * reserves pennies under output-only math but can spend ~$1 of input tokens.
 */
export function estimateCostCents(
  model: string,
  maxTokens: number,
  estInputTokens: number,
  pricing: PricingTable,
): number {
  const p = priceFor(model, pricing);
  const inputPrice = Math.max(p.inputPer1M, p.outputPer1M);
  return Math.ceil(
    (((estInputTokens * inputPrice + maxTokens * p.outputPer1M) / 1_000_000) * 100),
  );
}

/** Exact post-call cost from counted tokens. Rounded to the nearest cent. */
export function actualCostCents(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricing: PricingTable,
): number {
  const p = priceFor(model, pricing);
  return Math.round(((inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000) * 100);
}

// D1 allows at most 100 bound parameters per statement. usage_detail takes
// 9 params/row, so 11 rows/statement keeps it under the cap.
const MAX_ROWS_PER_STATEMENT = 11;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid createdAt: ${iso}`);
  return d.toISOString().slice(0, 10);
}

export interface FlushResult {
  written: number;
  delayed: number;
}

/**
 * Persist a batch of settled usage records.
 *
 * Writes go out in chunks of 11 rows per statement (the D1 100-bound-parameter
 * cap): one INSERT into usage_detail and one upsert into usage_daily keyed on
 * (day, project_id, key_hash, model, task). The detail insert is idempotent
 * via ON CONFLICT DO NOTHING on the record id, and RETURNING tells us which
 * rows were actually new — only those feed the daily rollup, so a retried
 * batch can never double-count usage_daily. On a hard-cap failure (D1 write
 * limits, etc.) the unwritten remainder is reported as `delayed` so the
 * caller can retry it.
 */
export async function flushUsageBatch(db: D1Database, batch: UsageRecord[]): Promise<FlushResult> {
  let written = 0;
  for (const group of chunk(batch, MAX_ROWS_PER_STATEMENT)) {
    try {
      // Detail insert: ON CONFLICT DO NOTHING keeps retries safe, and
      // RETURNING reports exactly which rows were new — only those feed the
      // daily rollup below, so a retried batch can never double-count it.
      const detailValues = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const detailParams = group.flatMap((r) => [
        r.id,
        r.createdAt,
        r.projectId,
        r.keyHash,
        r.model,
        r.task,
        r.inputTokens,
        r.outputTokens,
        r.costCents,
      ]);
      const inserted = await db
        .prepare(
          `INSERT INTO usage_detail (id, created_at, project_id, key_hash, model, task, input_tokens, output_tokens, cost_cents) VALUES ${detailValues} ON CONFLICT(id) DO NOTHING RETURNING id`,
        )
        .bind(...detailParams)
        .all<{ id: string }>();
      const insertedIds = new Set((inserted.results ?? []).map((r) => r.id));
      const fresh = group.filter((r) => insertedIds.has(r.id));

      if (fresh.length > 0) {
        const dailyValues = fresh.map(() => '(?, ?, ?, ?, ?, 1, ?, ?, ?)').join(', ');
        const dailyParams = fresh.flatMap((r) => [
          dayOf(r.createdAt),
          r.projectId,
          r.keyHash,
          r.model,
          r.task,
          r.inputTokens,
          r.outputTokens,
          r.costCents,
        ]);
        await db
          .prepare(
            `INSERT INTO usage_daily (day, project_id, key_hash, model, task, calls, input_tokens, output_tokens, cost_cents) VALUES ${dailyValues} ` +
              `ON CONFLICT(day, project_id, key_hash, model, task) DO UPDATE SET ` +
              `calls = usage_daily.calls + excluded.calls, ` +
              `input_tokens = usage_daily.input_tokens + excluded.input_tokens, ` +
              `output_tokens = usage_daily.output_tokens + excluded.output_tokens, ` +
              `cost_cents = usage_daily.cost_cents + excluded.cost_cents`,
          )
          .bind(...dailyParams)
          .run();
      }
      written += group.length;
    } catch {
      // Hard-cap failure: stop here; the caller retries the delayed remainder.
      // D1 hard-cap failures reject the whole request, so neither statement
      // landed and the retry is clean: detail rows insert fresh, the rollup
      // counts each exactly once. In the hypothetical partial case (detail
      // landed, daily didn't) the retry would under-count the rollup rather
      // than double-count it — detail rows are the source of truth and are
      // never lost, while usage_daily is only a pre-aggregated read view.
      return { written, delayed: batch.length - written };
    }
  }
  return { written, delayed: 0 };
}

/** Read the whole pricing table (USD per 1M tokens) from D1. */
export async function getPricing(db: D1Database): Promise<PricingTable> {
  const res = await db
    .prepare('SELECT model, input_per_1m AS inputPer1M, output_per_1m AS outputPer1M FROM pricing')
    .all<{ model: string; inputPer1M: number; outputPer1M: number }>();
  const table: PricingTable = {};
  for (const row of res.results ?? []) {
    table[row.model] = { inputPer1M: row.inputPer1M, outputPer1M: row.outputPer1M };
  }
  return table;
}

/** Upsert pricing rows (used by the pricing refresh cron). */
export async function refreshPricing(db: D1Database, table: PricingTable, updatedAt: string): Promise<void> {
  const entries = Object.entries(table);
  for (const group of chunk(entries, MAX_ROWS_PER_STATEMENT)) {
    const values = group.map(() => '(?, ?, ?, ?)').join(', ');
    const params = group.flatMap(([model, p]) => [model, p.inputPer1M, p.outputPer1M, updatedAt]);
    await db
      .prepare(
        `INSERT INTO pricing (model, input_per_1m, output_per_1m, updated_at) VALUES ${values} ` +
          `ON CONFLICT(model) DO UPDATE SET ` +
          `input_per_1m = excluded.input_per_1m, ` +
          `output_per_1m = excluded.output_per_1m, ` +
          `updated_at = excluded.updated_at`,
      )
      .bind(...params)
      .run();
  }
}
