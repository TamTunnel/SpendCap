import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker, { type BudgetLiveState, type DashboardEnv } from '../src/index.js';
import { generateKey, hashKey } from '@tamtunnel/spendcap-auth';
import { decryptProviderKey } from '@tamtunnel/spendcap-proxy/providerKeys';
import { api, __setApiConfigForTests } from '@tamtunnel/spendcap-cli/client';
import initSql from '../../data/migrations/0001_init.sql?raw';
import seedSql from '../../data/migrations/0002_seed_pricing.sql?raw';
import uniqueSql from '../../data/migrations/0004_budget_unique.sql?raw';

// Note: the pool's `env` does not surface plain `vars` in this setup, so the
// admin token is set explicitly here. Real deploys provide ADMIN_TOKEN via
// wrangler [vars]/secrets (see wrangler.toml + .dev.vars.example).
const TOKEN = 'test-admin-token';
const PROVIDER_SECRET = 'test-provider-keys-secret';
const baseEnv = {
  ...(env as unknown as Record<string, unknown>),
  ADMIN_TOKEN: TOKEN,
  PROVIDER_KEYS_SECRET: PROVIDER_SECRET,
};

// The real BudgetEnforcer uses SQLite-backed DO storage, which trips the
// pool's isolated-storage snapshotter (known issue — the budget package's own
// suite aborts on it too). These tests substitute the binding with a fake so
// the suite stays hermetic; the worker itself always uses the real DO.
// invalidateKey/reloadScope calls are recorded in doCalls so the F1
// regression tests can assert the dashboard pushes invalidations.
const doCalls: Array<{ method: string; arg: string }> = [];
function fakeBudgetDO(live: BudgetLiveState | Error): DashboardEnv['BUDGET_DO'] {
  return {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      getState: async (_scopeId: string) => {
        if (live instanceof Error) throw live;
        return live;
      },
      invalidateKey: async (keyHash: string) => {
        doCalls.push({ method: 'invalidateKey', arg: keyHash });
      },
      reloadScope: async (scopeId: string) => {
        doCalls.push({ method: 'reloadScope', arg: scopeId });
      },
    }),
  } as unknown as DashboardEnv['BUDGET_DO'];
}

const LIVE_STATE: BudgetLiveState = {
  scopeId: 'scope-key-1',
  period: 'daily',
  limitCents: 5000,
  spentCents: 1250,
  remainingCents: 3750,
};

const testEnv = { ...baseEnv, BUDGET_DO: fakeBudgetDO(LIVE_STATE) } as unknown as DashboardEnv;

// The auth package is owned by another builder and may still be a stub when
// these tests run. Key-creation/rotation tests only run once it's real.
// (generateKey is async — WebCrypto SHA-256 — so detection awaits it.)
let authLive = false;
try {
  await generateKey('test');
  authLive = true;
} catch {
  authLive = false;
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://dashboard.test${path}`, init);
}

function authed(path: string, init?: RequestInit): Request {
  return req(path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
}

async function call(request: Request, envOverride?: DashboardEnv): Promise<{ status: number; body: unknown }> {
  const res = await worker.fetch(request, envOverride ?? testEnv, createExecutionContext());
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// This miniflare's D1 exec() only accepts single-line statements.
async function applySql(sql: string): Promise<void> {
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
  for (const s of statements) {
    await testEnv.DB.exec(s);
  }
}

const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await applySql(initSql);
  await applySql(seedSql);
  await applySql(uniqueSql);
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at)
       VALUES ('b1', 'key', 'scope-key-1', 'daily', 5000, '2026-10-17T00:00:00.000Z')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO api_keys (key_hash, project_id, key_prefix, name, env, created_at)
       VALUES ('seedhash1', 'proj_1', 'sc_test_', 'seed key', 'test', '2026-10-16T00:00:00.000Z')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO api_keys (key_hash, project_id, key_prefix, name, env, revoked_at, created_at)
       VALUES ('seedhash2', 'proj_1', 'sc_live_', 'old key', 'live', '2026-10-16T01:00:00.000Z', '2026-10-15T00:00:00.000Z')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO usage_daily (day, project_id, key_hash, model, task, calls, input_tokens, output_tokens, cost_cents)
       VALUES (?, 'proj_1', 'seedhash1', 'gpt-5.5', 'chat', 10, 1000, 500, 2500)`,
    ).bind(today),
    testEnv.DB.prepare(
      `INSERT INTO usage_daily (day, project_id, key_hash, model, task, calls, input_tokens, output_tokens, cost_cents)
       VALUES (?, 'proj_1', 'seedhash1', 'gpt-5.5', 'summarize', 2, 200, 100, 500)`,
    ).bind(today),
    testEnv.DB.prepare(
      `INSERT INTO usage_daily (day, project_id, key_hash, model, task, calls, input_tokens, output_tokens, cost_cents)
       VALUES ('2026-10-10', 'proj_1', 'seedhash1', 'deepseek-v4-flash', 'embed', 100, 5000, 1000, 10000)`,
    ),
  ]);
}, 30_000);

describe('dashboard worker', () => {
  it('exports a fetch handler', () => {
    expect(typeof worker.fetch).toBe('function');
  });

  it('rejects unauthenticated and wrong-token requests on all /api/* routes', async () => {
    for (const path of ['/api/overview', '/api/spend', '/api/budgets', '/api/keys']) {
      const noAuth = await call(req(path));
      expect(noAuth.status).toBe(401);
      const wrong = await call(req(path, { headers: { authorization: 'Bearer nope' } }));
      expect(wrong.status).toBe(401);
    }
  });

  it('GET /api/overview aggregates spend and counts active keys', async () => {
    const { status, body } = await call(authed('/api/overview'));
    expect(status).toBe(200);
    expect(body).toEqual({
      totalCostCents: 2500 + 500 + 10000,
      calls: 10 + 2 + 100,
      todayCostCents: 2500 + 500,
      activeKeys: 1, // seedhash2 is revoked
    });
  });

  it('GET /api/spend groups by model and day', async () => {
    const byModel = await call(authed('/api/spend?groupBy=model&days=30'));
    expect(byModel.status).toBe(200);
    const rows = (byModel.body as { rows: Array<{ model: string; costCents: number; calls: number }> }).rows;
    expect(rows.map((r) => r.model).sort()).toEqual(['deepseek-v4-flash', 'gpt-5.5']);
    const gpt = rows.find((r) => r.model === 'gpt-5.5');
    expect(gpt?.costCents).toBe(3000);
    expect(gpt?.calls).toBe(12);

    const byDay = await call(authed('/api/spend?groupBy=day&days=30'));
    expect(byDay.status).toBe(200);
    const dayRows = (byDay.body as { rows: Array<{ day: string }> }).rows;
    expect(dayRows.map((r) => r.day)).toEqual(['2026-10-10', today]); // chronological
  });

  it('GET /api/spend groups by key with key metadata', async () => {
    const { status, body } = await call(authed('/api/spend?groupBy=key&days=30'));
    expect(status).toBe(200);
    const rows = (body as { rows: Array<{ keyHash: string; keyName: string; keyPrefix: string; costCents: number }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].keyHash).toBe('seedhash1');
    expect(rows[0].keyName).toBe('seed key');
    expect(rows[0].keyPrefix).toBe('sc_test_');
    expect(rows[0].costCents).toBe(13000);
  });

  it('GET /api/spend rejects bad groupBy', async () => {
    const { status } = await call(authed('/api/spend?groupBy=bogus'));
    expect(status).toBe(400);
  });

  it('GET /api/budgets returns definitions plus live DO state', async () => {
    const { status, body } = await call(authed('/api/budgets'));
    expect(status).toBe(200);
    const budgets = (body as { budgets: Array<{ id: string; scopeId: string; limitCents: number; live: BudgetLiveState | null }> }).budgets;
    expect(budgets).toHaveLength(1);
    expect(budgets[0].id).toBe('b1');
    expect(budgets[0].scopeId).toBe('scope-key-1');
    expect(budgets[0].limitCents).toBe(5000);
    // The fake DO answers with LIVE_STATE; the shape must match the
    // BudgetEnforcer.getState contract.
    expect(budgets[0].live).toEqual(LIVE_STATE);
  });

  it('GET /api/budgets still returns definitions when the DO does not answer', async () => {
    const deadEnv = { ...baseEnv, BUDGET_DO: fakeBudgetDO(new Error('do unreachable')) } as unknown as DashboardEnv;
    const { status, body } = await call(authed('/api/budgets'), deadEnv);
    expect(status).toBe(200);
    const budgets = (body as { budgets: Array<{ id: string; live: unknown }> }).budgets;
    expect(budgets).toHaveLength(1);
    expect(budgets[0].id).toBe('b1');
    expect(budgets[0].live).toBeNull();
  });

  it('GET /api/keys lists keys without ever exposing secrets', async () => {
    const { status, body } = await call(authed('/api/keys'));
    expect(status).toBe(200);
    const keys = (body as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k).not.toHaveProperty('key');
      expect(k).not.toHaveProperty('secret');
      expect(k).not.toHaveProperty('fullKey');
      expect(typeof k.keyHash).toBe('string');
      expect(typeof k.keyPrefix).toBe('string');
      expect(typeof k.revoked).toBe('boolean');
    }
    const revoked = keys.find((k) => k.keyHash === 'seedhash2');
    expect(revoked?.revoked).toBe(true);
  });

  it('POST /api/keys validates input before touching key generation', async () => {
    for (const bad of [
      {},
      { name: 'x' },
      { name: 'x', projectId: 'p', env: 'prod' },
      { name: '', projectId: 'p', env: 'test' },
    ]) {
      const { status } = await call(
        authed('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) }),
      );
      expect(status).toBe(400);
    }
  });

  it.skipIf(!authLive)('POST /api/keys creates a key and returns the full secret once', async () => {
    const { status, body } = await call(
      authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ci key', projectId: 'proj_9', env: 'test' }),
      }),
    );
    expect(status).toBe(201);
    const created = body as { key: string; keyHash: string; keyPrefix: string };
    expect(created.key.startsWith('sc_test_')).toBe(true);
    expect(created.keyHash).toBe(await hashKey(created.key));

    // The secret is not recoverable afterwards: listing shows only the hash.
    const listed = await call(authed('/api/keys'));
    const keys = (listed.body as { keys: Array<{ keyHash: string; name: string }> }).keys;
    const row = keys.find((k) => k.keyHash === created.keyHash);
    expect(row?.name).toBe('ci key');
    expect(JSON.stringify(keys)).not.toContain(created.key);
  });

  it('POST /api/keys/:hash/revoke revokes once, then 404s', async () => {
    const first = await call(authed('/api/keys/seedhash1/revoke', { method: 'POST' }));
    expect(first.status).toBe(200);
    expect((first.body as { revoked: boolean }).revoked).toBe(true);

    const row = await testEnv.DB.prepare('SELECT revoked_at AS r FROM api_keys WHERE key_hash = ?')
      .bind('seedhash1')
      .first<{ r: string }>();
    expect(row?.r).not.toBeNull();

    const second = await call(authed('/api/keys/seedhash1/revoke', { method: 'POST' }));
    expect(second.status).toBe(404);
    const missing = await call(authed('/api/keys/does-not-exist/revoke', { method: 'POST' }));
    expect(missing.status).toBe(404);
  });

  it.skipIf(!authLive)('POST /api/keys/:hash/rotate issues a new secret and revokes the old', async () => {
    const created = await call(
      authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rot key', projectId: 'proj_9', env: 'live' }),
      }),
    );
    const oldHash = (created.body as { keyHash: string }).keyHash;

    const rotated = await call(authed(`/api/keys/${oldHash}/rotate`, { method: 'POST' }));
    expect(rotated.status).toBe(201);
    const r = rotated.body as { key: string; keyHash: string; rotatedFrom: string };
    expect(r.key.startsWith('sc_live_')).toBe(true);
    expect(r.keyHash).not.toBe(oldHash);
    expect(r.rotatedFrom).toBe(oldHash);

    const oldRow = await testEnv.DB.prepare('SELECT revoked_at AS r FROM api_keys WHERE key_hash = ?')
      .bind(oldHash)
      .first<{ r: string }>();
    expect(oldRow?.r).not.toBeNull();

    const again = await call(authed(`/api/keys/${oldHash}/rotate`, { method: 'POST' }));
    expect(again.status).toBe(409);
  });

  it('unknown routes 404', async () => {
    const { status } = await call(authed('/nope'));
    expect(status).toBe(404);
  });
});

describe('regression: review + adversarial fixes', () => {
  beforeEach(() => {
    doCalls.length = 0;
    __setApiConfigForTests(null);
    vi.unstubAllGlobals();
  });

  it('fix-1-revoke-pushes-invalidation: POST /api/keys/:hash/revoke calls DO invalidateKey', async () => {
    const created = await call(
      authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'inv key', projectId: 'proj_inv', env: 'test' }),
      }),
    );
    expect(created.status).toBe(201);
    const { keyHash } = created.body as { keyHash: string };

    const revoked = await call(authed(`/api/keys/${keyHash}/revoke`, { method: 'POST' }));
    expect(revoked.status).toBe(200);
    expect(doCalls).toContainEqual({ method: 'invalidateKey', arg: keyHash });
  });

  it('fix-1-rotate-pushes-invalidation: POST /api/keys/:hash/rotate invalidates the old key', async () => {
    const created = await call(
      authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rot inv key', projectId: 'proj_rotinv', env: 'test' }),
      }),
    );
    const { keyHash: oldHash } = created.body as { keyHash: string };
    const rotated = await call(authed(`/api/keys/${oldHash}/rotate`, { method: 'POST' }));
    expect(rotated.status).toBe(201);
    expect(doCalls).toContainEqual({ method: 'invalidateKey', arg: oldHash });
  });

  it('fix-3-create-key-defaults-budget-scope: budget_scope_id = projectId, not NULL', async () => {
    const { status, body } = await call(
      authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'scoped key', projectId: 'proj_scoped', env: 'live' }),
      }),
    );
    expect(status).toBe(201);
    const { keyHash } = body as { keyHash: string };
    const row = await testEnv.DB.prepare(
      'SELECT budget_scope_id AS b, org_id AS o FROM api_keys WHERE key_hash = ?1',
    )
      .bind(keyHash)
      .first<{ b: string | null; o: string | null }>();
    expect(row?.b).toBe('proj_scoped');
    expect(row?.o).toBe('proj_scoped');
  });

  it('fix-3-set-budget: POST /api/budgets upserts and calls DO reloadScope', async () => {
    const first = await call(
      authed('/api/budgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeType: 'project', scopeId: 'proj_b1', period: 'daily', limitCents: 5000 }),
      }),
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true });
    expect(doCalls).toContainEqual({ method: 'reloadScope', arg: 'proj_b1' });

    // Upsert: same scope+period replaces the limit (no duplicate rows).
    const second = await call(
      authed('/api/budgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeType: 'project', scopeId: 'proj_b1', period: 'daily', limitCents: 7000 }),
      }),
    );
    expect(second.status).toBe(200);
    const rows = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM budgets WHERE scope_id = 'proj_b1' AND period = 'daily'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const row = await testEnv.DB.prepare(
      "SELECT limit_cents AS l FROM budgets WHERE scope_id = 'proj_b1' AND period = 'daily'",
    ).first<{ l: number }>();
    expect(row?.l).toBe(7000);
  });

  it('fix-3-set-budget validates input', async () => {
    for (const bad of [
      {},
      { scopeType: 'project', scopeId: 'p', period: 'daily' },
      { scopeType: 'org', scopeId: 'p', period: 'daily', limitCents: 100 },
      { scopeType: 'project', scopeId: 'p', period: 'weekly', limitCents: 100 },
      { scopeType: 'project', scopeId: 'p', period: 'daily', limitCents: 0 },
      { scopeType: 'project', scopeId: 'p', period: 'daily', limitCents: -5 },
      { scopeType: 'project', scopeId: 'p', period: 'daily', limitCents: 1.5 },
    ]) {
      const { status } = await call(
        authed('/api/budgets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bad),
        }),
      );
      expect(status).toBe(400);
    }
  });

  it('fix-3-patch-key: PATCH /api/keys/:hash updates name and budget scope', async () => {
    const created = await call(
      authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'patch me', projectId: 'proj_patch', env: 'test' }),
      }),
    );
    const { keyHash } = created.body as { keyHash: string };

    const renamed = await call(
      authed(`/api/keys/${keyHash}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'patched name' }),
      }),
    );
    expect(renamed.status).toBe(200);

    const rescoped = await call(
      authed(`/api/keys/${keyHash}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budgetScopeId: 'other-scope' }),
      }),
    );
    expect(rescoped.status).toBe(200);
    expect(doCalls).toContainEqual({ method: 'invalidateKey', arg: keyHash });

    const row = await testEnv.DB.prepare(
      'SELECT name AS n, budget_scope_id AS b FROM api_keys WHERE key_hash = ?1',
    )
      .bind(keyHash)
      .first<{ n: string; b: string }>();
    expect(row).toEqual({ n: 'patched name', b: 'other-scope' });

    const missing = await call(
      authed('/api/keys/nope', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
    );
    expect(missing.status).toBe(404);
    const empty = await call(
      authed(`/api/keys/${keyHash}`, { method: 'PATCH', body: JSON.stringify({}) }),
    );
    expect(empty.status).toBe(400);
  });

  it('fix-4-provider-keys: POST /api/provider-keys stores an encrypted key', async () => {
    const { status, body } = await call(
      authed('/api/provider-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: 'org_pk1', provider: 'openai-compatible', key: 'sk-live-secret' }),
      }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, orgId: 'org_pk1' });

    const row = await testEnv.DB.prepare(
      'SELECT enc_key AS e FROM provider_keys WHERE org_id = ?1 AND provider = ?2',
    )
      .bind('org_pk1', 'openai-compatible')
      .first<{ e: string }>();
    expect(row?.e).not.toContain('sk-live-secret'); // never plaintext in D1
    expect(await decryptProviderKey(row!.e, PROVIDER_SECRET)).toBe('sk-live-secret');

    // Re-setting replaces the row (one active key per org+provider).
    await call(
      authed('/api/provider-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: 'org_pk1', provider: 'openai-compatible', key: 'sk-rotated' }),
      }),
    );
    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM provider_keys WHERE org_id = 'org_pk1'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('fix-4-provider-keys validates input', async () => {
    const { status } = await call(
      authed('/api/provider-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: 'o', provider: 'p' }),
      }),
    );
    expect(status).toBe(400);
  });

  it('fix-10-provider-keys-fails-closed: unset PROVIDER_KEYS_SECRET -> 500, nothing stored', async () => {
    const noSecretEnv = { ...testEnv, PROVIDER_KEYS_SECRET: '' } as unknown as DashboardEnv;
    const { status, body } = await call(
      authed('/api/provider-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: 'org_nosecret', provider: 'p', key: 'sk-x' }),
      }),
      noSecretEnv,
    );
    expect(status).toBe(500);
    expect(JSON.stringify(body)).toContain('PROVIDER_KEYS_SECRET');
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM provider_keys WHERE org_id = 'org_nosecret'").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('fix-2-cli-contract: create key -> set budget -> set provider key -> revoke, all via the CLI HTTP client', async () => {
    // Drive the CLI's actual HTTP functions against the dashboard worker:
    // global fetch is routed into worker.fetch, so every path/body the CLI
    // builds is checked against the real router. Any 404 here means the
    // CLI and dashboard disagree on the contract.
    __setApiConfigForTests({ base: 'https://dashboard.test', token: TOKEN });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      return worker.fetch(req, testEnv, createExecutionContext());
    });

    const created = await api<{ key: string; keyHash: string; keyPrefix: string }>('/api/keys', {
      projectId: 'proj_contract',
      env: 'test',
      name: 'contract key',
    });
    expect(created.key.startsWith('sc_test_')).toBe(true);

    const budgeted = await api<{ ok: boolean }>('/api/budgets', {
      scopeType: 'project',
      scopeId: 'proj_contract',
      period: 'daily',
      limitCents: 5000,
    });
    expect(budgeted.ok).toBe(true);
    expect(doCalls).toContainEqual({ method: 'reloadScope', arg: 'proj_contract' });

    const pk = await api<{ ok: boolean }>('/api/provider-keys', {
      orgId: 'proj_contract',
      provider: 'openai-compatible',
      key: 'sk-contract-secret',
    });
    expect(pk.ok).toBe(true);

    const revoked = await api<{ revoked: boolean }>(`/api/keys/${created.keyHash}/revoke`, {});
    expect(revoked.revoked).toBe(true);
    expect(doCalls).toContainEqual({ method: 'invalidateKey', arg: created.keyHash });

    // The CLI's old (broken) paths must NOT exist anymore.
    await expect(api('/api/keys/revoke', { keyHash: created.keyHash })).rejects.toThrow(/404/);
    await expect(api('/api/keys/rotate', { keyHash: created.keyHash })).rejects.toThrow(/404/);
  });
});
