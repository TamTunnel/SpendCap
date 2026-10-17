// Worker environment bindings (matches wrangler.toml + vars).
import type { BudgetEnforcer } from '../../budget/src/enforcer.js';

export interface Env {
  BUDGET_DO: DurableObjectNamespace<BudgetEnforcer>;
  DB: D1Database;
  /** Secret used to derive the AES-GCM key that unwraps provider_keys.enc_key. */
  PROVIDER_KEYS_SECRET: string;
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  DEFAULT_PROVIDER_BASE_URL: string;
}
