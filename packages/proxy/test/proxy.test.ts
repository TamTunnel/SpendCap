import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createExecutionContext,
  createScheduledController,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { generateKey } from '@tamtunnel/spendcap-auth';
import { BudgetEnforcerCore } from '../../budget/src/enforcer.js';
import { makeFakeDoCtx, type FakeDoCtx } from '../../budget/test/harness.js';
import { encryptProviderKey } from '../src/providerKeys.js';
import worker, { __proxyTestHooks, forwardWithUsageSniffing } from '../src/index.js';
import type { Env } from '../src/types.js';
import schemaSql from '../../data/migrations/0001_init.sql?raw';

// NOTE: the budget enforcer is instantiated directly (see budget/test/harness.ts)
// instead of via env.BUDGET_DO, working around a pool/workerd isolated-storage bug.
// Outbound provider calls are mocked with fetchMock (same isolate as the worker).

const PROVIDER_SECRET = 'test-provider-keys-secret';
const PROVIDER_PLAINTEXT = 'sk-test-provider-secret-XYZ-123';
const PROVIDER_ORIGIN = 'https://provider.test';

const PRICING = {
  'test-model-a': { inputPer1M: 200, outputPer1M: 800 }, // $2 / $8 per 1M
  'gemini-2.5-flash-lite': { inputPer1M: 50, outputPer1M: 100 },
  'deepseek-v4-flash': { inputPer1M: 60, outputPer1M: 120 },
  'claude-sonnet-4.5': { inputPer1M: 300, outputPer1M: 1500 },
  'claude-opus-4.7': { inputPer1M: 500, outputPer1M: 3000 },
};

let n = 0;
const uid = () => `p${++n}_${Math.random().toString(36).slice(2, 10)}`;

let liveCtxs: FakeDoCtx[] = [];

interface Fixture {
  proxyEnv: Env;
  enforcer: BudgetEnforcerCore;
  fullKey: string;
  keyHash: string;
  scopeId: string;
  projectId: string;
}

async function makeFixture(
  db: D1Database,
  opts: {
    budgetCents?: number;
    rateLimitPerMin?: number | null;
    revoked?: boolean;
    withProviderKey?: boolean;
    allowedModels?: string[] | null;
    /**
     * Shape the key the way the dashboard creates it: budget_scope_id =
     * project_id, with the budget row on the project scope (fix-3).
     */
    projectScopedBudget?: boolean;
  } = {},
): Promise<Fixture> {
  const id = uid();
  const { fullKey, keyHash } = await generateKey('live');
  // Single-tenant self-host model, mirroring the dashboard's handleCreateKey:
  // the key's org is its project.
  const projectId = `proj_${id}`;
  const orgId = projectId;
  const scopeId = `scope_${id}`;
  const nowIso = new Date().toISOString();
  // Effective budget scope: a dedicated scope by default; the project id
  // when projectScopedBudget is set (the dashboard-created key shape).
  const budgetScope = opts.projectScopedBudget ? projectId : scopeId;
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
        budgetScope,
        opts.allowedModels ? JSON.stringify(opts.allowedModels) : null,
        opts.rateLimitPerMin ?? null,
        opts.revoked ? nowIso : null,
      ),
    db
      .prepare(
        'INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      )
      // The budget lives on the key's effective budget scope.
      .bind(`b_${id}`, 'project', budgetScope, 'daily', opts.budgetCents ?? 100000, nowIso),
  ];
  if (opts.withProviderKey !== false) {
    const enc = await encryptProviderKey(PROVIDER_PLAINTEXT, PROVIDER_SECRET);
    stmts.push(
      db
        .prepare(
          'INSERT INTO provider_keys (id, org_id, provider, enc_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
        )
        .bind(`pk_${id}`, orgId, 'openai-compatible', enc, nowIso),
    );
  }
  await db.batch(stmts);

  const doCtx = makeFakeDoCtx();
  liveCtxs.push(doCtx);
  const enforcer = new BudgetEnforcerCore(doCtx.ctx, { DB: db });
  const fakeNs = {
    idFromName: (name: string) => ({ name }),
    get: () => enforcer,
  };
  const proxyEnv = {
    BUDGET_DO: fakeNs,
    DB: db,
    PROVIDER_KEYS_SECRET: PROVIDER_SECRET,
    DEFAULT_PROVIDER_BASE_URL: PROVIDER_ORIGIN,
  } as unknown as Env;
  return { proxyEnv, enforcer, fullKey, keyHash, scopeId, projectId };
}

async function seedPricing(db: D1Database) {
  const nowIso = new Date().toISOString();
  await db.batch(
    Object.entries(PRICING).map(([model, p]) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO pricing (model, input_per_1m, output_per_1m, updated_at) VALUES (?1, ?2, ?3, ?4)',
        )
        .bind(model, p.inputPer1M, p.outputPer1M, nowIso),
    ),
  );
}

function chatBody(prompt: string, extra: Record<string, unknown> = {}) {
  return {
    model: 'test-model-a',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
    ...extra,
  };
}

function chatRequest(fullKey: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${PROVIDER_ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${fullKey}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // The pool deactivates fetchMock before each file: opt in explicitly, then
  // block all real network so a missed intercept fails loudly instead of
  // leaking.
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const withoutComments = schemaSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const stmt of withoutComments
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)) {
    await env.DB.exec(stmt + ';');
  }
  await seedPricing(env.DB);
});

beforeEach(async () => {
  for (const doCtx of liveCtxs) {
    await doCtx.drain();
  }
  liveCtxs = [];
  __proxyTestHooks.resetPricingCache();
});

async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

async function scanDbFor(db: D1Database, needle: string): Promise<string[]> {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();
  const hits: string[] = [];
  for (const { name } of tables.results ?? []) {
    const rows = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    if (JSON.stringify(rows.results).includes(needle)) hits.push(name);
  }
  return hits;
}

describe('POST /v1/chat/completions', () => {
  it('proxies a non-streaming call, rewrites the model, and settles actual cost', async () => {
    const fx = await makeFixture(env.DB);
    const PROMPT = 'PROMPT_MARKER_NONSTREAM_ABC';
    let providerCalls = 0;
    let capturedBody = '';
    let capturedAuth = '';
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(
        (opts) => {
          providerCalls++;
          capturedBody = String(opts.body ?? '');
          capturedAuth = String((opts.headers as Record<string, string>).authorization ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'hello' } }],
              usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
            }),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        },
      );
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, chatBody(PROMPT), { 'x-spendcap-task': 'task-1' }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.choices[0].message.content).toBe('hello');
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    await fx.enforcer.flushBatch(); // settle() batches; flush explicitly like the DO alarm would

    // Reservation-or-nothing: the provider was called exactly once, after auth.
    expect(providerCalls).toBe(1);    // Model rewritten to the routed model; provider key forwarded, never the user key.
    const sent = JSON.parse(capturedBody);
    expect(sent.model).toBe('test-model-a');
    expect(sent.messages[0].content).toBe(PROMPT);
    expect(capturedAuth).toBe(`Bearer ${PROVIDER_PLAINTEXT}`);

    // Settled with actual cost: (1000*200 + 500*800)/1e6*100 = 60c.
    const state = await fx.enforcer.getState(fx.scopeId);
    expect(state.spentCents).toBe(60);

    // Usage row persisted with token counts and task label.
    const row = await env.DB.prepare('SELECT * FROM usage_detail WHERE task = ?1')
      .bind('task-1')
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      key_hash: fx.keyHash,
      model: 'test-model-a',
      input_tokens: 1000,
      output_tokens: 500,
      cost_cents: 60,
    });

    // Privacy: the prompt body and the raw provider secret appear nowhere in D1.
    expect(await scanDbFor(env.DB, PROMPT)).toEqual([]);
    expect(await scanDbFor(env.DB, PROVIDER_PLAINTEXT)).toEqual([]);
  });

  it('streams SSE to the client unbuffered and settles from the final usage chunk', async () => {
    const fx = await makeFixture(env.DB);
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":1000,"total_tokens":3000}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(200, sse, { headers: { 'content-type': 'text/event-stream' } });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, chatBody('stream me', { stream: true })),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toBe(sse); // byte-identical pass-through
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();

    // (2000*200 + 1000*800)/1e6*100 = 120c.
    expect((await fx.enforcer.getState(fx.scopeId)).spentCents).toBe(120);
  });

  it('injects stream_options.include_usage on streaming requests', async () => {
    const fx = await makeFixture(env.DB);
    let capturedBody = '';
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply((opts) => {
        capturedBody = String(opts.body ?? '');
        return {
          statusCode: 200,
          data: 'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
          responseOptions: { headers: { 'content-type': 'text/event-stream' } },
        };
      });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, chatBody('x', { stream: true })),
      fx.proxyEnv,
      ctx,
    );
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(JSON.parse(capturedBody).stream_options).toMatchObject({ include_usage: true });
  });

  it('falls back to the cheapest cheap model for an unpriced hint', async () => {
    const fx = await makeFixture(env.DB);
    let capturedBody = '';
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply((opts) => {
        capturedBody = String(opts.body ?? '');
        return {
          statusCode: 200,
          data: JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, { ...chatBody('x'), model: 'not-a-real-model' }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(JSON.parse(capturedBody).model).toBe('gemini-2.5-flash-lite');
  });

  it('returns 402 without calling the provider when the budget is exceeded', async () => {
    const fx = await makeFixture(env.DB, { budgetCents: 1 });
    // No intercept registered: with disableNetConnect(), any provider call
    // would throw and surface as a 502, failing the 402 assertion below.
    const ctx = createExecutionContext();
    const res = await worker.fetch(chatRequest(fx.fullKey, chatBody('x')), fx.proxyEnv, ctx);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual({
      error: expect.objectContaining({ code: 'budget_exceeded' }),
    });
    await waitOnExecutionContext(ctx);
  });

  it('returns 401 for missing, malformed, and unknown keys', async () => {
    const fx = await makeFixture(env.DB);
    const ctx = createExecutionContext();
    const noAuth = await worker.fetch(
      new Request(`${PROVIDER_ORIGIN}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      fx.proxyEnv,
      ctx,
    );
    expect(noAuth.status).toBe(401);

    const malformed = await worker.fetch(
      chatRequest('sc_live_short', chatBody('x')),
      fx.proxyEnv,
      ctx,
    );
    expect(malformed.status).toBe(401);
    expect((await jsonBody(malformed)).error.code).toBe('invalid_key');

    const unknownKey = `sc_live_${'a'.repeat(43)}`; // well-formed but never issued
    const unknown = await worker.fetch(chatRequest(unknownKey, chatBody('x')), fx.proxyEnv, ctx);
    expect(unknown.status).toBe(401);
    expect((await jsonBody(unknown)).error.code).toBe('key_not_found');
  });

  it('returns 401 for a revoked key and 429 when rate limited', async () => {
    const revokedFx = await makeFixture(env.DB, { revoked: true });
    const ctx = createExecutionContext();
    const revokedRes = await worker.fetch(
      chatRequest(revokedFx.fullKey, chatBody('x')),
      revokedFx.proxyEnv,
      ctx,
    );
    expect(revokedRes.status).toBe(401);
    // fix-13: revoked keys are indistinguishable from unknown keys.
    expect(await jsonBody(revokedRes)).toEqual({
      error: { code: 'key_not_found', message: 'unknown API key' },
    });

    const rlFx = await makeFixture(env.DB, { rateLimitPerMin: 1 });
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(200, JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        headers: { 'content-type': 'application/json' },
      });
    const ctx2 = createExecutionContext();
    const first = await worker.fetch(chatRequest(rlFx.fullKey, chatBody('x')), rlFx.proxyEnv, ctx2);
    expect(first.status).toBe(200);
    await first.text();
    const second = await worker.fetch(
      chatRequest(rlFx.fullKey, chatBody('x')),
      rlFx.proxyEnv,
      ctx2,
    );
    expect(second.status).toBe(429);
    expect((await jsonBody(second)).error.code).toBe('rate_limited');
    await waitOnExecutionContext(ctx2);
  });

  it('releases the reservation (settle 0) when the provider errors', async () => {
    const fx = await makeFixture(env.DB);
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(500, JSON.stringify({ error: { message: 'upstream exploded' } }), {
        headers: { 'content-type': 'application/json' },
      });
    const ctx = createExecutionContext();
    const res = await worker.fetch(chatRequest(fx.fullKey, chatBody('x')), fx.proxyEnv, ctx);
    expect(res.status).toBe(500);
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    // Failed call costs nothing: the 40c estimate was reserved then released.
    expect((await fx.enforcer.getState(fx.scopeId)).spentCents).toBe(0);
  });

  it('settles with the estimate when the provider stream aborts', async () => {
    const fx = await makeFixture(env.DB);
    const enc = new TextEncoder();
    const aborting = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        controller.error(new Error('connection reset'));
      },
    });
    const providerRes = new Response(aborting, {
      headers: { 'content-type': 'text/event-stream' },
    });
    // Unit-test the sniffer directly: usage must resolve null on abort.
    const { response, usage } = forwardWithUsageSniffing(providerRes);
    await expect(response.text()).rejects.toThrow();
    expect(await usage).toBeNull();

    // And the worker settles the estimate (40c for max_tokens=500) on abort.
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(200, 'data: {"choices":[]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, chatBody('no usage here')),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    // No usage chunk -> settled with the estimate. Estimate now covers the
    // input size too: ceil(((11 input tokens + 500 max) * 800) / 1e6 * 100).
    expect((await fx.enforcer.getState(fx.scopeId)).spentCents).toBe(41);
  });

  it('returns 400 for a missing model and 404 JSON for unknown routes', async () => {
    const fx = await makeFixture(env.DB);
    const ctx = createExecutionContext();
    const noModel = await worker.fetch(
      chatRequest(fx.fullKey, { messages: [] }),
      fx.proxyEnv,
      ctx,
    );
    expect(noModel.status).toBe(400);
    const notFound = await worker.fetch(
      new Request(`${PROVIDER_ORIGIN}/v1/nope`, { headers: { authorization: `Bearer ${fx.fullKey}` } }),
      fx.proxyEnv,
      ctx,
    );
    expect(notFound.status).toBe(404);
    expect((await jsonBody(notFound)).error.code).toBe('not_found');
  });
});

describe('GET /v1/models', () => {
  it('lists models from the pricing table', async () => {
    const fx = await makeFixture(env.DB);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${PROVIDER_ORIGIN}/v1/models`), fx.proxyEnv, ctx);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('test-model-a');
    expect(ids).toContain('gemini-2.5-flash-lite');
  });
});

describe('scheduled', () => {
  it('refreshes the pricing cache from D1', async () => {
    const fx = await makeFixture(env.DB);
    const ctx = createExecutionContext();
    // Prime the cache.
    await worker.fetch(new Request(`${PROVIDER_ORIGIN}/v1/models`), fx.proxyEnv, ctx);
    // Add a model directly in D1; the cache should not see it yet.
    await env.DB.prepare(
      'INSERT OR REPLACE INTO pricing (model, input_per_1m, output_per_1m, updated_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind('brand-new-model', 1, 2, new Date().toISOString())
      .run();
    const before = await jsonBody(
      await worker.fetch(new Request(`${PROVIDER_ORIGIN}/v1/models`), fx.proxyEnv, ctx),
    );
    expect(before.data.map((m: { id: string }) => m.id)).not.toContain('brand-new-model');
    // Cron refresh -> visible.
    await worker.scheduled(createScheduledController({ cron: '0 0 * * *' }), fx.proxyEnv, ctx);
    const after = await jsonBody(
      await worker.fetch(new Request(`${PROVIDER_ORIGIN}/v1/models`), fx.proxyEnv, ctx),
    );
    expect(after.data.map((m: { id: string }) => m.id)).toContain('brand-new-model');
  });
});

describe('regression: review + adversarial fixes', () => {
  function okProvider() {
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(200, JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { 'content-type': 'application/json' } });
  }

  it('fix-3-dashboard-key-enforces-project-budget: $50 daily budget blocks an over-budget call with 402', async () => {
    // projectScopedBudget shapes the key exactly like the dashboard's
    // handleCreateKey: budget_scope_id = project_id.
    const fx = await makeFixture(env.DB, { projectScopedBudget: true, budgetCents: 5000 });
    const row = await env.DB.prepare('SELECT budget_scope_id AS b FROM api_keys WHERE key_hash = ?1')
      .bind(fx.keyHash)
      .first<{ b: string }>();
    expect(row?.b).toBe(fx.projectId);

    // No provider intercept: with disableNetConnect(), any provider call
    // would throw and surface as a 502, failing the 402 assertion.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, { ...chatBody('x'), max_tokens: 100_000 }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual({
      error: expect.objectContaining({ code: 'budget_exceeded' }),
    });
    await waitOnExecutionContext(ctx);
  });

  it('fix-6-estimate-covers-input: usage-less provider settles the input-aware estimate (>= $1)', async () => {
    const fx = await makeFixture(env.DB);
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(200, JSON.stringify({ choices: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, { ...chatBody('x'.repeat(200_000)), max_tokens: 16 }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    // No usage in the provider response -> settled with the estimate, which
    // must price ~50k input tokens, not just 16 output tokens.
    const spent = (await fx.enforcer.getState(fx.scopeId)).spentCents;
    expect(spent).toBeGreaterThanOrEqual(100); // >= ~$1.00, not pennies
  });

  it('fix-7-model-not-allowed: restricted key gets 403 and the provider is never called', async () => {
    const fx = await makeFixture(env.DB, { allowedModels: ['gemini-2.5-flash-lite'] });
    // No intercept registered on purpose: with disableNetConnect() active,
    // any provider call would throw inside the proxy and surface as a 502,
    // failing the 403 assertion below. A 403 here proves the provider was
    // never reached — and leaves no unconsumed interceptor behind for the
    // next test.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, { ...chatBody('x'), model: 'test-model-a' }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({
      error: expect.objectContaining({ code: 'model_not_allowed' }),
    });
    await waitOnExecutionContext(ctx);
  });

  it('fix-7-model-allowed: routed model inside the allow-list is admitted', async () => {
    const fx = await makeFixture(env.DB, { allowedModels: ['gemini-2.5-flash-lite'] });
    okProvider();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, { ...chatBody('x'), model: 'gemini-2.5-flash-lite' }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
  });

  it('fix-8-routed-model-header: frontier hint is clamped and reported, never silent', async () => {
    const fx = await makeFixture(env.DB);
    let capturedBody = '';
    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply((opts) => {
        capturedBody = String(opts.body ?? '');
        return {
          statusCode: 200,
          data: JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, { ...chatBody('x'), model: 'claude-opus-4.7' }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    // The default policy clamps frontier hints to the cheapest standard-tier
    // model, and the response says so explicitly.
    expect(res.headers.get('x-spendcap-routed-model')).toBe('claude-sonnet-4.5');
    expect(JSON.parse(capturedBody).model).toBe('claude-sonnet-4.5');
  });

  it('fix-11-task-truncated: 10KB x-spendcap-task is stored at <=128 chars in both tables', async () => {
    const fx = await makeFixture(env.DB);
    okProvider();
    const bigTask = 'T'.repeat(10_240);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, chatBody('x'), { 'x-spendcap-task': bigTask }),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    await fx.enforcer.flushBatch();
    const detail = await env.DB.prepare('SELECT task FROM usage_detail WHERE key_hash = ?1')
      .bind(fx.keyHash)
      .first<{ task: string }>();
    expect(detail?.task.length).toBeLessThanOrEqual(128);
    const daily = await env.DB.prepare('SELECT task FROM usage_daily WHERE key_hash = ?1')
      .bind(fx.keyHash)
      .first<{ task: string }>();
    expect(daily?.task.length).toBeLessThanOrEqual(128);
    expect(daily?.task).toBe('T'.repeat(128));
  });
});

describe('regression: quickstart e2e + error-path project binding', () => {
  it('fix-4-quickstart-e2e: dashboard-shaped key + project budget + provider key -> 200 with usage settled', async () => {
    // Mirrors the README quickstart: the key's budget_scope_id and org_id
    // are its project id (what POST /api/keys writes), the budget is on the
    // project scope (what POST /api/budgets writes), and the provider key is
    // stored for that org (what POST /api/provider-keys writes).
    const fx = await makeFixture(env.DB, { projectScopedBudget: true, budgetCents: 100000 });
    const keyOrg = await env.DB.prepare('SELECT org_id AS o FROM api_keys WHERE key_hash = ?1')
      .bind(fx.keyHash)
      .first<{ o: string }>();
    expect(keyOrg?.o).toBe(fx.projectId);

    fetchMock
      .get(PROVIDER_ORIGIN)
      .intercept({ method: 'POST', path: '/chat/completions' })
      .reply(200, JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      }), { headers: { 'content-type': 'application/json' } });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      chatRequest(fx.fullKey, chatBody('quickstart e2e')),
      fx.proxyEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    await fx.enforcer.flushBatch();

    // (1000*200 + 500*800)/1e6*100 = 60c settled against the project budget.
    expect((await fx.enforcer.getState(fx.projectId)).spentCents).toBe(60);
    const row = await env.DB.prepare(
      'SELECT project_id AS p, cost_cents AS c FROM usage_detail WHERE key_hash = ?1',
    )
      .bind(fx.keyHash)
      .first<{ p: string; c: number }>();
    expect(row).toEqual({ p: fx.projectId, c: 60 });
  });

  it('fix-18-error-paths-settle-real-project: no provider key -> 500, usage row carries the real project id', async () => {
    const fx = await makeFixture(env.DB, { withProviderKey: false });
    // No provider-key intercept and none in D1: the proxy settles the
    // reservation and 500s. The settle must carry the real project id from
    // the authorized key config — never ''.
    const ctx = createExecutionContext();
    const res = await worker.fetch(chatRequest(fx.fullKey, chatBody('x')), fx.proxyEnv, ctx);
    expect(res.status).toBe(500);
    expect((await jsonBody(res)).error.code).toBe('no_provider_key');
    await waitOnExecutionContext(ctx);
    await fx.enforcer.drainWrites();
    await fx.enforcer.flushBatch();
    const row = await env.DB.prepare(
      'SELECT project_id AS p, cost_cents AS c FROM usage_detail WHERE key_hash = ?1',
    )
      .bind(fx.keyHash)
      .first<{ p: string; c: number }>();
    expect(row?.p).toBe(fx.projectId);
    expect(row?.c).toBe(0);
  });
});
