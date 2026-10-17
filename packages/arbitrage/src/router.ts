// Deterministic tier routing for Spendcap v1.
//
// HONEST NOTE: v1 arbitrage is deterministic tiers + simple heuristics, NOT ML
// confidence routing. Model selection follows a fixed policy (a pinned model,
// or the cheapest model in a mechanically chosen tier). routeRequest is a pure
// deterministic function with zero I/O — it NEVER calls an LLM to pick a model.
// Smarter (ML-based) routing is explicitly a v2 roadmap item.
import type { PricingTable } from '@tamtunnel/spendcap-data';

export interface RoutingPolicy {
  mode: 'pinned' | 'auto';
  pinnedModel?: string;
  autoTiers?: { cheap: string[]; standard: string[]; frontier: string[] };
  maxAutoTier?: 'cheap' | 'standard' | 'frontier';
}

export interface RouteInput {
  modelHint?: string;
  maxTokens?: number;
  hasTools?: boolean;
  policy: RoutingPolicy;
  pricing: PricingTable;
}

export type AutoTier = 'cheap' | 'standard' | 'frontier';

/** Thrown when a referenced model is absent from the pricing table. */
export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`unknown model "${model}": not present in pricing table`);
    this.name = 'UnknownModelError';
  }
}

/** Default tiers used when policy.autoTiers is absent. */
export const DEFAULT_TIERS: Record<AutoTier, string[]> = {
  cheap: ['gemini-2.5-flash-lite', 'deepseek-v4-flash'],
  standard: ['claude-sonnet-4.5', 'gpt-5.5'],
  frontier: ['claude-opus-4.7'],
};

const TIER_RANK: Record<AutoTier, number> = { cheap: 0, standard: 1, frontier: 2 };
const TIERS: AutoTier[] = ['cheap', 'standard', 'frontier'];

/**
 * Reference cost in cents for a 1k-input / 1k-output request, used only to
 * compare models within a tier. Computed from the caller-supplied pricing
 * table — no I/O.
 */
function referenceCostCents(model: string, pricing: PricingTable): number {
  // Callers filter to models present in pricing before calling.
  const p = pricing[model];
  return ((p.inputPer1M + p.outputPer1M) * 1000 * 100) / 1_000_000;
}

/** Cheapest model in a tier by reference cost, skipping models missing from pricing. */
function cheapestInTier(
  tier: AutoTier,
  tiers: Record<AutoTier, string[]>,
  pricing: PricingTable,
): string {
  const priced = tiers[tier].filter((m) => pricing[m] !== undefined);
  if (priced.length === 0) {
    throw new UnknownModelError(`(no priced model available in tier "${tier}")`);
  }
  let best = priced[0];
  for (const m of priced.slice(1)) {
    if (referenceCostCents(m, pricing) < referenceCostCents(best, pricing)) best = m;
  }
  return best;
}

/** Which configured tier a model belongs to, if any. */
function findTierOf(
  model: string,
  tiers: Record<AutoTier, string[]>,
): AutoTier | undefined {
  for (const t of TIERS) {
    if (tiers[t].includes(model)) return t;
  }
  return undefined;
}

export function routeRequest(input: RouteInput): { model: string; tier: string; reason: string } {
  const { policy, pricing } = input;
  const tiers = policy.autoTiers ?? DEFAULT_TIERS;
  const cap: AutoTier = policy.maxAutoTier ?? 'frontier';

  if (policy.mode === 'pinned') {
    const pinned = policy.pinnedModel;
    if (!pinned) {
      throw new Error('routing policy mode="pinned" requires pinnedModel');
    }
    if (!pricing[pinned]) throw new UnknownModelError(pinned);
    return {
      model: pinned,
      tier: findTierOf(pinned, tiers) ?? 'pinned',
      reason: `mode=pinned: routing to pinned model "${pinned}"`,
    };
  }

  // mode=auto -----------------------------------------------------------
  const hint = input.modelHint;
  if (hint !== undefined) {
    if (!pricing[hint]) {
      // Unknown hints must never throw: fall back to the cheapest cheap model.
      const fallback = cheapestInTier('cheap', tiers, pricing);
      return {
        model: fallback,
        tier: 'cheap',
        reason: `modelHint "${hint}" is not in the pricing table; falling back to cheapest cheap model "${fallback}"`,
      };
    }
    const hintTier = findTierOf(hint, tiers) ?? 'cheap';
    if (TIER_RANK[hintTier] <= TIER_RANK[cap]) {
      return {
        model: hint,
        tier: hintTier,
        reason: `explicit modelHint "${hint}" honored (tier ${hintTier})`,
      };
    }
    const clamped = cheapestInTier(cap, tiers, pricing);
    return {
      model: clamped,
      tier: cap,
      reason: `modelHint "${hint}" is tier ${hintTier} but maxAutoTier="${cap}"; clamped to cheapest ${cap} model "${clamped}"`,
    };
  }

  // No hint: mechanical tier selection. Cheap by default; bump to standard on
  // tool calls or large context; never reach frontier without an explicit hint.
  let tier: AutoTier = 'cheap';
  let bumpReason = 'no complexity signals';
  if (input.hasTools === true) {
    tier = 'standard';
    bumpReason = 'tool calls requested';
  } else if ((input.maxTokens ?? 0) > 4000) {
    tier = 'standard';
    bumpReason = `maxTokens ${input.maxTokens} exceeds 4000`;
  }

  let finalTier: AutoTier = tier;
  let capNote = '';
  if (TIER_RANK[tier] > TIER_RANK[cap]) {
    finalTier = cap;
    capNote = `; capped by maxAutoTier="${cap}"`;
  }
  const model = cheapestInTier(finalTier, tiers, pricing);
  return {
    model,
    tier: finalTier,
    reason: `${bumpReason}; cheapest ${finalTier} model "${model}"${capNote}`,
  };
}
