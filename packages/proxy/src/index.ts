// Spendcap enforcement proxy (Worker).
//
// POST /v1/chat/completions: Bearer sc_live_/sc_test_ -> parse + hash -> the
// budget Durable Object atomically checks and reserves the estimated cost.
// NOTHING reaches the provider without a reservation (reservation-or-nothing).
// On success the request is routed (deterministic tiers), forwarded to the
// org's provider key (AES-GCM envelope in D1), and the provider response is
// streamed back through a TransformStream that sniffs `usage` (SSE final
// chunk or JSON body) without buffering the client stream. Settlement happens
// in ctx.waitUntil() once usage is known; aborted streams settle with the
// estimate.
//
// Privacy: prompt/response bodies are streamed through memory only and are
// never written to D1, DO storage, or logs. Only token counts, cost, model,
// task label, and the key hash are persisted.
//
// GET /v1/models: model list from the pricing table (no auth required).
// scheduled: refresh the module-level pricing cache from D1 daily.

import { parseKey, hashKey } from '@tamtunnel/spendcap-auth';
import {
  estimateCostCents,
  actualCostCents,
  getPricing,
  type PricingTable,
} from '@tamtunnel/spendcap-data';
import { routeRequest, type RoutingPolicy } from '@tamtunnel/spendcap-arbitrage';
import { decryptProviderKey } from './providerKeys.js';
import type { Env } from './types.js';
import type { SettleInput } from '../../budget/src/types.js';

// Re-exported so the BUDGET_DO binding (same-script class binding) can
// instantiate the class. Imported from source (not the built package) so
// the class identity matches what tests import.
export { BudgetEnforcer } from '../../budget/src/enforcer.js';

/** Test seam: reset module state between workers-pool tests (same isolate). */
export const __proxyTestHooks = {
  resetPricingCache(): void {
    pricingCache = null;
  },
};

// -- pricing cache ----------------------------------------------------------

let pricingCache: { table: PricingTable; loadedAt: number } | null = null;

async function getPricingTable(db: D1Database): Promise<PricingTable> {
  if (!pricingCache) {
    pricingCache = { table: await getPricing(db), loadedAt: Date.now() };
  }
  return pricingCache.table;
}

// -- cost math ----------------------------------------------------------------

/** Conservative fallback when the model is absent from the pricing table. */
const FALLBACK_OUTPUT_PER_1M_CENTS = 1000; // ~$10 / 1M output tokens

function estimateCents(
  model: string,
  body: Record<string, unknown>,
  pricing: PricingTable,
): number {
  // max_completion_tokens is the newer OpenAI name; max_tokens the classic
  // one. Default 1024 matches the old behavior.
  const rawMax =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) && body.max_tokens > 0
      ? body.max_tokens
      : typeof body.max_completion_tokens === 'number' &&
          Number.isFinite(body.max_completion_tokens) &&
          body.max_completion_tokens > 0
        ? body.max_completion_tokens
        : 1024;
  const maxTokens = Math.floor(rawMax);
  // Rough input-token estimate from the request size (~4 chars/token). A
  // 200k-token prompt with max_tokens:16 must reserve ~$1 of input, not the
  // pennies that output-only math would reserve.
  let estInputTokens = 0;
  try {
    estInputTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  } catch {
    estInputTokens = 0;
  }
  try {
    return estimateCostCents(model, maxTokens, estInputTokens, pricing);
  } catch {
    return Math.max(
      1,
      Math.ceil(((estInputTokens + maxTokens) * FALLBACK_OUTPUT_PER_1M_CENTS) / 1_000_000),
    );
  }
}

function actualCents(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricing: PricingTable,
  fallbackCents: number,
): number {
  try {
    return actualCostCents(inputTokens, outputTokens, model, pricing);
  } catch {
    return fallbackCents;
  }
}

// -- routing ------------------------------------------------------------------

/**
 * MVP default policy: deterministic auto tiers, capped at standard.
 *
 * Explicit and honest about the clamp: a priced hint at or below the
 * standard tier is honored; a frontier hint (e.g. claude-opus-4.7) is
 * clamped to the cheapest standard-tier model (currently claude-sonnet-4.5)
 * rather than served as-is. The actual model is always reported back in
 * the `x-spendcap-routed-model` response header, so the substitution is
 * visible, never silent. Unknown hints fall back to the cheapest cheap
 * model (handled inside routeRequest).
 */
const DEFAULT_POLICY: RoutingPolicy = { mode: 'auto', maxAutoTier: 'standard' };

function routeModel(
  modelHint: string,
  maxTokens: number,
  hasTools: boolean,
  pricing: PricingTable,
): string {
  try {
    return routeRequest({ modelHint, maxTokens, hasTools, policy: DEFAULT_POLICY, pricing }).model;
  } catch {
    return modelHint;
  }
}

// -- responses ------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const err = (code: string, message: string) => ({ error: { code, message } });

function denyStatus(code: string): number {
  switch (code) {
    case 'budget_exceeded':
      return 402;
    case 'key_not_found':
      // Revoked keys intentionally return the identical code+message as
      // unknown keys (no key enumeration).
      return 401;
    case 'model_not_allowed':
      return 403;
    case 'rate_limited':
    case 'key_paused':
      return 429;
    default:
      return 500;
  }
}

// -- usage sniffing ---------------------------------------------------------------

interface SniffedUsage {
  inputTokens: number;
  outputTokens: number;
  actualCostCents: number;
}

function usageFromObject(obj: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const usage = (obj as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  if (typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return null;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
}

/**
 * Pipe a provider response to the client while sniffing token usage.
 *
 * Client bytes are forwarded chunk-by-chunk (no client-side buffering);
 * usage is parsed incrementally from SSE `data:` lines or, for non-stream
 * JSON, from the accumulated body at end-of-stream. Bodies live in memory
 * only and are never persisted anywhere. Resolves with the sniffed usage
 * (or null when the stream aborted / carried no usage).
 */
export function forwardWithUsageSniffing(
  providerRes: Response,
): { response: Response; usage: Promise<{ inputTokens: number; outputTokens: number } | null> } {
  const isSSE = (providerRes.headers.get('content-type') ?? '').includes('text/event-stream');
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  const usage = (async () => {
    const writer = writable.getWriter();
    const reader = providerRes.body!.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    const jsonChunks: Uint8Array[] = [];
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // NOTE: writer.write() transfers (detaches) the chunk's ArrayBuffer,
        // so all sniffing/copying must happen BEFORE the write.
        if (isSSE) {
          lineBuf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '' || payload === '[DONE]') continue;
            try {
              const found = usageFromObject(JSON.parse(payload));
              if (found) lastUsage = found;
            } catch {
              // Non-JSON data line (e.g. a comment keep-alive); ignore.
            }
          }
        } else {
          jsonChunks.push(value.slice());
        }
        await writer.write(value);
      }
      await writer.close();
      if (isSSE) return lastUsage;
      try {
        const total = jsonChunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of jsonChunks) {
          merged.set(c, off);
          off += c.length;
        }
        return usageFromObject(JSON.parse(decoder.decode(merged)));
      } catch {
        return null;
      }
    } catch {
      // Stream aborted mid-flight: signal "no usage" so the caller settles
      // with the estimate.
      try {
        await writer.abort();
      } catch {
        // ignore
      }
      return null;
    }
  })();

  const headers = new Headers();
  const ct = providerRes.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  const response = new Response(readable, { status: providerRes.status, headers });
  return { response, usage };
}

// -- handlers ---------------------------------------------------------------------

async function chatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Authenticate: Bearer sc_live_/sc_test_ -> parse (strict) -> hash.
  const authHeader = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+?)\s*$/.exec(authHeader)?.[1];
  if (!bearer) return json(401, err('invalid_key', 'missing or malformed Authorization header'));
  try {
    parseKey(bearer);
  } catch {
    return json(401, err('invalid_key', 'malformed API key'));
  }
  const keyHash = await hashKey(bearer);

  // 2. Parse the OpenAI-compatible body.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, err('invalid_body', 'request body must be JSON'));
  }
  const modelHint = typeof body.model === 'string' && body.model !== '' ? body.model : null;
  if (!modelHint) return json(400, err('invalid_body', 'missing "model"'));
  const maxTokens =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) && body.max_tokens > 0
      ? Math.floor(body.max_tokens)
      : typeof body.max_completion_tokens === 'number' &&
          Number.isFinite(body.max_completion_tokens) &&
          body.max_completion_tokens > 0
        ? Math.floor(body.max_completion_tokens)
        : 1024;
  const stream = body.stream === true;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  // The task label is attacker-controlled and part of the usage_daily unique
  // key: truncate to 128 chars before it leaves the proxy so it can neither
  // bloat D1 rows nor blow up key cardinality. (Documented limit.)
  const task = [...(request.headers.get('x-spendcap-task') ?? '')].slice(0, 128).join('');

  // 3. Route deterministically FIRST (pure function, no I/O). The enforcer
  //    never routes — it only checks the routed model against the key's
  //    allow-list, so routing must happen before authorize-and-reserve.
  const pricing = await getPricingTable(env.DB);
  const routedModel = routeModel(modelHint, maxTokens, hasTools, pricing);

  // 4. Estimate + authorize-and-reserve. Nothing reaches the provider without
  //    a reservation. The estimate covers estimated input size (from the
  //    request body) at the higher of input/output rates plus the full
  //    maxTokens budget as output.
  const estCents = estimateCents(routedModel, body, pricing);
  const stub = env.BUDGET_DO.get(env.BUDGET_DO.idFromName('gateway'));
  let authz: Awaited<ReturnType<typeof stub.authorizeAndReserve>>;
  try {
    authz = await stub.authorizeAndReserve({
      keyHash,
      estCostCents: estCents,
      task,
      modelHint,
      routedModel,
    });
  } catch (e) {
    console.error('[spendcap] authorizeAndReserve threw', e);
    return json(500, err('authorizer_error', 'budget service unavailable'));
  }
  if (!authz.ok) {
    return json(denyStatus(authz.code), err(authz.code, authz.message));
  }
  // NOTE (TOCTOU, documented limitation): a revoke/rotate that lands after
  // this authorize but before the provider fetch does NOT stop this
  // in-flight request — the reservation was legitimately issued and the
  // provider call settles against it. F1's dashboard→DO invalidateKey()
  // narrows the window to requests authorized *after* the revoke; closing it
  // entirely would require re-checking inside the fetch path, which the
  // reservation model deliberately avoids (the reservation IS the grant).
  const reservationId = authz.reservationId;
  // The project id comes from the key config the DO just authorized (not
  // from a second D1 read): every settle below — including every error
  // path — carries the real project id, never ''.
  const projectId = authz.projectId;

  /** Settle the reservation without ever failing the response path. */
  const settleQuietly = async (
    s: Omit<SettleInput, 'reservationId' | 'task' | 'keyHash' | 'projectId'>,
  ) => {
    try {
      await stub.settle({ reservationId, task, keyHash, projectId, ...s });
    } catch (e) {
      // Reservation already gone/expired, or validation rejected the
      // values: log, never crash the response path.
      console.error('[spendcap] settle failed', e);
    }
  };

  // 5. Load the org's provider key (AES-GCM envelope in D1).
  const keyRow = await env.DB.prepare('SELECT org_id FROM api_keys WHERE key_hash = ?1')
    .bind(keyHash)
    .first<{ org_id: string }>();
  if (!keyRow) {
    // Should not happen: the DO just authorized this key hash.
    await settleQuietly({ actualCostCents: 0, inputTokens: 0, outputTokens: 0, model: routedModel });
    return json(500, err('authorizer_error', 'key record disappeared mid-request'));
  }
  const pkRow = await env.DB.prepare('SELECT enc_key FROM provider_keys WHERE org_id = ?1 LIMIT 1')
    .bind(keyRow.org_id)
    .first<{ enc_key: string }>();
  if (!pkRow?.enc_key) {
    await settleQuietly({
      actualCostCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: routedModel,
    });
    return json(500, err('no_provider_key', 'no provider key configured for this organization'));
  }
  let providerKey: string;
  try {
    providerKey = await decryptProviderKey(pkRow.enc_key, env.PROVIDER_KEYS_SECRET);
  } catch {
    await settleQuietly({
      actualCostCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: routedModel,
    });
    return json(500, err('provider_key_error', 'could not decrypt provider key'));
  }

  // 6. Forward to the provider (OpenAI-compatible).
  const outBody: Record<string, unknown> = { ...body, model: routedModel };
  if (stream) {
    const existing =
      typeof body.stream_options === 'object' && body.stream_options !== null
        ? (body.stream_options as Record<string, unknown>)
        : {};
    outBody.stream_options = { ...existing, include_usage: true };
  }
  const baseUrl = env.DEFAULT_PROVIDER_BASE_URL.replace(/\/+$/, '');
  let providerRes: Response;
  try {
    providerRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${providerKey}`,
      },
      body: JSON.stringify(outBody),
    });
  } catch (e) {
    console.error('[spendcap] provider fetch failed', e);
    await settleQuietly({
      actualCostCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: routedModel,
    });
    return json(502, err('provider_unreachable', 'provider request failed'));
  }

  const settleBase = { model: routedModel };

  // 7. Provider error: release the reservation, pass the error through.
  if (!providerRes.ok || !providerRes.body) {
    ctx.waitUntil(
      settleQuietly({ actualCostCents: 0, inputTokens: 0, outputTokens: 0, ...settleBase }),
    );
    const headers = new Headers();
    const ct = providerRes.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    return new Response(providerRes.body, { status: providerRes.status, headers });
  }

  // 8. Stream back to the client, sniff usage, settle in the background.
  const { response, usage } = forwardWithUsageSniffing(providerRes);
  // No silent substitution: the client always learns which model actually
  // served the request (the default policy clamps frontier hints to the
  // cheapest standard-tier model — see DEFAULT_POLICY).
  response.headers.set('x-spendcap-routed-model', routedModel);
  ctx.waitUntil(
    usage.then((u) => {
      const sniffed: SniffedUsage = u
        ? {
            ...u,
            actualCostCents: actualCents(u.inputTokens, u.outputTokens, routedModel, pricing, estCents),
          }
        : { inputTokens: 0, outputTokens: 0, actualCostCents: estCents };
      return settleQuietly({ ...sniffed, ...settleBase });
    }),
  );
  return response;
}

async function listModels(env: Env): Promise<Response> {
  const pricing = await getPricingTable(env.DB);
  return json(200, { data: Object.keys(pricing).map((id) => ({ id })) });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return chatCompletions(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return listModels(env);
    }
    return json(404, err('not_found', 'not found'));
  },

  /** Cron: refresh the module-level pricing cache from D1 (daily). */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    pricingCache = { table: await getPricing(env.DB), loadedAt: Date.now() };
  },
};
