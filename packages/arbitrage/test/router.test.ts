import { describe, expect, it } from 'vitest';
import type { PricingTable } from '@tamtunnel/spendcap-data';
import {
  DEFAULT_TIERS,
  UnknownModelError,
  routeRequest,
} from '../src/router.js';

// Plausible $/1M prices; relative order is what matters for the picks.
const pricing: PricingTable = {
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'deepseek-v4-flash': { inputPer1M: 0.27, outputPer1M: 1.1 },
  'claude-sonnet-4.5': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'gpt-5.5': { inputPer1M: 5.0, outputPer1M: 20.0 },
  'claude-opus-4.7': { inputPer1M: 15.0, outputPer1M: 75.0 },
};

describe('router pinned mode', () => {
  it('honors the pinned model', () => {
    const r = routeRequest({
      policy: { mode: 'pinned', pinnedModel: 'gpt-5.5' },
      pricing,
    });
    expect(r.model).toBe('gpt-5.5');
    expect(r.tier).toBe('standard');
    expect(r.reason).toContain('pinned');
  });

  it('throws UnknownModelError for a pinned model missing from pricing', () => {
    expect(() =>
      routeRequest({ policy: { mode: 'pinned', pinnedModel: 'nope-9' }, pricing }),
    ).toThrow(UnknownModelError);
  });

  it('throws when pinned mode has no pinnedModel', () => {
    expect(() => routeRequest({ policy: { mode: 'pinned' }, pricing })).toThrow(
      /pinnedModel/,
    );
  });
});

describe('router auto mode', () => {
  it('defaults to the cheapest cheap model', () => {
    const r = routeRequest({ policy: { mode: 'auto' }, pricing });
    expect(r.model).toBe('gemini-2.5-flash-lite');
    expect(r.tier).toBe('cheap');
  });

  it('bumps to standard when tools are requested', () => {
    const r = routeRequest({ policy: { mode: 'auto' }, hasTools: true, pricing });
    expect(r.model).toBe('claude-sonnet-4.5');
    expect(r.tier).toBe('standard');
    expect(r.reason).toContain('tool');
  });

  it('bumps to standard when maxTokens exceeds 4000', () => {
    const r = routeRequest({ policy: { mode: 'auto' }, maxTokens: 8000, pricing });
    expect(r.model).toBe('claude-sonnet-4.5');
    expect(r.tier).toBe('standard');
  });

  it('stays cheap at exactly 4000 maxTokens', () => {
    const r = routeRequest({ policy: { mode: 'auto' }, maxTokens: 4000, pricing });
    expect(r.tier).toBe('cheap');
  });

  it('caps the bumped tier at maxAutoTier', () => {
    const r = routeRequest({
      policy: { mode: 'auto', maxAutoTier: 'cheap' },
      hasTools: true,
      pricing,
    });
    expect(r.model).toBe('gemini-2.5-flash-lite');
    expect(r.tier).toBe('cheap');
    expect(r.reason).toContain('maxAutoTier');
  });

  it('honors a frontier modelHint when allowed', () => {
    const r = routeRequest({
      policy: { mode: 'auto' },
      modelHint: 'claude-opus-4.7',
      pricing,
    });
    expect(r.model).toBe('claude-opus-4.7');
    expect(r.tier).toBe('frontier');
  });

  it('clamps a frontier modelHint to maxAutoTier', () => {
    const r = routeRequest({
      policy: { mode: 'auto', maxAutoTier: 'standard' },
      modelHint: 'claude-opus-4.7',
      pricing,
    });
    expect(r.model).toBe('claude-sonnet-4.5');
    expect(r.tier).toBe('standard');
    expect(r.reason).toContain('clamped');
  });

  it('falls back to cheapest cheap on an unknown modelHint instead of throwing', () => {
    const r = routeRequest({
      policy: { mode: 'auto' },
      modelHint: 'mystery-model-3000',
      pricing,
    });
    expect(r.model).toBe('gemini-2.5-flash-lite');
    expect(r.tier).toBe('cheap');
    expect(r.reason).toContain('not in the pricing table');
  });

  it('honors a cheaper hint within maxAutoTier', () => {
    const r = routeRequest({
      policy: { mode: 'auto', maxAutoTier: 'frontier' },
      modelHint: 'deepseek-v4-flash',
      pricing,
    });
    expect(r.model).toBe('deepseek-v4-flash');
    expect(r.tier).toBe('cheap');
  });

  it('uses custom autoTiers when provided', () => {
    const r = routeRequest({
      policy: {
        mode: 'auto',
        autoTiers: {
          cheap: ['deepseek-v4-flash'],
          standard: ['gpt-5.5'],
          frontier: ['claude-opus-4.7'],
        },
      },
      pricing,
    });
    expect(r.model).toBe('deepseek-v4-flash');
    expect(r.tier).toBe('cheap');
  });

  it('picks the cheapest model even when listed second in the tier', () => {
    const r = routeRequest({
      policy: {
        mode: 'auto',
        autoTiers: {
          // deepseek is pricier than gemini: order must not matter.
          cheap: ['deepseek-v4-flash', 'gemini-2.5-flash-lite'],
          standard: ['gpt-5.5'],
          frontier: ['claude-opus-4.7'],
        },
      },
      pricing,
    });
    expect(r.model).toBe('gemini-2.5-flash-lite');
  });

  it('labels a pinned model outside all tiers as "pinned"', () => {
    const extended: PricingTable = {
      ...pricing,
      'custom-model-y': { inputPer1M: 1.0, outputPer1M: 2.0 },
    };
    const r = routeRequest({
      policy: { mode: 'pinned', pinnedModel: 'custom-model-y' },
      pricing: extended,
    });
    expect(r.model).toBe('custom-model-y');
    expect(r.tier).toBe('pinned');
  });

  it('throws when a tier has no priced models', () => {
    expect(() =>
      routeRequest({
        policy: { mode: 'auto' },
        pricing: { 'claude-opus-4.7': pricing['claude-opus-4.7'] },
      }),
    ).toThrow(UnknownModelError);
  });

  it('treats a priced hint outside all tiers as cheap and honors it', () => {
    const extended: PricingTable = {
      ...pricing,
      'custom-model-x': { inputPer1M: 0.05, outputPer1M: 0.2 },
    };
    const r = routeRequest({
      policy: { mode: 'auto' },
      modelHint: 'custom-model-x',
      pricing: extended,
    });
    expect(r.model).toBe('custom-model-x');
    expect(r.tier).toBe('cheap');
  });

  it('exposes the default tiers', () => {
    expect(DEFAULT_TIERS.cheap).toContain('gemini-2.5-flash-lite');
    expect(DEFAULT_TIERS.frontier).toContain('claude-opus-4.7');
  });
});
