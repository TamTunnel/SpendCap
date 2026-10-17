import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { generateKey } from '@tamtunnel/spendcap-auth';
import { BudgetEnforcerCore, __budgetTestHooks } from '../src/enforcer.js';
import { makeFakeDoCtx, type FakeDoCtx } from './harness.js';
import schemaSql from '../../data/migrations/0001_init.sql?raw';

// NOTE: the enforcer is instantiated directly (see harness.ts) instead of via
// env.BUDGET_DO, working around a pool/workerd isolated-storage bug.

vi.mock('@tamtunnel/spendcap-guardrails', () => ({
  detectAnomaly: vi.fn(() => ({
    anomaly: false,
    burnRateCentsPerMin: 0,
    baselineCentsPerMin: 0,
  })),
}));

import { detectAnomaly } from '@tamtunnel/spendcap-guardrails';
const mockDetectAnomaly = vi.mocked(detectAnomaly);

let n = 0;
const uid = () => `t${++n}_${Math.random().toString(36).slice(2, 10)}`;

function makeEnforcer(): { enforcer: BudgetEnforcerCore; doCtx: FakeDoCtx } {
  const doCtx = makeFakeDoCtx();
  const enforcer = new BudgetEnforcerCore(doCtx.ctx, { DB: env.DB });
  return { enforcer, doCtx };
}

/** Enforcers created during a test, drained in afterEach. */
let liveCtxs: FakeDoCtx[] = [];

function freshEnforcer(): BudgetEnforcerCore {
  const { enforcer, doCtx } = makeEnforcer();
  liveCtxs.push(doCtx);
  return enforcer;
}

async function makeKey(
  db: D1Database,
  opts: {
    budgets: { period: 'daily' | 'monthly'; limitCents: number }[];
    rateLimitPerMin?: number | null;
    revoked?: boolean;
    allowedModels?: string[] | null;
  },
): Promise<{ fullKey: string; keyHash: string; scopeId: string; projectId: string }> {
  const id = uid();
  const { fullKey, keyHash } = await generateKey('live');
  const orgId = `org_${id}`;
  const projectId = `proj_${id}`;
  const scopeId = `scope_${id}`;
  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)').bind(orgId, 'o', nowIso),
    db
      .prepare('INSERT INTO projects (id, org_id, name, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(projectId, orgId, 'p', nowIso),
    db
      .prepare(
        `INSERT INTO api_keys (key_hash, org_id, project_id, key_prefix, name, env,
                               budget_scope_id, allowed_models, rate_limit_per_min, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        keyHash,
        orgId,
        projectId,
        fullKey.slice(0, 11),
        `key_${id}`,
        'live',
        scopeId,
        opts.allowedModels ? JSON.stringify(opts.allowedModels) : null,
        opts.rateLimitPerMin ?? null,
        opts.revoked ? nowIso : null,
      ),
  ];
  for (const b of opts.budgets) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
        )
        .bind(`b_${id}_${b.period}`, 'project', scopeId, b.period, b.limitCents, nowIso),
    );
  }
  await db.batch(stmts);
  return { fullKey, keyHash, scopeId, projectId };
}

beforeAll(async () => {
  // This miniflare's D1 exec() only accepts single-line statements.
  const withoutComments = schemaSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await env.DB.exec(stmt + ';');
  }
});

afterEach(async () => {
  for (const doCtx of liveCtxs) {
    await doCtx.drain();
  }
  liveCtxs = [];
  __budgetTestHooks.now = null;
  __budgetTestHooks.flushRetryDelaysMs = [1000, 2000, 4000];
  mockDetectAnomaly.mockReset();
  mockDetectAnomaly.mockReturnValue({
    anomaly: false,
    burnRateCentsPerMin: 0,
    baselineCentsPerMin: 0,
  });
});

describe('authorizeAndReserve', () => {
  it('admits a known key and tracks spend', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const res = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reservationId).toBeTruthy();
    const state = await enforcer.getState(scopeId);
    expect(state).toMatchObject({ scopeId, period: 'daily', limitCents: 1000, spentCents: 100 });
    expect(state.remainingCents).toBe(900);
  });

  it('rejects unknown keys', async () => {
    const enforcer = freshEnforcer();
    const res = await enforcer.authorizeAndReserve({ keyHash: '0'.repeat(64), estCostCents: 100 });
    expect(res).toMatchObject({ ok: false, code: 'key_not_found' });
  });

  it('fix-13-revoked-matches-unknown: identical 401 code+message', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
      revoked: true,
    });
    const enforcer = freshEnforcer();
    const res = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    // fix-13: revoked and unknown keys are indistinguishable.
    expect(res).toEqual({ ok: false, code: 'key_not_found', message: 'unknown API key' });
  });

  it('blocks when the budget is exceeded and reports limits', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 150 }],
    });
    const enforcer = freshEnforcer();
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    const res = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('budget_exceeded');
      expect(res.limitCents).toBe(150);
      expect(res.spentCents).toBe(100);
    }
  });

  it('checks daily AND monthly when both are defined', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [
        { period: 'daily', limitCents: 500 },
        { period: 'monthly', limitCents: 10000 },
      ],
    });
    const enforcer = freshEnforcer();
    for (let i = 0; i < 5; i++) {
      expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    }
    const sixth = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.code).toBe('budget_exceeded');
      expect(sixth.limitCents).toBe(500); // the daily budget binds first
    }
  });

  it('enforces the per-minute rate limit with a sliding window', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
      rateLimitPerMin: 2,
    });
    const enforcer = freshEnforcer();
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 1 })).ok).toBe(true);
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 1 })).ok).toBe(true);
    const third = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 1 });
    expect(third).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('admits at most the budget under 50 parallel authorizes (atomic check-and-reserve)', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })),
    );
    const admitted = results.filter((r) => r.ok);
    // Exactly 10 x 100c fit in 1000c; the 11th concurrent caller must lose.
    // The check-and-reserve section contains no awaits, so even fully
    // interleaved callers serialize on it.
    expect(admitted.length).toBe(10);
    const state = await enforcer.getState(scopeId);
    expect(state.spentCents).toBe(1000);
    for (const r of results) {
      if (!r.ok) expect(r.code).toBe('budget_exceeded');
    }
  });

  it('rolls the daily period over when it elapses', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const t0 = Date.now();
    __budgetTestHooks.now = () => t0;
    await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect((await enforcer.getState(scopeId)).spentCents).toBe(100);
    __budgetTestHooks.now = () => t0 + 25 * 3600_000;
    await enforcer.authorizeAndReserve({ keyHash, estCostCents: 50 });
    expect((await enforcer.getState(scopeId)).spentCents).toBe(50);
  });

  it('pauses the key for 15 minutes on a velocity anomaly', async () => {
    mockDetectAnomaly.mockReturnValueOnce({
      anomaly: true,
      burnRateCentsPerMin: 999,
      baselineCentsPerMin: 1,
    });
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
    });
    const enforcer = freshEnforcer();
    const t0 = Date.now();
    __budgetTestHooks.now = () => t0;
    // The triggering request is admitted; the pause gates what follows.
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    const gated = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(gated).toMatchObject({ ok: false, code: 'key_paused' });
    __budgetTestHooks.now = () => t0 + 16 * 60_000;
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
  });

  it('recovers budget counters from DO storage after a cold start', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const first = makeEnforcer();
    liveCtxs.push(first.doCtx);
    await first.enforcer.authorizeAndReserve({ keyHash, estCostCents: 300 });
    await first.doCtx.drain();
    // Simulate eviction: a fresh instance over the SAME storage.
    const secondCtx = makeFakeDoCtx();
    for (const [k, v] of first.doCtx.store) secondCtx.store.set(k, v);
    liveCtxs.push(secondCtx);
    const second = new BudgetEnforcerCore(secondCtx.ctx, { DB: env.DB });
    // Must NOT admit 800: 300 of persisted spend counts against the budget.
    const res = await second.authorizeAndReserve({ keyHash, estCostCents: 800 });
    expect(res).toMatchObject({ ok: false, code: 'budget_exceeded' });
    expect((await second.getState(scopeId)).spentCents).toBe(300);
  });
});

describe('settle', () => {
  it('applies actual-minus-estimate and forbids double settle', async () => {
    const { keyHash, scopeId, projectId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const authz = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(authz.ok).toBe(true);
    const reservationId = authz.ok ? authz.reservationId : '';
    await enforcer.settle({
      reservationId,
      actualCostCents: 60,
      inputTokens: 10,
      outputTokens: 5,
      model: 'm',
      task: 't',
      keyHash,
      projectId,
    });
    expect((await enforcer.getState(scopeId)).spentCents).toBe(60);
    await expect(
      enforcer.settle({
        reservationId,
        actualCostCents: 60,
        inputTokens: 10,
        outputTokens: 5,
        model: 'm',
        keyHash,
        projectId,
      }),
    ).rejects.toThrow(/unknown or expired reservation/);
  });
});

describe('usage flush', () => {
  it('writes usage_detail rows with token counts and cost only', async () => {
    const { keyHash, projectId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const authz = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const reservationId = authz.ok ? authz.reservationId : '';
    await enforcer.settle({
      reservationId,
      actualCostCents: 60,
      inputTokens: 10,
      outputTokens: 5,
      model: 'gpt-4o-mini',
      task: 'TASK_MARKER_123',
      keyHash,
      projectId,
    });
    await enforcer.flushBatch();
    const rows = await env.DB.prepare('SELECT * FROM usage_detail WHERE task = ?1')
      .bind('TASK_MARKER_123')
      .all<Record<string, unknown>>();
    expect(rows.results?.length).toBe(1);
    const row = rows.results![0];
    expect(row).toMatchObject({
      project_id: projectId,
      key_hash: keyHash,
      model: 'gpt-4o-mini',
      input_tokens: 10,
      output_tokens: 5,
      cost_cents: 60,
    });
    // No prompt/response body columns exist on the table at all.
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'created_at',
        'project_id',
        'key_hash',
        'model',
        'task',
        'input_tokens',
        'output_tokens',
        'cost_cents',
      ].sort(),
    );
    const daily = await env.DB.prepare('SELECT calls, cost_cents FROM usage_daily WHERE task = ?1')
      .bind('TASK_MARKER_123')
      .first<{ calls: number; cost_cents: number }>();
    expect(daily).toMatchObject({ calls: 1, cost_cents: 60 });
  });

  it('flushes via the 30s alarm path', async () => {
    const { keyHash, projectId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const { enforcer, doCtx } = makeEnforcer();
    liveCtxs.push(doCtx);
    const authz = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const reservationId = authz.ok ? authz.reservationId : '';
    await enforcer.settle({
      reservationId,
      actualCostCents: 42,
      inputTokens: 7,
      outputTokens: 3,
      model: 'm',
      task: 'ALARM_TASK_X',
      keyHash,
      projectId,
    });
    // Below the 50-row threshold, settle() schedules the alarm instead.
    expect(doCtx.getAlarm()).not.toBeNull();
    await enforcer.alarm();
    const row = await env.DB.prepare('SELECT cost_cents FROM usage_detail WHERE task = ?1')
      .bind('ALARM_TASK_X')
      .first<{ cost_cents: number }>();
    expect(row?.cost_cents).toBe(42);
  });

  it('requeues and counts rows when the flush keeps failing (never silently drops)', async () => {
    __budgetTestHooks.flushRetryDelaysMs = [1, 1];
    const { keyHash, projectId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const authz = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const reservationId = authz.ok ? authz.reservationId : '';
    // Simulate a hard D1 failure by renaming the table out from under the flush.
    await env.DB.exec('ALTER TABLE usage_detail RENAME TO usage_detail_bak;');
    try {
      await enforcer.settle({
        reservationId,
        actualCostCents: 60,
        inputTokens: 10,
        outputTokens: 5,
        model: 'm',
        task: 'FAIL_TASK_X',
        keyHash,
        projectId,
      });
      await enforcer.flushBatch();
      expect(await enforcer.getDelayedFlushCount()).toBe(1);
    } finally {
      await env.DB.exec('ALTER TABLE usage_detail_bak RENAME TO usage_detail;');
    }
    // Recovery: the requeued row flushes on the next attempt.
    await enforcer.flushBatch();
    const row = await env.DB.prepare('SELECT cost_cents FROM usage_detail WHERE task = ?1')
      .bind('FAIL_TASK_X')
      .first<{ cost_cents: number }>();
    expect(row?.cost_cents).toBe(60);
    expect(await enforcer.getDelayedFlushCount()).toBe(1); // counter is cumulative
  });
});

describe('getState', () => {
  it('returns the binding constraint when daily and monthly both exist', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [
        { period: 'daily', limitCents: 500 },
        { period: 'monthly', limitCents: 10000 },
      ],
    });
    const enforcer = freshEnforcer();
    await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const state = await enforcer.getState(scopeId);
    expect(state.period).toBe('daily');
    expect(state.remainingCents).toBe(400);
  });

  it('throws for a scope with no budgets', async () => {
    const enforcer = freshEnforcer();
    await expect(enforcer.getState('nope')).rejects.toThrow(/no budgets/);
  });
});

describe('fix-1: invalidation RPCs reach the warm DO', () => {
  it('fix-1-revoke-denies-after-invalidate: no stale cache on the warm DO', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    // Warm the DO's in-memory key cache with a successful authorize.
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    // Revoke behind the DO's back (what the dashboard's D1 write does)...
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ?1 WHERE key_hash = ?2')
      .bind(new Date().toISOString(), keyHash)
      .run();
    // ...then push the invalidation the dashboard now sends.
    enforcer.invalidateKey(keyHash);
    const res = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: 'key_not_found' });
  });

  it('fix-1-invalidate-clears-pause: pause state dropped with the key', async () => {
    mockDetectAnomaly.mockReturnValueOnce({
      anomaly: true,
      burnRateCentsPerMin: 999,
      baselineCentsPerMin: 1,
    });
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
    });
    const enforcer = freshEnforcer();
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    expect(await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).toMatchObject({
      ok: false,
      code: 'key_paused',
    });
    enforcer.invalidateKey(keyHash);
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
  });

  it('fix-1-reload-scope: raised limit admits, lowered limit denies', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 150 }],
    });
    const enforcer = freshEnforcer();
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    // 100 already spent; another 100 exceeds the 150 limit.
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(false);

    // Raise the limit behind the DO's back, then reload the scope.
    await env.DB.prepare('UPDATE budgets SET limit_cents = 10000 WHERE scope_id = ?1')
      .bind(scopeId)
      .run();
    enforcer.reloadScope(scopeId);
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    // Live spend counters survive the reload (100 + 100 = 200 spent).
    expect((await enforcer.getState(scopeId)).spentCents).toBe(200);

    // Lower it below current spend: the next call is denied.
    await env.DB.prepare('UPDATE budgets SET limit_cents = 150 WHERE scope_id = ?1')
      .bind(scopeId)
      .run();
    enforcer.reloadScope(scopeId);
    const denied = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(denied).toMatchObject({ ok: false, code: 'budget_exceeded' });
    if (!denied.ok) expect(denied.limitCents).toBe(150);
  });

  it('fix-1-invalidate-unknown-hash: no-op, no throw', async () => {
    const enforcer = freshEnforcer();
    expect(() => enforcer.invalidateKey('0'.repeat(64))).not.toThrow();
  });
});

describe('fix-7: allowedModels enforcement', () => {
  it('fix-7-deny-routed-model: routed model outside the allow-list', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
      allowedModels: ['gemini-2.5-flash-lite'],
    });
    const enforcer = freshEnforcer();
    const res = await enforcer.authorizeAndReserve({
      keyHash,
      estCostCents: 100,
      modelHint: 'claude-opus-4.7',
      routedModel: 'claude-sonnet-4.5',
    });
    expect(res).toMatchObject({ ok: false, code: 'model_not_allowed' });
    if (!res.ok) expect(res.message).toContain('claude-sonnet-4.5');
  });

  it('fix-7-admit-routed-model: inside allow-list, or no allow-list, or no hint', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
      allowedModels: ['gemini-2.5-flash-lite'],
    });
    const enforcer = freshEnforcer();
    expect(
      (await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100, routedModel: 'gemini-2.5-flash-lite' })).ok,
    ).toBe(true);

    const { keyHash: openHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
    });
    expect(
      (await enforcer.authorizeAndReserve({ keyHash: openHash, estCostCents: 100, routedModel: 'anything-at-all' })).ok,
    ).toBe(true);
    // Old callers that do not pass routedModel are not broken.
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
  });
});

describe('fix-12: settle validation', () => {
  it('fix-12-settle-rejects-negative: negative/non-finite costs and tokens throw', async () => {
    const { keyHash, projectId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const authz = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const reservationId = authz.ok ? authz.reservationId : '';
    const base = {
      reservationId,
      inputTokens: 10,
      outputTokens: 5,
      model: 'm',
      keyHash,
      projectId,
    };
    await expect(enforcer.settle({ ...base, actualCostCents: -1 })).rejects.toThrow(/finite and >= 0/);
    const authz2 = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const r2 = authz2.ok ? authz2.reservationId : '';
    await expect(
      enforcer.settle({ ...base, reservationId: r2, inputTokens: -5, actualCostCents: 60 }),
    ).rejects.toThrow(/finite and >= 0/);
    const authz3 = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const r3 = authz3.ok ? authz3.reservationId : '';
    await expect(
      enforcer.settle({ ...base, reservationId: r3, outputTokens: NaN, actualCostCents: 60 }),
    ).rejects.toThrow(/finite and >= 0/);
  });

  it('fix-12-settle-rejects-key-mismatch: keyHash must match the reservation', async () => {
    const a = await makeKey(env.DB, { budgets: [{ period: 'daily', limitCents: 1000 }] });
    const b = await makeKey(env.DB, { budgets: [{ period: 'daily', limitCents: 1000 }] });
    const enforcer = freshEnforcer();
    const authz = await enforcer.authorizeAndReserve({ keyHash: a.keyHash, estCostCents: 100 });
    const reservationId = authz.ok ? authz.reservationId : '';
    await expect(
      enforcer.settle({
        reservationId,
        actualCostCents: 60,
        inputTokens: 10,
        outputTokens: 5,
        model: 'm',
        keyHash: b.keyHash, // wrong key for this reservation
        projectId: a.projectId,
      }),
    ).rejects.toThrow(/does not match the reservation/);
  });

  it('fix-14-settle-binds-reservation: usage row uses the reservation key/project', async () => {
    const { keyHash, projectId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const authz = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    const reservationId = authz.ok ? authz.reservationId : '';
    // projectId is ignored for the write (keyHash must still match per fix-12).
    await enforcer.settle({
      reservationId,
      actualCostCents: 60,
      inputTokens: 10,
      outputTokens: 5,
      model: 'm',
      task: 'FIX14_TASK',
      keyHash,
      projectId: 'caller-supplied-project',
    });
    await enforcer.flushBatch();
    const row = await env.DB.prepare('SELECT project_id AS p, key_hash AS k FROM usage_detail WHERE task = ?1')
      .bind('FIX14_TASK')
      .first<{ p: string; k: string }>();
    expect(row).toEqual({ p: projectId, k: keyHash });
  });
});

describe('fix-19: idle prune bounds per-key memory', () => {
  it('fix-19-prune-idle-keys: maps bounded after 1h idle', async () => {
    mockDetectAnomaly.mockReturnValueOnce({
      anomaly: true,
      burnRateCentsPerMin: 999,
      baselineCentsPerMin: 1,
    });
    const a = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
      rateLimitPerMin: 100,
    });
    const b = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
      rateLimitPerMin: 100,
    });
    const enforcer = freshEnforcer();
    const t0 = Date.now();
    __budgetTestHooks.now = () => t0;
    // Key A: rate window entry, spend events, and a velocity pause.
    expect((await enforcer.authorizeAndReserve({ keyHash: a.keyHash, estCostCents: 100 })).ok).toBe(true);
    expect(await enforcer.authorizeAndReserve({ keyHash: a.keyHash, estCostCents: 100 })).toMatchObject({
      ok: false,
      code: 'key_paused',
    });
    const before = enforcer.debugKeyMapSizes();
    expect(before.rateWindows).toBe(1);
    expect(before.spendEvents).toBe(1);
    expect(before.pausedUntil).toBe(1);

    // 61 minutes later, key B authorizes: A's idle state must be pruned.
    __budgetTestHooks.now = () => t0 + 61 * 60_000;
    expect((await enforcer.authorizeAndReserve({ keyHash: b.keyHash, estCostCents: 100 })).ok).toBe(true);
    const after = enforcer.debugKeyMapSizes();
    expect(after).toEqual({ keys: 1, rateWindows: 1, spendEvents: 1, pausedUntil: 0, lastSeen: 1 });

    // And A still works — its config simply reloads from D1.
    expect((await enforcer.authorizeAndReserve({ keyHash: a.keyHash, estCostCents: 100 })).ok).toBe(true);
    expect(enforcer.debugKeyMapSizes().keys).toBe(2);
  });

  it('fix-19-no-prune-active-keys: active keys keep their state', async () => {
    const a = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 100000 }],
      rateLimitPerMin: 100,
    });
    const enforcer = freshEnforcer();
    const t0 = Date.now();
    __budgetTestHooks.now = () => t0;
    await enforcer.authorizeAndReserve({ keyHash: a.keyHash, estCostCents: 100 });
    __budgetTestHooks.now = () => t0 + 30 * 60_000; // 30 min < 1h idle cutoff
    await enforcer.authorizeAndReserve({ keyHash: a.keyHash, estCostCents: 100 });
    const sizes = enforcer.debugKeyMapSizes();
    expect(sizes.rateWindows).toBe(1);
    expect(sizes.spendEvents).toBe(1);
  });
});

describe('review-rerun findings: cache TTL + estimate validation', () => {
  it('finding-1: stale cached key config refreshes from D1 after TTL (revoke lands without invalidateKey)', async () => {
    const { keyHash } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    const t0 = Date.now();
    __budgetTestHooks.now = () => t0;
    // Warm the cache.
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    // Revoke behind the DO's back; the invalidateKey RPC is LOST (tryDoRpc swallowed it).
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ?1 WHERE key_hash = ?2')
      .bind(new Date().toISOString(), keyHash)
      .run();
    // 4 minutes later: still cached, still authorizes (documented best-effort window).
    __budgetTestHooks.now = () => t0 + 4 * 60_000;
    expect((await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 })).ok).toBe(true);
    // 6 minutes later: TTL expired → re-read from D1 → revoked → denied.
    __budgetTestHooks.now = () => t0 + 6 * 60_000;
    const res = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: 'key_not_found' });
  });

  it('finding-3: authorizeAndReserve rejects non-finite estCostCents instead of poisoning the counter', async () => {
    const { keyHash, scopeId } = await makeKey(env.DB, {
      budgets: [{ period: 'daily', limitCents: 1000 }],
    });
    const enforcer = freshEnforcer();
    await expect(enforcer.authorizeAndReserve({ keyHash, estCostCents: NaN })).rejects.toThrow(
      /finite/,
    );
    await expect(enforcer.authorizeAndReserve({ keyHash, estCostCents: Infinity })).rejects.toThrow(
      /finite/,
    );
    // The budget counter is unpoisoned: a real call still enforces exactly.
    const ok = await enforcer.authorizeAndReserve({ keyHash, estCostCents: 100 });
    expect(ok.ok).toBe(true);
    const state = await enforcer.getState(scopeId);
    expect(state.spentCents).toBe(100);
    expect(Number.isFinite(state.spentCents)).toBe(true);
  });
});
