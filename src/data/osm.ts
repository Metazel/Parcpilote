import type { FoodService, PoiKind } from '../domain/types';
import type { Bbox, CompactOsm, CompactPoi, CompactSight } from '../domain/walkGraph';
import type { GeoPoint } from '../domain/types';
import type { FetchFn } from './themeparks';
import { arr, int, isRecord, num, safeUrl, str } from './validate';

/**
 * OpenStreetMap data for the visited park, fetched once from the Overpass API (a fixed area
 * around the park: no user location is ever sent) and cached on the device in a compact,
 * validated form, one cache per destination. Data © OpenStreetMap contributors, ODbL.
 */

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** South, West, North, East — Disneyland Paris: both parks and the plaza between them. */
export const RESORT_BBOX: Bbox = [48.8615, 2.768, 48.8785, 2.786];
/** v3: one cache per destination, area stored with the data (older caches are fetched again). */
export const OSM_CACHE_PREFIX = 'parcpilote:osm:v3:';
/** Cache of the Disneyland Paris data (kept for compatibility with tests and tools). */
export const OSM_CACHE_KEY = `${OSM_CACHE_PREFIX}dlp`;
/** Largest area accepted (degrees), against tampered caches. */
const MAX_SPAN_DEG = 0.1;
export const OSM_MAX_AGE_MS = 30 * 24 * 3_600_000;

const MAX_ELEMENTS = 150_000;
const MAX_NODES = 80_000;
const MAX_NAME = 120;
const TIMEOUT_MS = 30_000;

const WALKABLE = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street', 'service', 'corridor', 'track', 'residential', 'unclassified', 'cycleway']);
const AMENITY: Readonly<Record<string, PoiKind>> = {
  toilets: 'toilets',
  restaurant: 'food',
  fast_food: 'food',
  cafe: 'food',
  ice_cream: 'food',
  food_court: 'food',
  drinking_water: 'water',
};
/** Seated restaurants vs counters, kiosks and food trucks. */
const SERVICE: Readonly<Record<string, FoodService>> = { restaurant: 'table', fast_food: 'quick', cafe: 'quick', ice_cream: 'quick', food_court: 'quick' };
const PICNIC = new Set(['picnic_table', 'picnic_site']);

/** POI kind and food service of an OpenStreetMap element, or null. */
function poiOf(tags: Record<string, unknown>): { kind: PoiKind; service: FoodService | '' } | null {
  const amenity = str(tags.amenity, 40);
  const kind = amenity ? AMENITY[amenity] : undefined;
  if (kind) return { kind, service: (amenity && SERVICE[amenity]) || '' };
  const leisure = str(tags.leisure, 40);
  if ((leisure && PICNIC.has(leisure)) || str(tags.tourism, 40) === 'picnic_site') return { kind: 'picnic', service: '' };
  return null;
}

/** Menu first, then the place's own website; https only. */
function linkOf(tags: Record<string, unknown>): string {
  return safeUrl(tags['website:menu']) ?? safeUrl(tags.menu) ?? safeUrl(tags.website) ?? safeUrl(tags['contact:website']) ?? '';
}

/** Square area of `radiusM` around a point. */
export function bboxAround(c: GeoPoint, radiusM: number): Bbox {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return [r(c.lat - dLat), r(c.lon - dLon), r(c.lat + dLat), r(c.lon + dLon)];
}

/** Overpass query; `sights` adds named attractions and theatres (manual-mode catalogue). */
export function overpassQuery(area: Bbox = RESORT_BBOX, sights = false): string {
  const bbox = area.join(',');
  return [
    '[out:json][timeout:25];',
    '(',
    `way["highway"~"^(${[...WALKABLE].join('|')})$"](${bbox});`,
    `nw["amenity"~"^(${Object.keys(AMENITY).join('|')})$"](${bbox});`,
    `nw["leisure"~"^(${[...PICNIC].join('|')})$"](${bbox});`,
    `nw["tourism"="picnic_site"](${bbox});`,
    ...(sights ? [`nw["attraction"]["name"](${bbox});`, `nw["tourism"="attraction"]["name"](${bbox});`, `nw["amenity"="theatre"]["name"](${bbox});`] : []),
    ');',
    'out geom qt;',
  ].join('');
}

function inBbox(area: Bbox, lat: number, lon: number): boolean {
  const [s, w, n, e] = area;
  return lat >= s - 0.01 && lat <= n + 0.01 && lon >= w - 0.01 && lon <= e + 0.01;
}

/** A named attraction or theatre, with a ride/show hint. */
function sightOf(tags: Record<string, unknown>): 'ride' | 'show' | null {
  if (!str(tags.name, MAX_NAME)) return null;
  if (str(tags.amenity, 40) === 'theatre') return 'show';
  return str(tags.attraction, 40) || str(tags.tourism, 40) === 'attraction' ? 'ride' : null;
}

function walkable(tags: Record<string, unknown>): boolean {
  const highway = str(tags.highway, 40);
  if (!highway || !WALKABLE.has(highway)) return false;
  const foot = str(tags.foot, 40);
  if (foot === 'no') return false;
  const access = str(tags.access, 40);
  const footOk = foot === 'yes' || foot === 'designated' || foot === 'permissive';
  // Backstage roads are mapped access=private: never route guests through them.
  return !(access === 'private' || access === 'no') || footOk;
}

/** Turns an Overpass JSON response into the compact routing + POI form (main component only). */
export function buildCompactOsm(json: unknown, fetchedAt: number, area: Bbox = RESORT_BBOX): CompactOsm {
  if (!isRecord(json)) throw new Error('Réponse OpenStreetMap invalide');
  const elements = arr(json.elements, MAX_ELEMENTS);
  if (!elements) throw new Error('Réponse OpenStreetMap invalide');

  const index = new Map<number, number>();
  const lat: number[] = [];
  const lon: number[] = [];
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const edgeList: number[] = [];
  const pois: CompactPoi[] = [];
  const sights: CompactSight[] = [];
  const inArea = (la: number, lo: number) => inBbox(area, la, lo);

  const nodeIdx = (id: number, la: number, lo: number): number => {
    let i = index.get(id);
    if (i === undefined) {
      i = lat.length;
      index.set(id, i);
      lat.push(Math.round(la * 1e6) / 1e6);
      lon.push(Math.round(lo * 1e6) / 1e6);
    }
    return i;
  };

  for (const el of elements) {
    if (!isRecord(el)) continue;
    const tags = isRecord(el.tags) ? el.tags : {};
    const poi = poiOf(tags);
    const kind = poi?.kind;
    const sight = poi ? null : sightOf(tags);
    if (sight && el.type === 'node') {
      const la = num(el.lat, -90, 90);
      const lo = num(el.lon, -180, 180);
      if (la !== null && lo !== null && inArea(la, lo)) sights.push([str(tags.name, MAX_NAME)!, la, lo, sight]);
      continue;
    }

    if (el.type === 'node' && poi) {
      const la = num(el.lat, -90, 90);
      const lo = num(el.lon, -180, 180);
      if (la !== null && lo !== null && inArea(la, lo)) pois.push([poi.kind, str(tags.name, MAX_NAME) ?? '', la, lo, poi.service, linkOf(tags)]);
      continue;
    }
    if (el.type !== 'way') continue;
    const geometry = arr(el.geometry, 5000);
    const nodes = arr(el.nodes, 5000);
    if (!geometry || !nodes || geometry.length !== nodes.length || geometry.length < 1) continue;
    const pts: Array<{ id: number; lat: number; lon: number }> = [];
    for (let k = 0; k < geometry.length; k++) {
      const g = geometry[k];
      const id = int(nodes[k], 1, Number.MAX_SAFE_INTEGER);
      const la = isRecord(g) ? num(g.lat, -90, 90) : null;
      const lo = isRecord(g) ? num(g.lon, -180, 180) : null;
      if (id === null || la === null || lo === null || !inArea(la, lo)) {
        pts.length = 0;
        break;
      }
      pts.push({ id, lat: la, lon: lo });
    }
    if (pts.length === 0) continue;

    if ((poi && kind) || sight) {
      // Mapped as an outline: use its centroid.
      const c = pts.reduce((a, p) => ({ lat: a.lat + p.lat / pts.length, lon: a.lon + p.lon / pts.length }), { lat: 0, lon: 0 });
      if (poi && kind) pois.push([kind, str(tags.name, MAX_NAME) ?? '', c.lat, c.lon, poi.service, linkOf(tags)]);
      else if (sight) sights.push([str(tags.name, MAX_NAME)!, c.lat, c.lon, sight]);
      if (!walkable(tags)) continue;
    }
    if (!walkable(tags) || pts.length < 2) continue;
    const name = str(tags.name, MAX_NAME);
    let ni = -1;
    if (name) {
      ni = nameIndex.get(name) ?? -1;
      if (ni === -1) {
        ni = names.length;
        names.push(name);
        nameIndex.set(name, ni);
      }
    }
    for (let k = 1; k < pts.length; k++) {
      const a = nodeIdx(pts[k - 1]!.id, pts[k - 1]!.lat, pts[k - 1]!.lon);
      const b = nodeIdx(pts[k]!.id, pts[k]!.lat, pts[k]!.lon);
      if (a !== b) edgeList.push(a, b, ni);
    }
    if (lat.length > MAX_NODES) throw new Error('Données OpenStreetMap trop volumineuses');
  }
  return keepMainComponent({ v: 3, bbox: area, fetchedAt, lat, lon, edges: edgeList, names, pois, sights });
}

/** Drops disconnected fragments so that every snapped point can reach every other one. */
export function keepMainComponent(data: CompactOsm): CompactOsm {
  const n = data.lat.length;
  if (n === 0) return data;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 3) {
    const a = data.edges[e]!;
    const b = data.edges[e + 1]!;
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  const comp = new Int32Array(n).fill(-1);
  let best = -1;
  let bestSize = 0;
  for (let s = 0, c = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const v of adj[u]!) {
        if (comp[v] === -1) {
          comp[v] = c;
          stack.push(v);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  const remap = new Int32Array(n).fill(-1);
  const lat: number[] = [];
  const lon: number[] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] !== best) continue;
    remap[i] = lat.length;
    lat.push(data.lat[i]!);
    lon.push(data.lon[i]!);
  }
  const edges: number[] = [];
  for (let e = 0; e < data.edges.length; e += 3) {
    const a = remap[data.edges[e]!]!;
    const b = remap[data.edges[e + 1]!]!;
    if (a >= 0 && b >= 0) edges.push(a, b, data.edges[e + 2]!);
  }
  return { ...data, lat, lon, edges };
}

/** Validates a cached compact form (untrusted: it comes back from localStorage). */
export function parseCompactOsm(v: unknown, now: number): CompactOsm | null {
  if (!isRecord(v) || v.v !== 3) return null;
  const bb = arr(v.bbox, 4);
  const area = bb && bb.length === 4 ? (bb.map((x, i) => num(x, i % 2 === 0 ? -90 : -180, i % 2 === 0 ? 90 : 180)) as Array<number | null>) : null;
  if (!area || area.some((x) => x === null)) return null;
  const [s0, w0, n0, e0] = area as number[];
  if (!(n0! > s0! && e0! > w0! && n0! - s0! <= MAX_SPAN_DEG && e0! - w0! <= MAX_SPAN_DEG)) return null;
  const bbox: Bbox = [s0!, w0!, n0!, e0!];
  const fetchedAt = int(v.fetchedAt, Date.UTC(2020, 0, 1), now + 60_000);
  if (fetchedAt === null || now - fetchedAt > OSM_MAX_AGE_MS) return null;
  const lat = arr(v.lat, MAX_NODES);
  const lon = arr(v.lon, MAX_NODES);
  const edges = arr(v.edges, MAX_NODES * 12);
  const names = arr(v.names, 5000);
  const pois = arr(v.pois, 5000);
  if (!lat || !lon || !edges || !names || !pois || lat.length !== lon.length || edges.length % 3 !== 0) return null;
  const n = lat.length;
  for (let i = 0; i < n; i++) {
    const la = num(lat[i], -90, 90);
    const lo = num(lon[i], -180, 180);
    if (la === null || lo === null || !inBbox(bbox, la, lo)) return null;
  }
  for (let e = 0; e < edges.length; e += 3) {
    if (int(edges[e], 0, n - 1) === null || int(edges[e + 1], 0, n - 1) === null || int(edges[e + 2], -1, names.length - 1) === null) return null;
  }
  if (!names.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_NAME)) return null;
  const cleanPois: CompactPoi[] = [];
  for (const p of pois) {
    if (!Array.isArray(p) || p.length !== 6) continue;
    const kind = p[0] === 'toilets' || p[0] === 'food' || p[0] === 'water' || p[0] === 'picnic' ? p[0] : null;
    const name = typeof p[1] === 'string' && p[1].length <= MAX_NAME ? p[1] : null;
    const la = num(p[2], -90, 90);
    const lo = num(p[3], -180, 180);
    const service = p[4] === 'quick' || p[4] === 'table' ? p[4] : p[4] === '' ? '' : null;
    const url = p[5] === '' ? '' : safeUrl(p[5]);
    if (kind && name !== null && la !== null && lo !== null && service !== null && url !== null && inBbox(bbox, la, lo)) cleanPois.push([kind, name, la, lo, service, url]);
  }
  const cleanSights: CompactSight[] = [];
  for (const g of arr(v.sights, 2000) ?? []) {
    if (!Array.isArray(g) || g.length !== 4) continue;
    const name = str(g[0], MAX_NAME);
    const la = num(g[1], -90, 90);
    const lo = num(g[2], -180, 180);
    const hint = g[3] === 'ride' || g[3] === 'show' ? g[3] : null;
    if (name && la !== null && lo !== null && hint && inBbox(bbox, la, lo)) cleanSights.push([name, la, lo, hint]);
  }
  return { v: 3, bbox, sights: cleanSights, fetchedAt, lat: lat as number[], lon: lon as number[], edges: edges as number[], names: names as string[], pois: cleanPois };
}

export async function fetchOsm(fetchFn: FetchFn, now: number, area: Bbox = RESORT_BBOX, sights = false): Promise<CompactOsm> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(`${OVERPASS_URL}?data=${encodeURIComponent(overpassQuery(area, sights))}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return buildCompactOsm(await res.json(), now, area);
  } finally {
    clearTimeout(timer);
  }
}
