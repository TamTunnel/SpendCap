// Test harness for the BudgetEnforcer Durable Object.
//
// Why this exists: @cloudflare/vitest-pool-workers@0.8.71 + the installed
// workerd leaves a `-shm` file behind for ANY instantiated Durable Object,
// which trips the pool's isolated-storage pop assertion ("Expected .sqlite").
// This is a pool/workerd interaction bug, not enforcer behavior: it fires for
// a zero-I/O RPC call too. Instead of routing through `env.BUDGET_DO`, tests
// instantiate the real BudgetEnforcer directly with a fake DurableObjectState
// (in-memory storage) and the pool's real D1 binding.
//
// What this still exercises for real, in workerd:
//   - the full authorize/settle/getState/flush logic,
//   - the await-free atomic check-and-reserve under true parallel load
//     (direct calls interleave at awaits exactly like DO RPC dispatch would;
//     the critical section itself contains no awaits),
//   - DO-storage persistence of budget counters (via the fake storage),
//   - the alarm flush path.
// What it does NOT exercise: DO RPC serialization and multi-instance routing
// (single instance `idFromName('gateway')` is a deployment topology concern).

export interface FakeDoCtx {
  ctx: DurableObjectState;
  /** Await every promise handed to ctx.waitUntil(). */
  drain: () => Promise<void>;
  /** Inspect the fake storage (for assertions). */
  store: Map<string, unknown>;
  /** Read the currently scheduled alarm timestamp, if any. */
  getAlarm: () => number | null;
}

export function makeFakeDoCtx(): FakeDoCtx {
  const store = new Map<string, unknown>();
  const waitUntils: Promise<unknown>[] = [];
  let alarm: number | null = null;

  const storage = {
    get: async (key: string | string[]) => {
      if (Array.isArray(key)) {
        const out: Record<string, unknown> = {};
        for (const k of key) {
          if (store.has(k)) out[k] = store.get(k);
        }
        return out;
      }
      return store.has(key) ? store.get(key) : undefined;
    },
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') {
        store.set(key, value);
      } else {
        for (const [k, v] of Object.entries(key)) store.set(k, v);
      }
    },
    delete: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n++;
      }
      return n;
    },
    list: async () => new Map(store),
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => {
      alarm = t;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async <T>(fn: (txn: unknown) => Promise<T> | T): Promise<T> => fn(storage),
    sync: async () => {},
  };

  const ctx = {
    storage,
    waitUntil: (p: Promise<unknown>) => {
      waitUntils.push(p);
      p.then(
        () => {},
        () => {},
      );
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T> | T): Promise<T> => fn(),
    id: {
      toString: () => 'test-do-id',
      equals: () => false,
      name: 'test-do',
    },
  };

  return {
    ctx: ctx as unknown as DurableObjectState,
    drain: async () => {
      // Loop: draining may surface promises chained off earlier ones.
      for (;;) {
        const pending = waitUntils.splice(0);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
    store,
    getAlarm: () => alarm,
  };
}
