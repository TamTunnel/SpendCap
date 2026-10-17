// Velocity anomaly detection for the budget Durable Object.
//
// Pure function, zero I/O, dependency-free: the budget DO calls it on its
// in-memory event window. Flags a spend spike when the recent burn rate is both
// (a) more than `baselineMult` times the older baseline rate and
// (b) above an absolute floor, so penny-level traffic never pages anyone.
export interface SpendEvent {
  /** Millisecond timestamp (Date.now() scale) — NOT seconds. */
  t: number;
  costCents: number;
}

/** Floor for the baseline rate: avoids div-by-zero and noise when history is thin. */
export const BASELINE_FLOOR_CENTS_PER_MIN = 1;

/**
 * Absolute floor for the burn rate: a relative spike on pennies of spend is
 * not an anomaly.
 */
export const ANOMALY_ABS_FLOOR_CENTS_PER_MIN = 50;

function sumCosts(events: SpendEvent[]): number {
  let total = 0;
  for (const e of events) total += e.costCents;
  return total;
}

export function detectAnomaly(
  events: SpendEvent[],
  opts: { windowSec: number; baselineMult: number },
): { anomaly: boolean; burnRateCentsPerMin: number; baselineCentsPerMin: number } {
  const { windowSec, baselineMult } = opts;
  if (events.length === 0 || windowSec <= 0) {
    return { anomaly: false, burnRateCentsPerMin: 0, baselineCentsPerMin: 0 };
  }

  // "Now" is the newest event timestamp (pure function: no clock reads).
  // Event timestamps are MILLISECONDS (Date.now() scale); the window is
  // given in seconds, so convert — mixing the two made the gate ~1000x
  // less sensitive than documented.
  const now = Math.max(...events.map((e) => e.t));
  const cutoff = now - windowSec * 1000;
  const recent = events.filter((e) => e.t > cutoff);
  const older = events.filter((e) => e.t <= cutoff);

  const burnRateCentsPerMin = sumCosts(recent) / (windowSec / 60);

  let baselineCentsPerMin: number;
  if (older.length >= 2) {
    const spanSec = (Math.max(...older.map((e) => e.t)) - Math.min(...older.map((e) => e.t))) / 1000;
    baselineCentsPerMin =
      spanSec > 0
        ? sumCosts(older) / (spanSec / 60)
        : BASELINE_FLOOR_CENTS_PER_MIN;
  } else {
    // 0 or 1 older event: not enough history for a real baseline.
    baselineCentsPerMin = BASELINE_FLOOR_CENTS_PER_MIN;
  }

  const anomaly =
    burnRateCentsPerMin > baselineMult * baselineCentsPerMin &&
    burnRateCentsPerMin > ANOMALY_ABS_FLOOR_CENTS_PER_MIN;

  return { anomaly, burnRateCentsPerMin, baselineCentsPerMin };
}
