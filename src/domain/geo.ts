import type { GeoPoint, Pace, ParkId, Position } from './types';

/**
 * Walking model (v0.1): great-circle distance × detour factor, at a pace-dependent speed.
 * Changing park goes through both entrances plus a fixed control/turnstile penalty.
 * Coefficients are field hypotheses to calibrate (see product spec).
 */
export const DETOUR_FACTOR = 1.35;
export const PARK_SWITCH_PENALTY_MIN = 10;
export const STROLLER_FACTOR = 1.2;

const SPEED_M_PER_MIN: Readonly<Record<Pace, number>> = { slow: 55, normal: 70, fast: 83 };

/** Approximate park entrances (main gates on the central plaza). */
export const PARK_ENTRANCES: Readonly<Record<ParkId, Position>> = {
  dlp: { lat: 48.8703, lon: 2.7797, park: 'dlp' },
  daw: { lat: 48.8681, lon: 2.7797, park: 'daw' },
};

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface WalkOptions {
  readonly pace: Pace;
  readonly stroller: boolean;
}

/** Network walking distance in metres (OpenStreetMap footways), or null when unknown. */
export type NetworkFn = (a: GeoPoint, b: GeoPoint) => number | null;

/** A network distance far longer than the straight line signals bad data: ignore it. */
function trustedNetwork(a: GeoPoint, b: GeoPoint, network?: NetworkFn): number | null {
  const d = network?.(a, b) ?? null;
  return d !== null && d <= haversineM(a, b) * 4 + 300 ? d : null;
}

/** Leg length in metres: along the network when known, else straight line × detour factor. */
export function legMeters(a: GeoPoint, b: GeoPoint, network?: NetworkFn): number {
  return trustedNetwork(a, b, network) ?? haversineM(a, b) * DETOUR_FACTOR;
}

function speed(opts: WalkOptions): number {
  return SPEED_M_PER_MIN[opts.pace] / (opts.stroller ? STROLLER_FACTOR : 1);
}

/** Walking time in whole minutes (rounded up, 0 when already there). */
export function walkMinutes(from: Position, to: Position, opts: WalkOptions, network?: NetworkFn): number {
  let minutes: number;
  if (from.park === to.park) {
    minutes = legMeters(from, to, network) / speed(opts);
  } else {
    const direct = trustedNetwork(from, to, network);
    if (direct !== null) {
      minutes = direct / speed(opts) + PARK_SWITCH_PENALTY_MIN;
    } else {
      const exit = PARK_ENTRANCES[from.park];
      const entry = PARK_ENTRANCES[to.park];
      const meters = legMeters(from, exit, network) + legMeters(exit, entry, network) + legMeters(entry, to, network);
      minutes = meters / speed(opts) + PARK_SWITCH_PENALTY_MIN;
    }
  }
  return minutes < 0.5 ? 0 : Math.ceil(minutes);
}

/** Memoised walking matrix for one planning run. */
export function createWalkCache(opts: WalkOptions, network?: NetworkFn) {
  const cache = new Map<string, number>();
  return (fromKey: string, from: Position, toKey: string, to: Position): number => {
    const key = `${fromKey}>${toKey}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = walkMinutes(from, to, opts, network);
      cache.set(key, v);
    }
    return v;
  };
}
