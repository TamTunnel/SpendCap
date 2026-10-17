// Minimal ambient types for the `cloudflare:test` virtual module provided by
// @cloudflare/vitest-pool-workers at runtime. Type-only: erased before the
// pool resolves the real module, so this can never conflict at runtime.
declare module 'cloudflare:test' {
  export interface TestEnv {
    DB: D1Database;
    BUDGET_DO: DurableObjectNamespace;
  }
  export const env: TestEnv;

  export interface MockReplyScope {
    persist(): MockReplyScope;
    times(n: number): MockReplyScope;
  }
  export interface MockInterceptor {
    reply(
      statusCode: number,
      data?: unknown,
      opts?: { headers?: Record<string, string> },
    ): MockReplyScope;
    replyWithError(err: Error): MockReplyScope;
  }
  export interface MockAgent {
    get(
      origin: string,
    ): {
      intercept(opts: { method?: string; path?: string | RegExp }): MockInterceptor;
    };
    disableNetConnect(): void;
    enableNetConnect(host?: string | RegExp): void;
  }
  /** Declarative outbound-fetch mock. Reset before each test file. */
  export const fetchMock: MockAgent;

  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  export function createScheduledController(opts?: {
    cron?: string;
    scheduledTime?: number;
  }): ScheduledController;
}
