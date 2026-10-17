// Spendcap self-host dashboard worker.
//
// Serves the JSON API under /api/* (admin token required on every route).
// The static UI in public/ is served by the [site] bucket in production, so
// non-API paths 404 here. Full key secrets are returned exactly once, at
// creation/rotation time; everything else only ever sees the hash.

import { generateKey } from '@tamtunnel/spendcap-auth';
import { encryptProviderKey } from '@tamtunnel/spendcap-proxy/providerKeys';
import type { BudgetEnforcer } from '@tamtunnel/spendcap-budget';

// Re-exported so the BUDGET_DO binding (script_name = this worker) can
// instantiate the class. The real implementation lives in the budget package.
export { BudgetEnforcer } from '@tamtunnel/spendcap-budget';

export interface DashboardEnv {
  BUDGET_DO: DurableObjectNamespace<BudgetEnforcer>;
  DB: D1Database;
  ADMIN_TOKEN: string;
  /**
   * Same secret as the proxy's PROVIDER_KEYS_SECRET (set on both workers):
   * derives the AES-GCM key that wraps provider_keys.enc_key. The
   * provider-keys route fails closed when it is unset.
   */
  PROVIDER_KEYS_SECRET: string;
}

/** Live budget state, per the BudgetEnforcer.getState contract. */
export interface BudgetLiveState {
  scopeId: string;
  period: string;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isAuthorized(request: Request, env: DashboardEnv): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false; // fail closed: no token configured, no access
  const header = (request.headers.get('authorization') ?? '').trim();
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const provided = match[1];
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The single warm BudgetEnforcer instance the proxy enforces against. */
function doStub(env: DashboardEnv) {
  return env.BUDGET_DO.get(env.BUDGET_DO.idFromName('gateway'));
}

/**
 * Best-effort DO invalidation after a key/budget change in D1. The D1 write
 * is the system of record and has already landed; a DO failure must not fail
 * the API call (the in-memory caches also expire via the DO's idle prune,
 * so this degrades gracefully instead of breaking incident response).
 */
async function tryDoRpc(
  env: DashboardEnv,
  what: string,
  fn: (stub: ReturnType<typeof doStub>) => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn(doStub(env));
  } catch (e) {
    console.error(`[spendcap] dashboard DO ${what} failed (D1 write already landed)`, e);
  }
}

async function handleOverview(env: DashboardEnv): Promise<Response> {
  const agg = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_cents), 0) AS totalCostCents,
            COALESCE(SUM(calls), 0) AS calls,
            COALESCE(SUM(CASE WHEN day = ?1 THEN cost_cents ELSE 0 END), 0) AS todayCostCents
     FROM usage_daily`,
  )
    .bind(todayUtc())
    .first<{ totalCostCents: number; calls: number; todayCostCents: number }>();
  const keys = await env.DB.prepare(
    'SELECT COUNT(*) AS activeKeys FROM api_keys WHERE revoked_at IS NULL',
  ).first<{ activeKeys: number }>();
  return json({
    totalCostCents: agg?.totalCostCents ?? 0,
    calls: agg?.calls ?? 0,
    todayCostCents: agg?.todayCostCents ?? 0,
    activeKeys: keys?.activeKeys ?? 0,
  });
}

const GROUP_BYS = ['key', 'model', 'task', 'day'] as const;
type GroupBy = (typeof GROUP_BYS)[number];

async function handleSpend(request: Request, env: DashboardEnv): Promise<Response> {
  const url = new URL(request.url);
  const groupBy = (url.searchParams.get('groupBy') ?? 'day') as GroupBy;
  if (!(GROUP_BYS as readonly string[]).includes(groupBy)) {
    return json({ error: `groupBy must be one of: ${GROUP_BYS.join(', ')}` }, 400);
  }
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') ?? '30', 10) || 30));
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffDay = cutoff.toISOString().slice(0, 10);

  let rows: unknown[] = [];
  if (groupBy === 'day') {
    const res = await env.DB.prepare(
      `SELECT day, SUM(calls) AS calls, SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens, SUM(cost_cents) AS costCents
       FROM usage_daily WHERE day >= ?1 GROUP BY day ORDER BY day ASC`,
    )
      .bind(cutoffDay)
      .all();
    rows = res.results ?? [];
  } else if (groupBy === 'model') {
    const res = await env.DB.prepare(
      `SELECT model, SUM(calls) AS calls, SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens, SUM(cost_cents) AS costCents
       FROM usage_daily WHERE day >= ?1 GROUP BY model ORDER BY costCents DESC`,
    )
      .bind(cutoffDay)
      .all();
    rows = res.results ?? [];
  } else if (groupBy === 'task') {
    const res = await env.DB.prepare(
      `SELECT task, SUM(calls) AS calls, SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens, SUM(cost_cents) AS costCents
       FROM usage_daily WHERE day >= ?1 GROUP BY task ORDER BY costCents DESC`,
    )
      .bind(cutoffDay)
      .all();
    rows = res.results ?? [];
  } else {
    const res = await env.DB.prepare(
      `SELECT ud.key_hash AS keyHash, ak.name AS keyName, ak.key_prefix AS keyPrefix,
              SUM(ud.calls) AS calls, SUM(ud.input_tokens) AS inputTokens,
              SUM(ud.output_tokens) AS outputTokens, SUM(ud.cost_cents) AS costCents
       FROM usage_daily ud LEFT JOIN api_keys ak ON ak.key_hash = ud.key_hash
       WHERE ud.day >= ?1 GROUP BY ud.key_hash ORDER BY costCents DESC`,
    )
      .bind(cutoffDay)
      .all();
    rows = res.results ?? [];
  }
  return json({ groupBy, days, rows });
}

interface BudgetRow {
  id: string;
  scopeType: string;
  scopeId: string;
  period: string;
  limitCents: number;
  createdAt: string;
}

async function handleBudgets(env: DashboardEnv): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT id, scope_type AS scopeType, scope_id AS scopeId, period,
            limit_cents AS limitCents, created_at AS createdAt
     FROM budgets ORDER BY created_at ASC`,
  ).all<BudgetRow>();
  const budgets: Array<BudgetRow & { live: BudgetLiveState | null }> = [];
  for (const b of res.results ?? []) {
    let live: BudgetLiveState | null = null;
    try {
      // Contract: single 'gateway' stub, getState(scopeId). (The shorthand in
      // the task, `idFromName('gateway').getState(scopeId)`, needs the .get()
      // hop on the real DurableObjectNamespace API.)
      const stub = env.BUDGET_DO.get(env.BUDGET_DO.idFromName('gateway'));
      live = await stub.getState(b.scopeId);
    } catch {
      // The DO is unreachable (or not implemented yet): still show the
      // definition; the UI marks live state as unavailable.
      live = null;
    }
    budgets.push({ ...b, live });
  }
  return json({ budgets });
}

interface KeyRow {
  keyHash: string;
  keyPrefix: string;
  name: string;
  projectId: string;
  env: string;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

async function handleListKeys(env: DashboardEnv): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT key_hash AS keyHash, key_prefix AS keyPrefix, name,
            project_id AS projectId, env, revoked_at AS revokedAt,
            created_at AS createdAt, last_used_at AS lastUsedAt
     FROM api_keys ORDER BY created_at DESC`,
  ).all<KeyRow>();
  // Never the full secret: it is not stored, only the hash.
  const keys = (res.results ?? []).map((k) => ({ ...k, revoked: k.revokedAt !== null }));
  return json({ keys });
}

interface CreateKeyBody {
  name?: unknown;
  projectId?: unknown;
  env?: unknown;
}

async function handleCreateKey(request: Request, env: DashboardEnv): Promise<Response> {
  let body: CreateKeyBody | null = null;
  try {
    body = (await request.json()) as CreateKeyBody | null;
  } catch {
    body = null;
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  const keyEnv = body?.env;
  if (!name || !projectId || (keyEnv !== 'live' && keyEnv !== 'test')) {
    return json({ error: 'body must include name (string), projectId (string), env ("live"|"test")' }, 400);
  }
  const { fullKey, keyHash, keyPrefix } = await generateKey(keyEnv);
  const createdAt = new Date().toISOString();
  // budget_scope_id defaults to the key's own project: budgets are
  // per-project (scopeType='project', scopeId=projectId), so a key enforces
  // its project's budgets out of the box instead of NULL (which enforces
  // nothing). org_id likewise defaults to the project id — the self-hosted
  // single-tenant model; the commercial multitenant package manages orgs
  // separately.
  await env.DB.prepare(
    `INSERT INTO api_keys (key_hash, org_id, project_id, key_prefix, name, env,
                           budget_scope_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(keyHash, projectId, projectId, keyPrefix, name, keyEnv, projectId, createdAt)
    .run();
  // The full secret is returned exactly once, here.
  return json({ key: fullKey, keyHash, keyPrefix, name, projectId, env: keyEnv, createdAt }, 201);
}

async function handleRevokeKey(keyHash: string, env: DashboardEnv): Promise<Response> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    'UPDATE api_keys SET revoked_at = ?1 WHERE key_hash = ?2 AND revoked_at IS NULL',
  )
    .bind(now, keyHash)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    return json({ error: 'key not found or already revoked' }, 404);
  }
  // Push the revocation into the warm DO immediately: without this, the
  // revoked key keeps authorizing from the DO's in-memory cache until
  // eviction.
  await tryDoRpc(env, 'invalidateKey', (stub) => stub.invalidateKey(keyHash));
  return json({ keyHash, revoked: true, revokedAt: now });
}

async function handleRotateKey(keyHash: string, env: DashboardEnv): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT key_hash AS keyHash, name, org_id AS orgId, project_id AS projectId,
            budget_scope_id AS budgetScopeId, env, revoked_at AS revokedAt
     FROM api_keys WHERE key_hash = ?1`,
  )
    .bind(keyHash)
    .first<{
      keyHash: string;
      name: string;
      orgId: string | null;
      projectId: string;
      budgetScopeId: string | null;
      env: string;
      revokedAt: string | null;
    }>();
  if (!row) return json({ error: 'key not found' }, 404);
  if (row.revokedAt) return json({ error: 'key is revoked; create a new key instead' }, 409);
  // Copy out before narrowing row.env below (it would narrow to never).
  const { name, projectId } = row;
  const rowEnv = row.env;
  if (rowEnv !== 'live' && rowEnv !== 'test') return json({ error: 'key has invalid env' }, 500);
  // The rotated key inherits the old key's org and budget scope (falling
  // back to the create-key defaults for rows written before those columns
  // were populated).
  const orgId = row.orgId ?? projectId;
  const budgetScopeId = row.budgetScopeId ?? projectId;

  const { fullKey, keyHash: newHash, keyPrefix } = await generateKey(rowEnv);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO api_keys (key_hash, org_id, project_id, key_prefix, name, env,
                             budget_scope_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(newHash, orgId, projectId, keyPrefix, name, rowEnv, budgetScopeId, now),
    env.DB.prepare('UPDATE api_keys SET revoked_at = ?1 WHERE key_hash = ?2').bind(now, keyHash),
  ]);
  // The old key must stop authorizing on the warm DO immediately.
  await tryDoRpc(env, 'invalidateKey', (stub) => stub.invalidateKey(keyHash));
  // The full secret is returned exactly once, here.
  return json(
    { key: fullKey, keyHash: newHash, keyPrefix, name, projectId, env: rowEnv, createdAt: now, rotatedFrom: keyHash },
    201,
  );
}

interface SetBudgetBody {
  scopeType?: unknown;
  scopeId?: unknown;
  period?: unknown;
  limitCents?: unknown;
}

/**
 * Create or replace a budget. v1 model decision: budgets are per-project
 * (scopeType must be 'project', scopeId is the project id — the same value
 * a key's budget_scope_id defaults to at creation). The upsert needs the
 * 0004 unique index on (scope_id, period); after the write the warm DO
 * reloads the scope's definitions via reloadScope() so the new limit
 * enforces immediately.
 */
async function handleSetBudget(request: Request, env: DashboardEnv): Promise<Response> {
  let body: SetBudgetBody | null = null;
  try {
    body = (await request.json()) as SetBudgetBody | null;
  } catch {
    body = null;
  }
  const scopeType = body?.scopeType;
  const scopeId = typeof body?.scopeId === 'string' ? body.scopeId.trim() : '';
  const period = body?.period;
  const limitCents = body?.limitCents;
  if (scopeType !== 'project' || !scopeId) {
    return json({ error: 'body must include scopeType ("project") and scopeId (string)' }, 400);
  }
  if (period !== 'daily' && period !== 'monthly') {
    return json({ error: 'period must be "daily" or "monthly"' }, 400);
  }
  if (typeof limitCents !== 'number' || !Number.isInteger(limitCents) || limitCents <= 0) {
    return json({ error: 'limitCents must be a positive integer' }, 400);
  }
  const id = `${scopeType}:${scopeId}:${period}`;
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(scope_id, period) DO UPDATE SET
       scope_type = excluded.scope_type,
       limit_cents = excluded.limit_cents`,
  )
    .bind(id, scopeType, scopeId, period, limitCents, createdAt)
    .run();
  // Push the new limit into the warm DO immediately; otherwise the old
  // limit keeps enforcing from the DO's in-memory definitions.
  await tryDoRpc(env, 'reloadScope', (stub) => stub.reloadScope(scopeId));
  return json({ ok: true, budget: { id, scopeType, scopeId, period, limitCents } });
}

interface PatchKeyBody {
  name?: unknown;
  budgetScopeId?: unknown;
}

/**
 * Minimal key update for future UI use: rename, and/or re-point the key's
 * budget scope. A budget-scope change invalidates the DO's cached key config
 * so the next authorize picks up the new scope.
 */
async function handlePatchKey(
  keyHash: string,
  request: Request,
  env: DashboardEnv,
): Promise<Response> {
  let body: PatchKeyBody | null = null;
  try {
    body = (await request.json()) as PatchKeyBody | null;
  } catch {
    body = null;
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  let scopeChanged = false;
  if (body?.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return json({ error: 'name must be a non-empty string' }, 400);
    }
    sets.push('name = ?');
    params.push(body.name.trim());
  }
  if (body?.budgetScopeId !== undefined) {
    if (typeof body.budgetScopeId !== 'string' || body.budgetScopeId.trim() === '') {
      return json({ error: 'budgetScopeId must be a non-empty string' }, 400);
    }
    sets.push('budget_scope_id = ?');
    params.push(body.budgetScopeId.trim());
    scopeChanged = true;
  }
  if (sets.length === 0) {
    return json({ error: 'body must include at least one of: name, budgetScopeId' }, 400);
  }
  params.push(keyHash);
  const res = await env.DB.prepare(
    `UPDATE api_keys SET ${sets.join(', ')} WHERE key_hash = ?`,
  )
    .bind(...params)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    return json({ error: 'key not found' }, 404);
  }
  if (scopeChanged) {
    await tryDoRpc(env, 'invalidateKey', (stub) => stub.invalidateKey(keyHash));
  }
  return json({ ok: true, keyHash });
}

interface SetProviderKeyBody {
  orgId?: unknown;
  provider?: unknown;
  key?: unknown;
}

/**
 * Store (or replace) an org's provider key. The secret is AES-GCM-wrapped
 * with PROVIDER_KEYS_SECRET before it touches D1; the plaintext never
 * persists. Fails closed when the secret is unset — encryptProviderKey
 * throws rather than deriving a key from empty input.
 */
async function handleSetProviderKey(request: Request, env: DashboardEnv): Promise<Response> {
  let body: SetProviderKeyBody | null = null;
  try {
    body = (await request.json()) as SetProviderKeyBody | null;
  } catch {
    body = null;
  }
  const orgId = typeof body?.orgId === 'string' ? body.orgId.trim() : '';
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
  const key = typeof body?.key === 'string' ? body.key : '';
  if (!orgId || !provider || !key) {
    return json({ error: 'body must include orgId, provider, and key (all non-empty strings)' }, 400);
  }
  let encKey: string;
  try {
    encKey = await encryptProviderKey(key, env.PROVIDER_KEYS_SECRET);
  } catch (e) {
    return json(
      { error: `could not encrypt provider key: ${e instanceof Error ? e.message : String(e)}` },
      500,
    );
  }
  const id = `pk_${orgId}_${provider}`;
  const createdAt = new Date().toISOString();
  // One active key per (org, provider): replace any existing row.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM provider_keys WHERE org_id = ?1 AND provider = ?2').bind(
      orgId,
      provider,
    ),
    env.DB.prepare(
      'INSERT INTO provider_keys (id, org_id, provider, enc_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(id, orgId, provider, encKey, createdAt),
  ]);
  return json({ ok: true, orgId, provider });
}

export default {
  async fetch(request: Request, env: DashboardEnv, _ctx: ExecutionContext): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return json({ error: 'unauthorized' }, 401);
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'GET' && path === '/api/overview') return handleOverview(env);
    if (method === 'GET' && path === '/api/spend') return handleSpend(request, env);
    if (method === 'GET' && path === '/api/budgets') return handleBudgets(env);
    if (method === 'POST' && path === '/api/budgets') return handleSetBudget(request, env);
    if (method === 'POST' && path === '/api/provider-keys')
      return handleSetProviderKey(request, env);
    if (method === 'GET' && path === '/api/keys') return handleListKeys(env);
    if (method === 'POST' && path === '/api/keys') return handleCreateKey(request, env);

    const keyPatch = /^\/api\/keys\/([^/]+)$/.exec(path);
    if (keyPatch && method === 'PATCH') {
      return handlePatchKey(keyPatch[1], request, env);
    }

    const keyAction = /^\/api\/keys\/([^/]+)\/(revoke|rotate)$/.exec(path);
    if (keyAction && method === 'POST') {
      const [, hash, action] = keyAction;
      if (action === 'revoke') return handleRevokeKey(hash, env);
      return handleRotateKey(hash, env);
    }

    return json({ error: 'not found' }, 404);
  },
};
