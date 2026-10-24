import type { CrowdLevel, LiveAttraction, LiveSnapshot, WaitCorrection } from './types';
import { MINUTE, clamp, parkMinutesOfDay } from './time';

/**
 * Generic intraday crowd curve (relative to the daily peak), as minutes-of-day → factor.
 * v0.1 assumption until per-attraction history is collected: waits rise through the
 * morning, plateau early afternoon, then ease off in the evening.
 */
const CURVE: ReadonlyArray<readonly [number, number]> = [
  [8 * 60 + 30, 0.4],
  [9 * 60 + 30, 0.45],
  [11 * 60, 0.8],
  [13 * 60, 1.0],
  [15 * 60, 1.0],
  [18 * 60, 0.8],
  [20 * 60, 0.6],
  [22 * 60, 0.4],
  [23 * 60 + 30, 0.35],
];

export function crowdFactor(minutesOfDay: number): number {
  const first = CURVE[0]!;
  const last = CURVE[CURVE.length - 1]!;
  if (minutesOfDay <= first[0]) return first[1];
  if (minutesOfDay >= last[0]) return last[1];
  for (let i = 1; i < CURVE.length; i++) {
    const [x1, y1] = CURVE[i]!;
    const [x0, y0] = CURVE[i - 1]!;
    if (minutesOfDay <= x1) return y0 + ((y1 - y0) * (minutesOfDay - x0)) / (x1 - x0);
  }
  return last[1];
}

/** Horizon (minutes) over which the forecast fully switches from "posted now" to the curve. */
const BLEND_HORIZON_MIN = 120;

/**
 * Predicted wait (minutes, multiple of 5) for joining the queue `aheadMin` minutes from now,
 * from the wait posted now, the intraday curve and the user's local correction.
 * Minutes-of-day are passed in so the planner's hot loop avoids timezone formatting.
 */
export function predictWaitAt(posted: number, nowMinOfDay: number, arrivalMinOfDay: number, aheadMin: number, correction?: WaitCorrection): number {
  const w = clamp(Math.max(0, aheadMin) / BLEND_HORIZON_MIN, 0, 1);
  const ratio = crowdFactor(arrivalMinOfDay) / crowdFactor(nowMinOfDay);
  let pred = posted * (1 - w + w * ratio);
  if (correction && correction.samples > 0) {
    // Trust the correction progressively (full weight from 3 reports).
    const trust = Math.min(1, correction.samples / 3);
    pred *= 1 + (correction.ratio - 1) * trust;
  }
  return Math.max(0, Math.round(pred / 5) * 5);
}

/** Convenience wrapper on epochs (UI, advice). */
export function predictWait(posted: number, now: number, arrival: number, correction?: WaitCorrection): number {
  return predictWaitAt(posted, parkMinutesOfDay(now), parkMinutesOfDay(arrival), (arrival - now) / MINUTE, correction);
}

/** Folds one "actual vs posted" report into the running correction (EMA, clamped). */
export function updateCorrection(prev: WaitCorrection | undefined, posted: number, actual: number): WaitCorrection {
  const sampleRatio = clamp(posted <= 0 ? 1 : actual / posted, 0.3, 2);
  if (!prev || prev.samples === 0) return { ratio: clamp(sampleRatio, 0.4, 1.5), samples: 1 };
  const alpha = 0.4;
  return { ratio: clamp(prev.ratio * (1 - alpha) + sampleRatio * alpha, 0.4, 1.5), samples: Math.min(prev.samples + 1, 20) };
}

/** Crowd level from the mean posted standby of operating rides; drives show arrival margins. */
export function crowdLevel(snapshot: LiveSnapshot): CrowdLevel {
  const waits = Object.values(snapshot.attractions)
    .filter((a): a is LiveAttraction & { standby: number } => a.status === 'OPERATING' && a.standby !== null)
    .map((a) => a.standby);
  if (waits.length === 0) return 'mid';
  const mean = waits.reduce((s, v) => s + v, 0) / waits.length;
  if (mean < 20) return 'low';
  if (mean < 35) return 'mid';
  return 'high';
}

/** Minimum gain (minutes) for Single Rider to be worth splitting up. */
export const SINGLE_RIDER_MIN_GAIN = 15;
