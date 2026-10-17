import { describe, expect, it } from 'vitest';
import { detectAnomaly, type SpendEvent } from '../src/velocity.js';

const ev = (t: number, costCents: number): SpendEvent => ({ t, costCents });

/**
 * Flat traffic: centsPerMin for `minutes` minutes, one event per minute.
 * Timestamps are MILLISECONDS (Date.now() scale) — the unit the enforcer
 * actually passes in.
 */
function flatTraffic(minutes = 10, centsPerMin = 100, start = 0): SpendEvent[] {
  const out: SpendEvent[] = [];
  for (let i = 0; i < minutes; i++) out.push(ev(start + i * 60_000, centsPerMin));
  return out;
}

describe('velocity anomaly detection', () => {
  it('reports no anomaly for flat traffic', () => {
    const events = flatTraffic();
    const r = detectAnomaly(events, { windowSec: 60, baselineMult: 3 });
    expect(r.anomaly).toBe(false);
    expect(r.burnRateCentsPerMin).toBeCloseTo(100, 6);
    // 9 older events (t=0..8min) spanning 8 min: 900¢ / 8 min = 112.5¢/min.
    expect(r.baselineCentsPerMin).toBeCloseTo(112.5, 6);
  });

  it('flags a 20x spend spike', () => {
    const events = [...flatTraffic(10, 5), ev(10 * 60_000, 100)];
    const r = detectAnomaly(events, { windowSec: 60, baselineMult: 3 });
    expect(r.anomaly).toBe(true);
    expect(r.burnRateCentsPerMin).toBeCloseTo(100, 6);
    // 10 older events (t=0..9min, 5¢ each) spanning 9 min: 50¢ / 9 min ≈ 5.556¢/min.
    expect(r.baselineCentsPerMin).toBeCloseTo(50 / 9, 6);
  });

  it('does not flag a relative spike on tiny absolute spend', () => {
    // 20x relative spike, but the recent burn is only 10¢/min (< 50¢ floor).
    const events = [...flatTraffic(10, 0.5), ev(10 * 60_000, 10)];
    const r = detectAnomaly(events, { windowSec: 60, baselineMult: 3 });
    expect(r.anomaly).toBe(false);
    expect(r.burnRateCentsPerMin).toBeCloseTo(10, 6);
  });

  it('reports no anomaly for empty events', () => {
    const r = detectAnomaly([], { windowSec: 60, baselineMult: 3 });
    expect(r).toEqual({ anomaly: false, burnRateCentsPerMin: 0, baselineCentsPerMin: 0 });
  });

  it('reports no anomaly for a non-positive window', () => {
    const r = detectAnomaly([ev(0, 100)], { windowSec: 0, baselineMult: 3 });
    expect(r.anomaly).toBe(false);
  });

  it('falls back to the floor baseline when history is thin', () => {
    // Only one older event: baseline floor (1¢/min); a 100¢/min burn still flags.
    const r = detectAnomaly([ev(0, 5), ev(10 * 60_000, 100)], { windowSec: 60, baselineMult: 3 });
    expect(r.baselineCentsPerMin).toBe(1);
    expect(r.anomaly).toBe(true);
  });

  it('does not flag when the spike is below the multiplier', () => {
    const events = [...flatTraffic(10, 50), ev(10 * 60_000, 100)];
    const r = detectAnomaly(events, { windowSec: 60, baselineMult: 3 });
    expect(r.anomaly).toBe(false);
  });

  it('uses the floor when older events share one timestamp', () => {
    const r = detectAnomaly([ev(0, 50), ev(0, 50), ev(10 * 60_000, 100)], {
      windowSec: 60,
      baselineMult: 3,
    });
    expect(r.baselineCentsPerMin).toBe(1);
    expect(r.anomaly).toBe(true);
  });

  it('uses the newest event as the reference time', () => {
    // Events stop at t=5min; the 60s window before it contains only the last event.
    const events = [ev(0, 10), ev(60_000, 10), ev(5 * 60_000, 200)];
    const r = detectAnomaly(events, { windowSec: 60, baselineMult: 3 });
    expect(r.burnRateCentsPerMin).toBeCloseTo(200, 6);
    expect(r.anomaly).toBe(true);
  });

  it('fix-5-flags-spike-on-real-clock-scale: 60min of 10¢/min then a 200x spike for 6min', () => {
    // Regression test for the ms/s unit bug: timestamps are real
    // Date.now()-scale milliseconds. With the old code (cutoff = now -
    // windowSec, mixing ms timestamps with a seconds window) the "recent"
    // window covered ~600ms instead of 10min, so a sustained spike of many
    // small events burned at ~3¢/min on paper — under the absolute floor —
    // and the gate was ~1000x less sensitive than documented.
    //
    // Granularity matters: the 200x spike (2000¢/min) arrives as per-second
    // events, the way a real burst does. Old code: recent = the single
    // newest event (33¢) → 3.3¢/min < 50¢ floor → NO anomaly. Fixed code:
    // recent = the full 6min burst → 1204¢/min vs ~10.2¢/min baseline.
    const t0 = Date.now() - 70 * 60_000;
    const events: SpendEvent[] = [];
    for (let i = 0; i < 60; i++) events.push(ev(t0 + i * 60_000, 10)); // 10¢/min baseline
    for (let i = 0; i < 360; i++) events.push(ev(t0 + 60 * 60_000 + i * 1000, 2000 / 60)); // 200x, per-second
    const r = detectAnomaly(events, { windowSec: 600, baselineMult: 4 });
    // Recent 10min: 360×(2000/60)¢ + 4×10¢ = 12040¢ → 1204¢/min burn;
    // baseline = 560¢ over 55min ≈ 10.18¢/min; 4× baseline ≈ 40.7¢/min.
    expect(r.anomaly).toBe(true);
    expect(r.burnRateCentsPerMin).toBeCloseTo(1204, 4);
    expect(r.baselineCentsPerMin).toBeCloseTo(560 / 55, 4);
  });
});
