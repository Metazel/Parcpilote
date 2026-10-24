import { PARK_ENTRANCES, haversineM } from '../domain/geo';
import { parkDateKey, parkWallTime } from '../domain/time';
import type {
  Attraction,
  LiveAttraction,
  LiveSnapshot,
  PaState,
  ParkHours,
  ParkId,
  Place,
  PremierAccessOffer,
  RideStatus,
  Show,
  TimeWindow,
} from '../domain/types';
import { normalizeName } from './catalog';
import { arr, int, isRecord, isoTime, num, oneOf, safeId, str } from './validate';

/**
 * Adapter for the ThemeParks.wiki public API (https://api.themeparks.wiki/v1).
 * Every response is validated field by field; unknown or malformed entries are dropped.
 */

export const API_BASE = 'https://api.themeparks.wiki/v1';
const TIMEOUT_MS = 10_000;
/** Ignore API coordinates further than this from the park gate (bad data guard). */
const MAX_DISTANCE_FROM_GATE_M = 3_000;

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class LiveDataError extends Error {
  override readonly name = 'LiveDataError';
}

async function getJson(fetchFn: FetchFn, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(`${API_BASE}${path}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new LiveDataError(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof LiveDataError) throw e;
    throw new LiveDataError(controller.signal.aborted ? 'Délai dépassé' : 'Réseau indisponible');
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiPark {
  readonly id: string;
  readonly park: ParkId;
}

export function parkIdFromName(name: string): ParkId | null {
  const n = normalizeName(name);
  if (/adventure world|studios/.test(n)) return 'daw';
  if (/disneyland park|parc disneyland/.test(n)) return 'dlp';
  return null;
}

export function parseDestinations(json: unknown): ApiPark[] {
  if (!isRecord(json)) throw new LiveDataError('Réponse destinations invalide');
  const list = arr(json.destinations) ?? [];
  for (const d of list) {
    if (!isRecord(d)) continue;
    const label = `${str(d.slug) ?? ''} ${str(d.name) ?? ''}`.toLowerCase();
    if (!/disneyland ?paris/.test(label.replace(/[-_]/g, ' ')) && !label.includes('disneylandparis')) continue;
    const parks: ApiPark[] = [];
    for (const p of arr(d.parks, 20) ?? []) {
      if (!isRecord(p)) continue;
      const id = safeId(p.id);
      const park = parkIdFromName(str(p.name) ?? '');
      if (id && park && !parks.some((x) => x.park === park)) parks.push({ id, park });
    }
    if (parks.length > 0) return parks;
  }
  throw new LiveDataError('Disneyland Paris introuvable dans l’API');
}

export interface ApiEntity {
  readonly id: string;
  readonly name: string;
  readonly type: 'ATTRACTION' | 'SHOW' | 'RESTAURANT';
  readonly lat: number | null;
  readonly lon: number | null;
}

export function parseChildren(json: unknown): ApiEntity[] {
  if (!isRecord(json)) throw new LiveDataError('Réponse entités invalide');
  const out: ApiEntity[] = [];
  for (const c of arr(json.children) ?? []) {
    if (!isRecord(c)) continue;
    const id = safeId(c.id);
    const name = str(c.name, 120);
    const type = oneOf(c.entityType, ['ATTRACTION', 'SHOW', 'RESTAURANT'] as const);
    if (!id || !name || !type) continue;
    const loc = isRecord(c.location) ? c.location : null;
    out.push({ id, name, type, lat: loc ? num(loc.latitude, -90, 90) : null, lon: loc ? num(loc.longitude, -180, 180) : null });
  }
  return out;
}

export interface ApiLive {
  readonly id: string;
  readonly name: string;
  readonly type: 'ATTRACTION' | 'SHOW';
  readonly status: RideStatus;
  readonly standby: number | null;
  readonly singleRider: number | null;
  readonly pa: PremierAccessOffer | null;
  readonly showtimes: number[];
}

function parsePa(v: unknown): PremierAccessOffer | null {
  if (!isRecord(v)) return null;
  const state = oneOf(v.state, ['AVAILABLE', 'TEMP_FULL', 'FINISHED'] as const satisfies readonly PaState[]);
  if (!state) return null;
  const price = isRecord(v.price) ? v.price : null;
  // ThemeParks.wiki prices are expressed in minor units (cents).
  const amount = price && (price.currency === undefined || price.currency === 'EUR') ? int(price.amount, 0, 100_000) : null;
  return { state, priceCents: amount, returnStart: isoTime(v.returnStart), returnEnd: isoTime(v.returnEnd) };
}

export function parseLive(json: unknown): ApiLive[] {
  if (!isRecord(json)) throw new LiveDataError('Réponse temps réel invalide');
  const out: ApiLive[] = [];
  for (const e of arr(json.liveData) ?? []) {
    if (!isRecord(e)) continue;
    const id = safeId(e.id) ?? safeId(e.entityId);
    const name = str(e.name, 120);
    const type = oneOf(e.entityType, ['ATTRACTION', 'SHOW'] as const);
    const status = oneOf(e.status, ['OPERATING', 'DOWN', 'CLOSED', 'REFURBISHMENT'] as const);
    if (!id || !name || !type || !status) continue;
    const queue = isRecord(e.queue) ? e.queue : {};
    const wait = (q: unknown) => (isRecord(q) ? int(q.waitTime, 0, 600) : null);
    const showtimes: number[] = [];
    for (const s of arr(e.showtimes, 200) ?? []) {
      const t = isRecord(s) ? isoTime(s.startTime) : null;
      if (t !== null) showtimes.push(t);
    }
    out.push({
      id,
      name,
      type,
      status,
      standby: wait(queue.STANDBY),
      singleRider: wait(queue.SINGLE_RIDER),
      pa: parsePa(queue.PAID_RETURN_TIME),
      showtimes,
    });
  }
  return out;
}

/** Today's opening hours, with Extra Magic Hours (EXTRA_HOURS entries) when announced. */
export function parseSchedule(json: unknown, now: number): ParkHours | null {
  if (!isRecord(json)) return null;
  const today = parkDateKey(now);
  const windows = { OPERATING: null as TimeWindow | null, EXTRA_HOURS: null as TimeWindow | null };
  for (const s of arr(json.schedule) ?? []) {
    if (!isRecord(s) || str(s.date, 10) !== today) continue;
    const type = oneOf(s.type, ['OPERATING', 'EXTRA_HOURS'] as const);
    const o = isoTime(s.openingTime);
    const c = isoTime(s.closingTime);
    if (!type || o === null || c === null || c <= o) continue;
    const prev = windows[type];
    windows[type] = prev ? { open: Math.min(prev.open, o), close: Math.max(prev.close, c) } : { open: o, close: c };
  }
  const op = windows.OPERATING;
  return op ? { open: op.open, close: op.close, emh: windows.EXTRA_HOURS } : null;
}

const SINGLE_RIDER_SUFFIX = / single rider$/;

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length > 2));
}

/** True when two normalized names designate the same attraction. */
export function namesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a))) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.5;
}

export interface MergeResult {
  readonly catalog: Map<string, Place>;
  /** API entity id → catalog id. Single-rider twins map to their ride with `single: true`. */
  readonly idMap: Map<string, { id: string; single: boolean }>;
}

function sanePosition(park: ParkId, lat: number | null, lon: number | null): { lat: number; lon: number } | null {
  if (lat === null || lon === null) return null;
  return haversineM(PARK_ENTRANCES[park], { lat, lon }) <= MAX_DISTANCE_FROM_GATE_M ? { lat, lon } : null;
}

/** Merges API entities into the seed referential (seed enriches, API positions win). */
export function mergeCatalog(seed: ReadonlyMap<string, Place>, entities: ReadonlyArray<{ park: ParkId; entity: ApiEntity }>): MergeResult {
  const catalog = new Map(seed);
  const idMap = new Map<string, { id: string; single: boolean }>();
  const seedByPark = [...seed.values()].map((p) => ({ p, key: normalizeName(p.name) }));

  for (const { park, entity } of entities) {
    if (entity.type === 'RESTAURANT') continue;
    let key = normalizeName(entity.name);
    const single = SINGLE_RIDER_SUFFIX.test(key);
    if (single) key = key.replace(SINGLE_RIDER_SUFFIX, '');
    const kind = entity.type === 'SHOW' ? 'show' : 'ride';
    const match = seedByPark.find((s) => s.p.park === park && s.p.kind === kind && namesMatch(s.key, key));
    const pos = sanePosition(park, entity.lat, entity.lon);

    if (match) {
      idMap.set(entity.id, { id: match.p.id, single });
      if (pos && !single) catalog.set(match.p.id, { ...match.p, ...pos });
      continue;
    }
    if (single) continue; // twin of an unknown ride: ignored
    const at = pos ?? PARK_ENTRANCES[park];
    const id = `api-${entity.id}`;
    const place: Place =
      kind === 'ride'
        ? ({ kind, id, name: entity.name, park, land: 'Autres', lat: at.lat, lon: at.lon, durationMin: 5, minHeightCm: 0, singleRider: false, premierAccess: false, intensity: 1 } satisfies Attraction)
        : ({ kind, id, name: entity.name, park, land: 'Autres', lat: at.lat, lon: at.lon, durationMin: 20, arriveBeforeMin: { low: 10, mid: 20, high: 30 } } satisfies Show);
    catalog.set(id, place);
    idMap.set(entity.id, { id, single: false });
  }
  return { catalog, idMap };
}

export const DEFAULT_HOURS: Readonly<Record<ParkId, readonly [number, number]>> = {
  dlp: [9 * 60 + 30, 22 * 60],
  daw: [9 * 60 + 30, 21 * 60],
};

export function buildSnapshot(
  merge: MergeResult,
  live: readonly ApiLive[],
  hours: Partial<Record<ParkId, ParkHours>>,
  now: number,
): LiveSnapshot {
  const attractions: Record<string, LiveAttraction> = {};
  const singles = new Map<string, number | null>();
  const showtimes: Record<string, number[]> = {};
  const today = parkDateKey(now);

  for (const e of live) {
    const target = merge.idMap.get(e.id);
    if (!target) continue;
    const place = merge.catalog.get(target.id);
    if (!place) continue;
    if (target.single) {
      singles.set(target.id, e.status === 'OPERATING' ? e.standby : null);
      continue;
    }
    if (place.kind === 'show') {
      const times = e.showtimes.filter((t) => parkDateKey(t) === today);
      showtimes[target.id] = [...new Set(times)].sort((a, b) => a - b);
      continue;
    }
    attractions[target.id] = { status: e.status, standby: e.standby, singleRider: e.singleRider, pa: e.pa };
    // Queue options published by the API win over the seed flags.
    const hasSingle = e.singleRider !== null;
    const hasPa = e.pa !== null;
    if (hasSingle !== place.singleRider || hasPa !== place.premierAccess) {
      merge.catalog.set(place.id, { ...place, singleRider: place.singleRider || hasSingle, premierAccess: place.premierAccess || hasPa });
    }
  }
  for (const [id, wait] of singles) {
    const a = attractions[id];
    const place = merge.catalog.get(id);
    if (a && a.singleRider === null) attractions[id] = { ...a, singleRider: wait };
    if (place?.kind === 'ride' && !place.singleRider) merge.catalog.set(id, { ...place, singleRider: true });
  }

  const fullHours = {} as Record<ParkId, ParkHours>;
  for (const park of ['dlp', 'daw'] as const) {
    const [o, c] = DEFAULT_HOURS[park];
    fullHours[park] = hours[park] ?? { open: parkWallTime(now, o), close: parkWallTime(now, c), emh: null };
  }
  return { source: 'live', fetchedAt: now, attractions, showtimes, hours: fullHours };
}

export interface LiveBundle {
  readonly catalog: Map<string, Place>;
  readonly snapshot: LiveSnapshot;
  /** Official restaurants with a usable position. */
  readonly restaurants: ReadonlyArray<{ readonly park: ParkId; readonly id: string; readonly name: string; readonly lat: number; readonly lon: number }>;
}

/** Full live load: destination discovery, then entities, live data and schedule per park. */
export async function loadLive(fetchFn: FetchFn, seed: ReadonlyMap<string, Place>, now: number): Promise<LiveBundle> {
  const parks = parseDestinations(await getJson(fetchFn, '/destinations'));
  const perPark = await Promise.all(
    parks.map(async ({ id, park }) => {
      const enc = encodeURIComponent(id);
      const [children, live, schedule] = await Promise.all([
        getJson(fetchFn, `/entity/${enc}/children`),
        getJson(fetchFn, `/entity/${enc}/live`),
        getJson(fetchFn, `/entity/${enc}/schedule`).catch(() => null),
      ]);
      return { park, children: parseChildren(children), live: parseLive(live), hours: parseSchedule(schedule, now) };
    }),
  );
  const merge = mergeCatalog(
    seed,
    perPark.flatMap((p) => p.children.map((entity) => ({ park: p.park, entity }))),
  );
  const hours: Partial<Record<ParkId, ParkHours>> = {};
  for (const p of perPark) if (p.hours) hours[p.park] = p.hours;
  const snapshot = buildSnapshot(merge, perPark.flatMap((p) => p.live), hours, now);
  if (Object.keys(snapshot.attractions).length === 0) throw new LiveDataError('Aucune donnée d’attente reçue');
  const restaurants: Array<LiveBundle['restaurants'][number]> = [];
  for (const p of perPark) {
    for (const e of p.children) {
      const pos = e.type === 'RESTAURANT' ? sanePosition(p.park, e.lat, e.lon) : null;
      if (pos) restaurants.push({ park: p.park, id: e.id, name: e.name, ...pos });
    }
  }
  return { catalog: merge.catalog, snapshot, restaurants };
}
