import { defineWorkspace } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkspace([
  // defineWorkersProject (not the bare pool string) registers the
  // `cloudflare:test` virtual module so workers-pool tests can access
  // bindings (env.DB, …) directly.
  defineWorkersProject({
    test: {
      name: 'workers',
      include: [
        'packages/proxy/test/**/*.test.ts',
        'packages/budget/test/**/*.test.ts',
        'packages/dashboard/test/**/*.test.ts',
        'commercial/multitenant/test/**/*.test.ts',
      ],
      pool: '@cloudflare/vitest-pool-workers',
      poolOptions: {
        workers: {
          // Worker entrypoint for SELF and for resolving DO classes
          // (BUDGET_DO) in tests. Must export the BudgetEnforcer class —
          // the proxy re-exports it from the budget package source.
          main: 'packages/proxy/src/index.ts',
          miniflare: {
            compatibilityDate: '2026-10-01',
            d1Databases: ['DB'],
            // Test-only admin credential for the dashboard worker's
            // fail-closed auth (its tests send `Bearer test-admin-token`).
            // NOTE: this miniflare takes plain bindings via `bindings`,
            // not the old `vars` option.
            bindings: { ADMIN_TOKEN: 'test-admin-token' },
            durableObjects: {
              BUDGET_DO: { className: 'BudgetEnforcer' },
            },
          },
        },
      },
    },
  }),
  {
    test: {
      name: 'node',
      include: [
        'packages/auth/test/**/*.test.ts',
        'packages/data/test/**/*.test.ts',
        'packages/arbitrage/test/**/*.test.ts',
        'packages/guardrails/test/**/*.test.ts',
        'packages/cli/test/**/*.test.ts',
        'commercial/billing/test/**/*.test.ts',
      ],
    },
  },
]);
