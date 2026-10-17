// spendcap CLI HTTP client: the dashboard API owner is the dashboard worker.
//
// Every command below goes through `api()` — a thin POST-JSON helper with
// Bearer <redacted> auth. `__setApiConfigForTests` lets the contract
// test point the client at an in-process dashboard worker instead of the
// network; production always reads SPENDCAP_API / SPENDCAP_ADMIN_TOKEN.

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiTestConfig {
  base?: string;
  token?: string;
}

let testOverride: ApiTestConfig | null = null;

/**
 * Test seam: override the API base/token without touching process.env.
 * Pass null to restore env-based configuration.
 */
export function __setApiConfigForTests(cfg: ApiTestConfig | null): void {
  testOverride = cfg;
}

export function apiBase(): string {
  return testOverride?.base ?? process.env.SPENDCAP_API ?? 'http://localhost:8787';
}

function adminToken(): string {
  const t = testOverride?.token ?? process.env.SPENDCAP_ADMIN_TOKEN;
  if (!t) {
    throw new CliError(
      'SPENDCAP_ADMIN_TOKEN is not set. Export it before running API commands.',
    );
  }
  return t;
}

export async function api<T>(path: string, body: unknown): Promise<T> {
  // Checked before any network attempt so a missing credential is never
  // misreported as a connectivity problem.
  const token = adminToken();
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError(
      `could not reach dashboard API at ${apiBase()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new CliError(`dashboard API error ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}
