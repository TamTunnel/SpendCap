// BudgetEnforcer: the single Durable Object that makes budgets actually block.
//
// One instance (idFromName('gateway')) serializes every authorize/settle call,
// so the check-and-reserve below is atomic: the budget check and the spend
// mutation happen in one synchronous section with no awaits between them.
//
// Durability model:
//   - api_keys / budgets / pricing live in D1 (source of truth for config).
//   - Live spend counters live in memory for speed AND in DO storage
//     (`budget:<scopeId>:<period>` -> {spentCents, periodStart}) so a cold
//     start or eviction resumes counters instead of resetting them.
//   - Settled usage rows are batched in memory and flushed to D1 via
//     flushUsageBatch() every 50 rows or 30s (alarm). Flush failures retry
//     with backoff; rows are never silently dropped — the DO-storage counter
//     `detail_rows_delayed` tracks anything still pending.
//
// Privacy: only key hashes are stored/compared (constant-time compare).
// Prompt/response bodies never enter this object — settle() takes token
// counts and cost only.

import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqualHex } from '@tamtunnel/spendcap-auth';
import { flushUsageBatch, type UsageRecord } from '@tamtunnel/spendcap-data';
import { detectAnomaly, type SpendEvent } from '@tamtunnel/spendcap-guardrails';
import type { AuthorizeInput, AuthorizeResult, BudgetEnv, SettleInput } from './types.js';

interface KeyConfig {
  orgId: string;
  projectId: string;
  env: string;
  budgetScopeId: string | null;
  allowedModels: string[] | null;
  rateLimitPerMin: number | null;
  revokedAt: string | null;
}

interface BudgetState {
  scopeId: string;
  period: 'daily' | 'monthly';
  limitCents: number;
  spentCents: number;
  periodStart: number;
}

interface Reservation {
  keyHash: string;
  projectId: string;
  /** Composite budget keys (`<scopeId>:<period>`) this reservation holds against. */
  scopeKeys: string[];
  estCents: number;
  t: number;
}

const RESERVATION_TTL_MS = 5 * 60_000;
const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 30_000;
const PAUSE_TTL_MS = 15 * 60_000;
/**
 * Cached key configs are re-read from D1 after this long, so a revoke or
 * config change takes effect even if the dashboard's best-effort
 * invalidateKey RPC is lost AND the key stays active (active keys never go
 * idle, so the idle prune alone can't clear them).
 */
const KEY_CACHE_TTL_MS = 5 * 60_000;
/** Per-key ephemeral state (rate windows, spend events, pause, config cache, last-seen) for keys idle longer than this is dropped. */
const INACTIVE_PRUNE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** Rolling 30-day month. Calendar-month alignment is a documented future step. */
const MONTH_MS = 30 * DAY_MS;
const MAX_SPEND_EVENTS = 200;
const VELOCITY_WINDOW_SEC = 600;
const VELOCITY_BASELINE_MULT = 4;

/**
 * Test seam. Same-isolate only (workers-pool tests import this module, so the
 * hooks affect the DO instances under test). No-op in production.
 */
export const __budgetTestHooks = {
  now: null as null | (() => number),
  flushRetryDelaysMs: [1000, 2000, 4000],
};

function now(): number {
  return __budgetTestHooks.now?.() ?? Date.now();
}

function scopeKey(scopeId: string, period: string): string {
  return `${scopeId}:${period}`;
}

function periodMs(period: 'daily' | 'monthly'): number {
  return period === 'daily' ? DAY_MS : MONTH_MS;
}

/**
 * The enforcement logic as a plain class: constructed with an explicit
 * state/env pair so tests can drive it without a real DurableObjectState
 * (workerd refuses to construct DurableObject subclasses with a fake ctx).
 * Production serving goes through {@link BudgetEnforcer} below, a thin
 * DurableObject adapter over this core. All budget logic lives here.
 */
export class BudgetEnforcerCore {
  /** keyHash -> config. Looked up with timingSafeEqualHex, loaded from D1 on miss. */
  private keys = new Map<string, KeyConfig>();
  /** keyHash -> timestamp (ms) when the config was cached; bounds staleness (see KEY_CACHE_TTL_MS). */
  private keyCachedAt = new Map<string, number>();
  /** `<scopeId>:<period>` -> live budget state. */
  private budgets = new Map<string, BudgetState>();
  /** scopeIds whose budgets rows have been seeded from D1. */
  private budgetsLoaded = new Set<string>();
  private reservations = new Map<string, Reservation>();
  /** keyHash -> authorize timestamps (ms), sliding 60s window. */
  private rateWindows = new Map<string, number[]>();
  /** keyHash -> recent spend events for velocity checks (ring buffer). */
  private spendEvents = new Map<string, SpendEvent[]>();
  /** keyHash -> timestamp until which the key is paused. */
  private pausedUntil = new Map<string, number>();
  /** keyHash -> last authorize timestamp (ms); drives the idle prune below. */
  private lastSeen = new Map<string, number>();
  private usageBatch: UsageRecord[] = [];
  /**
   * Background persistence promises (DO-storage writes, usage flushes)
   * handed to ctx.waitUntil(). Tracked so tests can drain them; production
   * behavior is unchanged (fire-and-forget with the DO kept alive).
   */
  private pendingWrites = new Set<Promise<unknown>>();

  constructor(
    private ctx: DurableObjectState,
    private env: BudgetEnv,
  ) {}

  /** Hand a background promise to waitUntil AND track it for drainWrites(). */
  private background(p: Promise<unknown>): void {
    this.pendingWrites.add(p);
    p.then(
      () => this.pendingWrites.delete(p),
      () => this.pendingWrites.delete(p),
    );
    this.ctx.waitUntil(p);
  }

  /**
   * Wait for all in-flight background persistence. Used by tests to quiesce
   * the DO before assertions/teardown; harmless in production.
   */
  async drainWrites(): Promise<void> {
    await Promise.all([...this.pendingWrites]);
  }

  // -- loading -----------------------------------------------------------

  /** Timing-safe in-memory lookup, falling back to D1 on a miss or stale entry. */
  private async ensureKey(keyHash: string): Promise<KeyConfig | null> {
    const t = now();
    for (const [stored, cfg] of this.keys) {
      if (timingSafeEqualHex(stored, keyHash)) {
        // Bound cache staleness: re-read from D1 if the entry is older than
        // KEY_CACHE_TTL_MS, so revokes/config changes land even when the
        // dashboard's best-effort invalidateKey RPC is lost on an active key.
        if (t - (this.keyCachedAt.get(stored) ?? 0) < KEY_CACHE_TTL_MS) return cfg;
        this.keys.delete(stored);
        this.keyCachedAt.delete(stored);
        break;
      }
    }
    const row = await this.env.DB.prepare(
      `SELECT org_id, project_id, env, budget_scope_id, allowed_models,
              rate_limit_per_min, revoked_at
         FROM api_keys WHERE key_hash = ?1`,
    )
      .bind(keyHash)
      .first<{
        org_id: string;
        project_id: string;
        env: string;
        budget_scope_id: string | null;
        allowed_models: string | null;
        rate_limit_per_min: number | null;
        revoked_at: string | null;
      }>();
    if (!row) return null;
    let allowedModels: string[] | null = null;
    if (row.allowed_models) {
      try {
        const parsed: unknown = JSON.parse(row.allowed_models);
        allowedModels = Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : null;
      } catch {
        allowedModels = null;
      }
    }
    const cfg: KeyConfig = {
      orgId: row.org_id,
      projectId: row.project_id,
      env: row.env,
      budgetScopeId: row.budget_scope_id,
      allowedModels,
      rateLimitPerMin: row.rate_limit_per_min,
      revokedAt: row.revoked_at,
    };
    this.keys.set(keyHash, cfg);
    this.keyCachedAt.set(keyHash, now());
    return cfg;
  }

  /** Seed budget states for a scope from D1 `budgets` + persisted DO-storage counters. */
  private async ensureBudgets(scopeId: string): Promise<BudgetState[]> {
    if (!this.budgetsLoaded.has(scopeId)) {
      const res = await this.env.DB.prepare(
        `SELECT period, limit_cents FROM budgets WHERE scope_id = ?1`,
      )
        .bind(scopeId)
        .all<{ period: string; limit_cents: number }>();
      const t = now();
      for (const row of res.results ?? []) {
        if (row.period !== 'daily' && row.period !== 'monthly') continue;
        const key = scopeKey(scopeId, row.period);
        const persisted = await this.ctx.storage.get<{ spentCents: number; periodStart: number }>(
          `budget:${key}`,
        );
        this.budgets.set(key, {
          scopeId,
          period: row.period,
          limitCents: row.limit_cents,
          spentCents: persisted?.spentCents ?? 0,
          periodStart: persisted?.periodStart ?? t,
        });
      }
      this.budgetsLoaded.add(scopeId);
    }
    const out: BudgetState[] = [];
    for (const b of this.budgets.values()) {
      if (b.scopeId === scopeId) out.push(b);
    }
    return out;
  }

  private maybeRollover(b: BudgetState, t: number): void {
    if (t - b.periodStart >= periodMs(b.period)) {
      b.spentCents = 0;
      b.periodStart = t;
      this.background(this.persistBudget(b));
    }
  }

  private async persistBudget(b: BudgetState): Promise<void> {
    await this.ctx.storage.put(`budget:${scopeKey(b.scopeId, b.period)}`, {
      spentCents: b.spentCents,
      periodStart: b.periodStart,
    });
  }

  /** Drop reservations older than the TTL. Estimates stay in spentCents (conservative: never auto-refund). */
  private sweepReservations(t: number): void {
    for (const [id, r] of this.reservations) {
      if (t - r.t > RESERVATION_TTL_MS) this.reservations.delete(id);
    }
  }

  /**
   * Lazy memory bound: drop per-key ephemeral state (rate windows, spend
   * events, pause timers, cached key configs, last-seen markers) for keys
   * idle longer than INACTIVE_PRUNE_MS. Runs at the top of authorize, so a
   * fleet churning through keys cannot grow these maps without bound. The
   * key config cache is safe to drop: the next authorize reloads it from D1.
   */
  private pruneInactiveKeys(t: number): void {
    const cutoff = t - INACTIVE_PRUNE_MS;
    for (const [keyHash, last] of this.lastSeen) {
      if (last < cutoff) {
        this.lastSeen.delete(keyHash);
        this.rateWindows.delete(keyHash);
        this.spendEvents.delete(keyHash);
        this.pausedUntil.delete(keyHash);
        // Key config cache: drop via timing-safe scan (keys are compared
        // with timingSafeEqualHex on lookup, so scan the same way here).
        for (const stored of this.keys.keys()) {
          if (timingSafeEqualHex(stored, keyHash)) {
            this.keys.delete(stored);
            this.keyCachedAt.delete(stored);
          }
        }
      }
    }
  }

  /**
   * Test seam: sizes of the per-key in-memory maps. Lets regression tests
   * assert the idle prune actually bounds memory.
   */
  debugKeyMapSizes(): {
    keys: number;
    rateWindows: number;
    spendEvents: number;
    pausedUntil: number;
    lastSeen: number;
  } {
    return {
      keys: this.keys.size,
      rateWindows: this.rateWindows.size,
      spendEvents: this.spendEvents.size,
      pausedUntil: this.pausedUntil.size,
      lastSeen: this.lastSeen.size,
    };
  }

  // -- authorize ----------------------------------------------------------

  async authorizeAndReserve(input: AuthorizeInput): Promise<AuthorizeResult> {
    const t = now();
    this.sweepReservations(t);
    this.pruneInactiveKeys(t);

    const cfg = await this.ensureKey(input.keyHash);
    if (!cfg) {
      return { ok: false, code: 'key_not_found', message: 'unknown API key' };
    }
    if (cfg.revokedAt) {
      // Deliberately identical to key_not_found: a distinct "revoked" code
      // lets anyone probe which hashes were once valid keys.
      return { ok: false, code: 'key_not_found', message: 'unknown API key' };
    }

    // Per-key model allow-list. The proxy routes first (pure function) and
    // passes the routed model in; the enforcer only enforces.
    if (
      cfg.allowedModels !== null &&
      input.routedModel !== undefined &&
      !cfg.allowedModels.includes(input.routedModel)
    ) {
      return {
        ok: false,
        code: 'model_not_allowed',
        message: `model "${input.routedModel}" is not allowed for this key`,
      };
    }

    // Past every config-based denial (unknown/revoked/disallowed key): mark
    // the key seen so the idle prune keeps genuinely active keys. Set before
    // the pause/rate-limit/budget checks — a key hammering a blown budget or
    // a rate limit is active, not idle. Unknown hashes never reach here, so
    // attackers cannot stuff this map with garbage.
    this.lastSeen.set(input.keyHash, t);

    const paused = this.pausedUntil.get(input.keyHash);
    if (paused !== undefined) {
      if (paused > t) {
        return {
          ok: false,
          code: 'key_paused',
          message: 'API key temporarily paused after anomalous spend',
        };
      }
      this.pausedUntil.delete(input.keyHash);
    }

    if (cfg.rateLimitPerMin !== null && cfg.rateLimitPerMin !== undefined) {
      const window = (this.rateWindows.get(input.keyHash) ?? []).filter((ts) => ts > t - 60_000);
      if (window.length >= cfg.rateLimitPerMin) {
        this.rateWindows.set(input.keyHash, window);
        return { ok: false, code: 'rate_limited', message: 'per-minute rate limit exceeded' };
      }
      window.push(t);
      this.rateWindows.set(input.keyHash, window);
    }

    // All async loading happens BEFORE the atomic section below.
    const budgets = cfg.budgetScopeId ? await this.ensureBudgets(cfg.budgetScopeId) : [];
    for (const b of budgets) this.maybeRollover(b, t);

    // Defense in depth (mirrors settle's validation): a NaN/Infinite
    // estimate would poison the budget counter permanently
    // (spentCents += NaN makes every future comparison false).
    // Only reachable via DO RPC from the proxy, which always sends finite
    // values — so fail loudly instead of corrupting state.
    if (!Number.isFinite(input.estCostCents)) {
      throw new Error('estCostCents must be a finite number');
    }
    const est = Math.max(0, Math.ceil(input.estCostCents));

    // --- ATOMIC SECTION: no awaits until every mutation is applied. ---
    // The DO runs one event at a time, so concurrent authorize calls
    // serialize here: check and reserve complete as a single unit.
    for (const b of budgets) {
      if (b.spentCents + est > b.limitCents) {
        return {
          ok: false,
          code: 'budget_exceeded',
          message: `${b.period} budget exceeded`,
          limitCents: b.limitCents,
          spentCents: b.spentCents,
        };
      }
    }
    const reservationId = crypto.randomUUID();
    const reservedScopeKeys = budgets.map((b) => scopeKey(b.scopeId, b.period));
    for (const b of budgets) b.spentCents += est;
    this.reservations.set(reservationId, {
      keyHash: input.keyHash,
      // Bound from the key config at authorize time: settle() re-derives
      // key/project from this record, ignoring caller-supplied values.
      projectId: cfg.projectId,
      scopeKeys: reservedScopeKeys,
      estCents: est,
      t,
    });
    // --- END ATOMIC SECTION ---

    for (const b of budgets) this.background(this.persistBudget(b));
    this.checkVelocity(input.keyHash, est, t);

    return { ok: true, reservationId, projectId: cfg.projectId };
  }

  /** Best-effort velocity gate: pause the key for 15 min on a spend anomaly. */
  private checkVelocity(keyHash: string, estCents: number, t: number): void {
    let events = this.spendEvents.get(keyHash);
    if (!events) {
      events = [];
      this.spendEvents.set(keyHash, events);
    }
    events.push({ t, costCents: estCents });
    if (events.length > MAX_SPEND_EVENTS) events.splice(0, events.length - MAX_SPEND_EVENTS);
    let result: { anomaly: boolean };
    try {
      result = detectAnomaly(events, {
        windowSec: VELOCITY_WINDOW_SEC,
        baselineMult: VELOCITY_BASELINE_MULT,
      });
    } catch (err) {
      console.error('[spendcap] velocity check failed; skipping gate', err);
      return;
    }
    if (result.anomaly) {
      this.pausedUntil.set(keyHash, t + PAUSE_TTL_MS);
      // Key hashes only in logs — never raw keys, never bodies.
      console.warn(
        `[spendcap] velocity anomaly for key ${keyHash.slice(0, 12)}…; paused 15m`,
      );
    }
  }

  // -- settle -------------------------------------------------------------

  async settle(input: SettleInput): Promise<void> {
    const t = now();
    this.sweepReservations(t);
    const r = this.reservations.get(input.reservationId);
    if (!r) throw new Error('unknown or expired reservation');
    // The reservation is the authority on which key/project this settle
    // belongs to. The caller must present the matching key hash (a leaked
    // reservation id alone settles nothing), and the usage record is bound
    // to the reservation's values — caller-supplied keyHash/projectId are
    // never trusted for the write.
    if (input.keyHash !== r.keyHash) {
      throw new Error('settle: key hash does not match the reservation');
    }
    for (const v of [input.actualCostCents, input.inputTokens, input.outputTokens]) {
      if (!Number.isFinite(v) || v < 0) {
        throw new Error('settle: actualCostCents/inputTokens/outputTokens must be finite and >= 0');
      }
    }
    this.reservations.delete(input.reservationId);

    const delta = input.actualCostCents - r.estCents;
    for (const key of r.scopeKeys) {
      const b = this.budgets.get(key);
      if (!b) continue;
      this.maybeRollover(b, t);
      b.spentCents = Math.max(0, b.spentCents + delta);
      this.background(this.persistBudget(b));
    }

    this.usageBatch.push({
      id: crypto.randomUUID(),
      createdAt: new Date(t).toISOString(),
      projectId: r.projectId,
      keyHash: r.keyHash,
      model: input.model,
      task: input.task ?? '',
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costCents: input.actualCostCents,
    });

    if (this.usageBatch.length >= FLUSH_THRESHOLD) {
      this.background(this.flushBatch());
    } else {
      await this.ensureAlarm(t);
    }
  }

  /**
   * Flush the in-memory usage batch to D1. Retries the unwritten remainder
   * with backoff; anything still pending is requeued and counted in the
   * `detail_rows_delayed` DO-storage counter — rows are never silently dropped.
   */
  async flushBatch(): Promise<void> {
    if (this.usageBatch.length === 0) return;
    let pending = this.usageBatch;
    this.usageBatch = [];
    const delays = __budgetTestHooks.flushRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const { written } = await flushUsageBatch(this.env.DB, pending);
        pending = pending.slice(written);
        if (pending.length === 0) return;
      } catch (err) {
        console.error('[spendcap] usage flush threw; will retry', err);
      }
      if (attempt >= delays.length) break;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    // Still failing: requeue and count.
    this.usageBatch = pending.concat(this.usageBatch);
    const total = ((await this.ctx.storage.get<number>('detail_rows_delayed')) ?? 0) + pending.length;
    await this.ctx.storage.put('detail_rows_delayed', total);
    console.error(
      `[spendcap] usage flush failed after retries; ${pending.length} rows delayed (total ${total})`,
    );
  }

  private async ensureAlarm(t: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing <= t) {
      await this.ctx.storage.setAlarm(t + FLUSH_INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    await this.flushBatch();
    if (this.usageBatch.length > 0) {
      await this.ctx.storage.setAlarm(now() + FLUSH_INTERVAL_MS);
    }
  }

  // -- reads --------------------------------------------------------------

  /**
   * Live budget state. When a scope has both daily and monthly budgets, the
   * binding constraint (least remaining) is returned.
   */
  async getState(scopeId: string): Promise<{
    scopeId: string;
    period: string;
    limitCents: number;
    spentCents: number;
    remainingCents: number;
  }> {
    const t = now();
    const budgets = await this.ensureBudgets(scopeId);
    if (budgets.length === 0) {
      throw new Error(`no budgets defined for scope ${scopeId}`);
    }
    let binding = budgets[0];
    for (const b of budgets) {
      this.maybeRollover(b, t);
      if (b.limitCents - b.spentCents < binding.limitCents - binding.spentCents) binding = b;
    }
    return {
      scopeId: binding.scopeId,
      period: binding.period,
      limitCents: binding.limitCents,
      spentCents: binding.spentCents,
      remainingCents: binding.limitCents - binding.spentCents,
    };
  }

  /** Operational metric: usage rows still pending after failed flushes. */
  async getDelayedFlushCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('detail_rows_delayed')) ?? 0;
  }

  /**
   * Drop a key's cached config and all per-key ephemeral state (pause timer,
   * rate window, spend events, last-seen). The next authorize reloads the
   * config from D1. The dashboard calls this after revoke/rotate so the
   * incident-response control takes effect on the warm DO immediately
   * instead of waiting for eviction. Idempotent: unknown hashes are a no-op.
   */
  invalidateKey(keyHash: string): void {
    // Timing-safe scan: lookups compare with timingSafeEqualHex, so the
    // invalidation must find the entry the same way.
    for (const stored of this.keys.keys()) {
      if (timingSafeEqualHex(stored, keyHash)) {
        this.keys.delete(stored);
        this.keyCachedAt.delete(stored);
      }
    }
    this.pausedUntil.delete(keyHash);
    this.rateWindows.delete(keyHash);
    this.spendEvents.delete(keyHash);
    this.lastSeen.delete(keyHash);
  }

  /**
   * Drop a scope's in-memory budget definitions so the next authorize
   * reseeds them from D1. The dashboard calls this after a budget set/change.
   * Live spend counters are NOT reset: they persist in DO storage and are
   * re-attached when the definitions reload — only the limits refresh.
   */
  reloadScope(scopeId: string): void {
    for (const [key, b] of this.budgets) {
      if (b.scopeId === scopeId) this.budgets.delete(key);
    }
    this.budgetsLoaded.delete(scopeId);
  }
}

/**
 * The deployed Durable Object: a thin adapter exposing BudgetEnforcerCore
 * over DO RPC. The proxy binds it as `env.BUDGET_DO` and addresses the
 * single gateway instance via `idFromName('gateway')`.
 */
export class BudgetEnforcer extends DurableObject<BudgetEnv> {
  private core: BudgetEnforcerCore;

  constructor(ctx: DurableObjectState, env: BudgetEnv) {
    super(ctx, env);
    this.core = new BudgetEnforcerCore(ctx, env);
  }

  authorizeAndReserve(input: AuthorizeInput): Promise<AuthorizeResult> {
    return this.core.authorizeAndReserve(input);
  }

  settle(input: SettleInput): Promise<void> {
    return this.core.settle(input);
  }

  getState(scopeId: string): Promise<{
    scopeId: string;
    period: string;
    limitCents: number;
    spentCents: number;
    remainingCents: number;
  }> {
    return this.core.getState(scopeId);
  }

  flushBatch(): Promise<void> {
    return this.core.flushBatch();
  }

  alarm(): Promise<void> {
    return this.core.alarm();
  }

  getDelayedFlushCount(): Promise<number> {
    return this.core.getDelayedFlushCount();
  }

  /**
   * DO RPC: drop a key's cached config + ephemeral state (see
   * BudgetEnforcerCore.invalidateKey). Called by the dashboard after
   * revoke/rotate.
   */
  invalidateKey(keyHash: string): void {
    this.core.invalidateKey(keyHash);
  }

  /**
   * DO RPC: drop a scope's in-memory budget definitions so the next
   * authorize reseeds them from D1 (see
   * BudgetEnforcerCore.reloadScope). Called by the dashboard after a budget
   * set/change.
   */
  reloadScope(scopeId: string): void {
    this.core.reloadScope(scopeId);
  }

  drainWrites(): Promise<void> {
    return this.core.drainWrites();
  }
}
