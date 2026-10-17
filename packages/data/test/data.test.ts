import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actualCostCents,
  estimateCostCents,
  flushUsageBatch,
  getPricing,
  refreshPricing,
  UnknownModelError,
  type PricingTable,
  type UsageRecord,
} from '../src/index.js';

const PRICING: PricingTable = {
  'gpt-5.5': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

describe('data pricing math', () => {
  it('exports the contract functions', () => {
    expect(typeof estimateCostCents).toBe('function');
    expect(typeof actualCostCents).toBe('function');
  });

  it('estimates conservatively with the output price, rounding up', () => {
    // 1000 tokens * $25/1M = $0.025 = 2.5c -> ceil = 3 (no input tokens estimated)
    expect(estimateCostCents('gpt-5.5', 1000, 0, PRICING)).toBe(3);
  });

  it('computes exact cost, rounding to nearest cent', () => {
    // 200k in @ $5/1M = $1.00, 40k out @ $25/1M = $1.00 -> 200c exactly
    expect(actualCostCents(200_000, 40_000, 'gpt-5.5', PRICING)).toBe(200);
  });

  it('rounds actual to nearest (half up) while estimate always rounds up', () => {
    // 1000 in @ $5/1M = $0.005 = 0.5c -> nearest = 1
    expect(actualCostCents(1000, 0, 'gpt-5.5', PRICING)).toBe(1);
    // 200 max tokens @ $25/1M out = 0.5c -> ceil = 1
    expect(estimateCostCents('gpt-5.5', 200, 0, PRICING)).toBe(1);
    // 199 max tokens = 0.4975c -> estimate still rounds up to 1, actual-style math would round to 0
    expect(estimateCostCents('gpt-5.5', 199, 0, PRICING)).toBe(1);
  });

  it('prices estimated input tokens at the higher of input/output rates', () => {
    // 1000 input tokens @ max($5, $25)/1M = $0.025 = 2.5c -> ceil = 3,
    // plus 0 output tokens.
    expect(estimateCostCents('gpt-5.5', 0, 1000, PRICING)).toBe(3);
    // Both sides: 1000 in @ $25/1M (2.5c) + 1000 out @ $25/1M (2.5c) = 5c.
    expect(estimateCostCents('gpt-5.5', 1000, 1000, PRICING)).toBe(5);
  });

  it('fix-6-estimate-covers-input: 200k-char prompt with max_tokens:16 reserves ~$1+, not pennies', () => {
    // The old output-only math reserved ceil(16 * $25/1M) = 1¢ for this
    // call; the prompt alone is worth ~$1 of input tokens at gpt-5.5 rates.
    const estInputTokens = Math.ceil(200_000 / 4); // 50k tokens
    const reserved = estimateCostCents('gpt-5.5', 16, estInputTokens, PRICING);
    // 50k in @ $25/1M = $1.25 → 125¢, plus 16 out @ $25/1M → ceil = 126¢.
    expect(reserved).toBe(126);
    expect(reserved).toBeGreaterThanOrEqual(100); // ≥ ~$1.00, not pennies
  });

  it('throws UnknownModelError for unknown models', () => {
    expect(() => estimateCostCents('nope-1', 10, 0, PRICING)).toThrow(UnknownModelError);
    expect(() => actualCostCents(1, 1, 'nope-1', PRICING)).toThrow(UnknownModelError);
    try {
      estimateCostCents('nope-1', 10, 0, PRICING);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownModelError);
      expect((e as UnknownModelError).name).toBe('UnknownModelError');
      expect((e as UnknownModelError).model).toBe('nope-1');
    }
  });
});

describe('data D1 persistence (miniflare)', () => {
  let mf: Miniflare;
  let db: D1Database;

  const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

  // This miniflare's D1 exec() only runs a single single-LINE statement,
  // so split migration files into individual statements, collapse each to
  // one line, and drop full-line comments.
  async function applyMigration(database: D1Database, file: string): Promise<void> {
    const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await database.exec(statement);
    }
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigration(db, '0001_init.sql');
    await applyMigration(db, '0002_seed_pricing.sql');
    await applyMigration(db, '0004_budget_unique.sql');
  }, 30_000);

  afterAll(async () => {
    await mf.dispose();
  });

  it('seeds example pricing from the migration', async () => {
    const table = await getPricing(db);
    expect(table['gpt-5.5']).toEqual({ inputPer1M: 5, outputPer1M: 25 });
    expect(table['claude-opus-4.7']).toEqual({ inputPer1M: 5, outputPer1M: 30 });
    expect(table['claude-sonnet-4.5']).toEqual({ inputPer1M: 3, outputPer1M: 15 });
    expect(table['gemini-2.5-flash-lite']).toEqual({ inputPer1M: 0.1, outputPer1M: 0.4 });
    expect(table['deepseek-v4-flash']).toEqual({ inputPer1M: 0.14, outputPer1M: 0.28 });
  });

  it('refreshPricing upserts and getPricing round-trips', async () => {
    const now = '2026-10-17T12:00:00.000Z';
    await refreshPricing(db, { 'gpt-5.5': { inputPer1M: 6, outputPer1M: 26 }, 'new-model-1': { inputPer1M: 1, outputPer1M: 2 } }, now);
    const table = await getPricing(db);
    expect(table['gpt-5.5']).toEqual({ inputPer1M: 6, outputPer1M: 26 });
    expect(table['new-model-1']).toEqual({ inputPer1M: 1, outputPer1M: 2 });
    // untouched rows survive
    expect(table['deepseek-v4-flash']).toEqual({ inputPer1M: 0.14, outputPer1M: 0.28 });
    const row = await db.prepare('SELECT updated_at AS u FROM pricing WHERE model = ?').bind('gpt-5.5').first<{ u: string }>();
    expect(row?.u).toBe(now);
  });

  function record(over: Partial<UsageRecord> & { id: string }): UsageRecord {
    return {
      createdAt: '2026-10-16T10:00:00.000Z',
      projectId: 'proj_1',
      keyHash: 'hash_aaa',
      model: 'gpt-5.5',
      task: 'chat',
      inputTokens: 100,
      outputTokens: 50,
      costCents: 3,
      ...over,
    };
  }

  it('flushUsageBatch writes detail rows and rolls up daily', async () => {
    const batch = [
      record({ id: 'r1', costCents: 3 }),
      record({ id: 'r2', costCents: 7, task: 'embed' }),
      record({ id: 'r3', createdAt: '2026-10-15T23:00:00.000Z', costCents: 5 }),
    ];
    const res = await flushUsageBatch(db, batch);
    expect(res).toEqual({ written: 3, delayed: 0 });

    const detail = await db.prepare('SELECT id, cost_cents AS c FROM usage_detail WHERE id IN (?, ?, ?)').bind('r1', 'r2', 'r3').all<{ id: string; c: number }>();
    expect(detail.results.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);

    const daily = await db
      .prepare('SELECT day, task, calls, cost_cents AS c FROM usage_daily ORDER BY day, task')
      .all<{ day: string; task: string; calls: number; c: number }>();
    expect(daily.results).toEqual([
      { day: '2026-10-15', task: 'chat', calls: 1, c: 5 },
      { day: '2026-10-16', task: 'chat', calls: 1, c: 3 },
      { day: '2026-10-16', task: 'embed', calls: 1, c: 7 },
    ]);
  });

  it('flushUsageBatch is idempotent on detail rows (safe retry)', async () => {
    const res = await flushUsageBatch(db, [record({ id: 'r1', costCents: 3 })]);
    expect(res).toEqual({ written: 1, delayed: 0 });
    const { results } = await db.prepare("SELECT COUNT(*) AS n FROM usage_detail WHERE id = 'r1'").all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it('flushUsageBatch chunks to stay under the 100-param D1 cap', async () => {
    const batch = Array.from({ length: 55 }, (_, i) =>
      record({ id: `bulk-${i}`, keyHash: 'hash_bulk', task: 'bulk', createdAt: '2026-10-14T00:00:00.000Z' }),
    );
    const res = await flushUsageBatch(db, batch);
    expect(res).toEqual({ written: 55, delayed: 0 });
    const { results } = await db
      .prepare("SELECT SUM(calls) AS calls, SUM(cost_cents) AS c FROM usage_daily WHERE day = '2026-10-14'")
      .all<{ calls: number; c: number }>();
    expect(results[0]).toEqual({ calls: 55, c: 55 * 3 });
  });

  it('flushUsageBatch returns delayed on hard-cap failure', async () => {
    const failing = {
      prepare() {
        throw new Error('D1_ERROR: too many writes');
      },
    } as unknown as D1Database;
    const res = await flushUsageBatch(failing, [record({ id: 'x1' }), record({ id: 'x2' })]);
    expect(res).toEqual({ written: 0, delayed: 2 });
  });

  it('fix-9-no-double-count-on-retry: flushing the same batch twice leaves usage_daily unchanged', async () => {
    const batch = [
      record({ id: 'dup1', costCents: 11, task: 'dup-task', createdAt: '2026-10-13T00:00:00.000Z' }),
      record({ id: 'dup2', costCents: 22, task: 'dup-task', createdAt: '2026-10-13T00:00:00.000Z' }),
    ];
    expect(await flushUsageBatch(db, batch)).toEqual({ written: 2, delayed: 0 });
    const before = await db
      .prepare("SELECT calls, cost_cents AS c FROM usage_daily WHERE day = '2026-10-13' AND task = 'dup-task'")
      .first<{ calls: number; c: number }>();
    expect(before).toEqual({ calls: 2, c: 33 });
    // Retry the identical batch (e.g. after a caller-side timeout): detail
    // rows conflict harmlessly AND the daily rollup must not move.
    expect(await flushUsageBatch(db, batch)).toEqual({ written: 2, delayed: 0 });
    const after = await db
      .prepare("SELECT calls, cost_cents AS c FROM usage_daily WHERE day = '2026-10-13' AND task = 'dup-task'")
      .first<{ calls: number; c: number }>();
    expect(after).toEqual({ calls: 2, c: 33 });
    const detail = await db
      .prepare("SELECT COUNT(*) AS n FROM usage_detail WHERE task = 'dup-task'")
      .first<{ n: number }>();
    expect(detail?.n).toBe(2);
  });

  it('flushUsageBatch handles an empty batch', async () => {
    expect(await flushUsageBatch(db, [])).toEqual({ written: 0, delayed: 0 });
  });

  it('fix-15-budgets-unique-per-scope-period: duplicate (scope_id, period) rows are rejected', async () => {
    await db
      .prepare(
        "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at) VALUES ('u1', 'project', 'uniq_scope', 'daily', 100, '2026-10-17T00:00:00.000Z')",
      )
      .run();
    // Same scope+period, different id: must fail, not silently shadow.
    await expect(
      db
        .prepare(
          "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at) VALUES ('u2', 'project', 'uniq_scope', 'daily', 200, '2026-10-17T00:00:00.000Z')",
        )
        .run(),
    ).rejects.toThrow();
    // The upsert the dashboard relies on still works against the index.
    await db
      .prepare(
        `INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at)
         VALUES ('u3', 'project', 'uniq_scope', 'daily', 300, '2026-10-17T00:00:00.000Z')
         ON CONFLICT(scope_id, period) DO UPDATE SET limit_cents = excluded.limit_cents`,
      )
      .run();
    const row = await db
      .prepare('SELECT limit_cents AS l FROM budgets WHERE scope_id = ? AND period = ?')
      .bind('uniq_scope', 'daily')
      .first<{ l: number }>();
    expect(row?.l).toBe(300);
  });

  it('usage tables store no prompt bodies', async () => {
    for (const table of ['usage_detail', 'usage_daily']) {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const names = results.map((r) => r.name);
      expect(names.filter((n) => /prompt|body|content|message/i.test(n))).toEqual([]);
    }
  });
});
