import { MINUTE, parkMinutesOfDay, parkWallTime } from '../domain/time';
import type { LiveAttraction, LiveSnapshot, ParkHours, ParkId, ParkInfo, Place } from '../domain/types';
import { crowdFactor } from '../domain/waits';
import { demoSnapshot } from './demo';
import type { DestinationDef } from './destinations';
import { usualHours } from './themeparks';

/**
 * A planned visit on a day to come: the day's published hours when known (usual hours
 * otherwise), and typical waits. Nothing here is live data, and the screens say so.
 */

/** Typical wait at the busiest time of day, by ride intensity (minutes). */
export const TYPICAL_PEAK_WAIT: Readonly<Record<1 | 2 | 3, number>> = { 1: 15, 2: 30, 3: 45 };
/** Same, when the park's list does not grade its rides (feeds and maps say nothing of intensity). */
export const UNGRADED_PEAK_WAIT = 25;

/** Noon (UTC) of a park date: same date in Paris time, a safe reference for wall times. */
export function dateRef(dateKey: string): number {
  return Date.parse(`${dateKey}T12:00:00Z`);
}

/** Opening hours of each park on that day: published ones first, usual ones otherwise. */
export function forecastHours(def: DestinationDef, parks: readonly ParkInfo[], dateKey: string, published: Readonly<Partial<Record<ParkId, ParkHours>>> | null): Record<ParkId, ParkHours> {
  const ref = dateRef(dateKey);
  const hours: Record<ParkId, ParkHours> = {};
  for (const p of parks) {
    const known = published?.[p.id];
    if (known) {
      hours[p.id] = known;
    } else if (!published) {
      const [o, c] = usualHours(def, p.id);
      hours[p.id] = { open: parkWallTime(ref, o), close: parkWallTime(ref, c), emh: null };
    }
  }
  return hours;
}

/** Estimated snapshot at the first opening of the day (plans start there). */
export function forecastSnapshot(def: DestinationDef, catalog: ReadonlyMap<string, Place>, parks: readonly ParkInfo[], dateKey: string, published: Readonly<Partial<Record<ParkId, ParkHours>>> | null): LiveSnapshot {
  const hours = forecastHours(def, parks, dateKey, published);
  const opens = Object.values(hours).map((h) => h.open);
  const start = opens.length > 0 ? Math.min(...opens) : parkWallTime(dateRef(dateKey), def.hours[0]);

  if (def.features.demo) {
    // Disneyland Paris: the demo's day model (waits, sessions, Premier Access), at the opening.
    const demo = demoSnapshot(start, catalog);
    return { ...demo, fetchedAt: start, hours: published ? hours : demo.hours };
  }

  const factor = crowdFactor(parkMinutesOfDay(start));
  const graded = isGraded(catalog);
  const attractions: Record<string, LiveAttraction> = {};
  for (const p of catalog.values()) {
    if (p.kind !== 'ride' || !hours[p.park]) continue;
    const peak = graded ? TYPICAL_PEAK_WAIT[p.intensity] : UNGRADED_PEAK_WAIT;
    const standby = Math.max(5, Math.round((peak * factor) / 5) * 5);
    attractions[p.id] = { status: 'OPERATING', standby, singleRider: null, pa: null };
  }
  // Sessions are only known on the day itself.
  return { source: 'manual', fetchedAt: start, parks: parks.filter((p) => hours[p.id]), attractions, showtimes: {}, hours };
}

/** When to be at the gates: 30 minutes before the first opening (security check, tickets). */
export function arrivalAdvice(snapshot: LiveSnapshot, emhAccess: boolean): number | null {
  const opens = Object.values(snapshot.hours).map((h) => (emhAccess && h.emh ? h.emh.open : h.open));
  return opens.length > 0 ? Math.min(...opens) - 30 * MINUTE : null;
}

/** Whether the rides carry real intensity and height data (curated list), not defaults. */
export function isGraded(catalog: ReadonlyMap<string, Place>): boolean {
  for (const p of catalog.values()) if (p.kind === 'ride' && (p.intensity !== 1 || p.minHeightCm > 0)) return true;
  return false;
}

/** Suits young children: gentle, and open to the smallest member of the group. */
export function forChildren(p: Place, smallestHeightCm: number | null): boolean {
  if (p.kind === 'show') return true;
  if (smallestHeightCm !== null && p.minHeightCm > smallestHeightCm) return false;
  return p.intensity === 1 || (p.intensity === 2 && p.minHeightCm <= 110);
}
