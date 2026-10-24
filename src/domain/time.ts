/** Time helpers. The parks run on Europe/Paris wall time whatever the device timezone. */

export const PARK_TZ = 'Europe/Paris';
export const MINUTE = 60_000;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: PARK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const hmFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: PARK_TZ, hour: '2-digit', minute: '2-digit' });

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallParts(epoch: number): WallParts {
  const out: Record<string, number> = {};
  for (const p of partsFmt.formatToParts(new Date(epoch))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
  };
}

/** Minutes since local midnight in the park timezone. */
export function parkMinutesOfDay(epoch: number): number {
  const p = wallParts(epoch);
  return p.hour * 60 + p.minute;
}

/**
 * Fast minutes-of-day function for one park day: the zone offset is resolved once at `ref`
 * (DST switches happen at night, outside opening hours). Used in the planner's hot loop.
 */
export function minuteOfDayFn(ref: number): (epoch: number) => number {
  const raw = parkMinutesOfDay(ref) * MINUTE - (((ref % 86_400_000) + 86_400_000) % 86_400_000);
  // Zone offsets are multiples of 15 min; rounding absorbs the seconds dropped above.
  const quarter = 15 * MINUTE;
  const offset = Math.round(raw / quarter) * quarter;
  return (epoch: number) => {
    const local = (((epoch + offset) % 86_400_000) + 86_400_000) % 86_400_000;
    return Math.floor(local / MINUTE);
  };
}

/** YYYY-MM-DD of the park-local day containing `epoch`. */
export function parkDateKey(epoch: number): string {
  const p = wallParts(epoch);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Epoch of a park-local wall time (minutes since midnight) on the park-local day containing `ref`. */
export function parkWallTime(ref: number, minutesOfDay: number): number {
  const p = wallParts(ref);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0) + minutesOfDay * MINUTE;
  // Correct twice for the zone offset (handles DST transitions).
  let epoch = guess;
  for (let i = 0; i < 2; i++) {
    const w = wallParts(epoch);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    epoch += guess - asUtc;
  }
  return epoch;
}

export function formatHM(epoch: number): string {
  return hmFmt.format(new Date(epoch));
}

export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / MINUTE);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
