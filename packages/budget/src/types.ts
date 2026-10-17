// Contract types for the budget enforcer.
export interface AuthorizeInput {
  keyHash: string;
  estCostCents: number;
  task?: string;
  modelHint?: string;
  /**
   * The model the proxy actually routed to (post policy-clamp). The enforcer
   * checks it against the key's allowedModels allow-list. Pure routing
   * happens in the proxy before authorize is called, so this is known up
   * front — the enforcer never routes, it only enforces.
   */
  routedModel?: string;
}

export type AuthorizeResult =
  | { ok: true; reservationId: string; projectId: string; routedModel?: string }
  | {
      ok: false;
      code:
        | 'budget_exceeded'
        | 'key_not_found'
        | 'rate_limited'
        | 'key_paused'
        | 'model_not_allowed';
      message: string;
      limitCents?: number;
      spentCents?: number;
    };

export interface SettleInput {
  reservationId: string;
  actualCostCents: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  task?: string;
  /**
   * Must match the reservation's keyHash (verified by the enforcer). The
   * usage record itself is bound to the reservation's keyHash/projectId —
   * caller-supplied values are ignored for the write.
   */
  keyHash: string;
  projectId: string;
}

/** Bindings available to the BudgetEnforcer Durable Object. */
export interface BudgetEnv {
  DB: D1Database;
}
