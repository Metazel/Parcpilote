import { parkDateKey, parkWallTime } from '../domain/time';
import type { Attraction, LiveAttraction, LiveSnapshot, ParkHours, ParkInfo, Place, Show } from '../domain/types';
import type { CompactSight } from '../domain/walkGraph';
import type { CatalogCache, CustomPlace, DayProgress } from '../state/storage';
import { normalizeName } from './catalog';
import { hashString } from './demo';
import { type DestinationDef, destination } from './destinations';
import { usualHours } from './themeparks';

/**
 * Manual mode: parks without a live feed (Puy du Fou, Parc Spirou), or a live park while its
 * feed is down. Waits are estimates the visitor corrects with what they see on site; show
 * sessions and the day's hours are entered by the visitor.
 */

/** Estimated standby when nothing better is known (minutes). */
export const MANUAL_WAIT_MIN = 15;
const SHOW_DURATION_MIN = 30;
const RIDE_DURATION_MIN = 5;
const SHOW_ARRIVE_BEFORE = { low: 15, mid: 25, high: 35 } as const;
export const CUSTOM_LAND = 'Ajoutés par vous';

/** The destination's own parks (manual parks are single-park). */
export function defParks(def: DestinationDef): ParkInfo[] {
  return def.parks.map((k, i) => ({ id: k.id, name: k.name, short: k.short, entrance: k.entrance, color: i }));
}

function place(kind: 'ride' | 'show', id: string, name: string, park: ParkInfo, land: string, at: { lat: number; lon: number }, durationMin?: number): Place {
  return kind === 'show'
    ? ({ kind, id, name, park: park.id, land, lat: at.lat, lon: at.lon, durationMin: durationMin ?? SHOW_DURATION_MIN, arriveBeforeMin: SHOW_ARRIVE_BEFORE } satisfies Show)
    : ({ kind, id, name, park: park.id, land, lat: at.lat, lon: at.lon, durationMin: durationMin ?? RIDE_DURATION_MIN, minHeightCm: 0, singleRider: false, premierAccess: false, intensity: 1 } satisfies Attraction);
}

/** Visitor-added places of a destination, placed at the park gate. */
export function customPlaces(custom: readonly CustomPlace[], destId: string, park: ParkInfo): Place[] {
  return custom.filter((c) => c.dest === destId).map((c) => place(c.kind, c.id, c.name, park, CUSTOM_LAND, park.entrance, c.durationMin));
}

/** Catalogue of a park without live feed: named OpenStreetMap places, then visitor-added ones. */
export function manualCatalog(def: DestinationDef, sights: readonly CompactSight[], custom: readonly CustomPlace[]): Map<string, Place> {
  const parks = defParks(def);
  const park = parks[0]!;
  const out = new Map<string, Place>();
  const seen = new Set<string>();
  for (const [name, lat, lon, hint] of sights) {
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const id = `osm-${hashString(key).toString(36)}`;
    out.set(id, place(def.mainlyShows ? 'show' : hint, id, name, park, def.name, { lat, lon }));
  }
  for (const p of customPlaces(custom, def.id, park)) out.set(p.id, p);
  return out;
}

/** Catalogue of a live park from its last download, plus visitor-added places. */
export function cachedCatalog(cache: CatalogCache, custom: readonly CustomPlace[]): Map<string, Place> {
  const out = new Map<string, Place>(cache.places.map((p) => [p.id, p]));
  const park = cache.parks[0];
  if (park) for (const p of customPlaces(custom, cache.dest, park)) out.set(p.id, p);
  return out;
}

/** A snapshot built from estimates and the visitor's entries. */
export function manualSnapshot(
  now: number,
  catalog: ReadonlyMap<string, Place>,
  parks: readonly ParkInfo[],
  destId: string,
  day: Pick<DayProgress, 'manualShowtimes' | 'manualWaits' | 'manualHours'>,
): LiveSnapshot {
  const def = destination(destId);
  const today = parkDateKey(now);
  const hours: Record<string, ParkHours> = {};
  for (const p of parks) {
    const [o, c] = usualHours(def, p.id);
    hours[p.id] = day.manualHours ? { ...day.manualHours, emh: null } : { open: parkWallTime(now, o), close: parkWallTime(now, c), emh: null };
  }
  const attractions: Record<string, LiveAttraction> = {};
  const showtimes: Record<string, number[]> = {};
  for (const p of catalog.values()) {
    if (p.kind === 'show') {
      showtimes[p.id] = (day.manualShowtimes[p.id] ?? []).filter((t) => parkDateKey(t) === today);
      continue;
    }
    const h = hours[p.park] ?? Object.values(hours)[0];
    const open = h !== undefined && now < h.close;
    attractions[p.id] = open ? { status: 'OPERATING', standby: day.manualWaits[p.id] ?? MANUAL_WAIT_MIN, singleRider: null, pa: null } : { status: 'CLOSED', standby: null, singleRider: null, pa: null };
  }
  return { source: 'manual', fetchedAt: now, parks, attractions, showtimes, hours };
}
