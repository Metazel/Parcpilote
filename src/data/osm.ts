import type { PoiKind } from '../domain/types';
import type { CompactOsm } from '../domain/walkGraph';

type PoiTuple = [PoiKind, string, number, number];
import type { FetchFn } from './themeparks';
import { arr, int, isRecord, num, str } from './validate';

/**
 * OpenStreetMap data for the resort, fetched once from the Overpass API (fixed bounding box:
 * no user location is ever sent) and cached on the device in a compact, validated form.
 * Data © OpenStreetMap contributors, ODbL.
 */

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** South, West, North, East — both parks and the plaza between them. */
export const RESORT_BBOX = [48.8615, 2.768, 48.8785, 2.786] as const;
export const OSM_CACHE_KEY = 'parcpilote:osm:v1';
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

export function overpassQuery(): string {
  const bbox = RESORT_BBOX.join(',');
  return [
    '[out:json][timeout:25];',
    '(',
    `way["highway"~"^(${[...WALKABLE].join('|')})$"](${bbox});`,
    `nw["amenity"~"^(${Object.keys(AMENITY).join('|')})$"](${bbox});`,
    ');',
    'out geom qt;',
  ].join('');
}

function inBbox(lat: number, lon: number): boolean {
  const [s, w, n, e] = RESORT_BBOX;
  return lat >= s - 0.01 && lat <= n + 0.01 && lon >= w - 0.01 && lon <= e + 0.01;
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
export function buildCompactOsm(json: unknown, fetchedAt: number): CompactOsm {
  if (!isRecord(json)) throw new Error('Réponse OpenStreetMap invalide');
  const elements = arr(json.elements, MAX_ELEMENTS);
  if (!elements) throw new Error('Réponse OpenStreetMap invalide');

  const index = new Map<number, number>();
  const lat: number[] = [];
  const lon: number[] = [];
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const edgeList: number[] = [];
  const pois: PoiTuple[] = [];

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
    const amenity = str(tags.amenity, 40);
    const kind = amenity ? AMENITY[amenity] : undefined;

    if (el.type === 'node' && kind) {
      const la = num(el.lat, -90, 90);
      const lo = num(el.lon, -180, 180);
      if (la !== null && lo !== null && inBbox(la, lo)) pois.push([kind, str(tags.name, MAX_NAME) ?? '', la, lo]);
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
      if (id === null || la === null || lo === null || !inBbox(la, lo)) {
        pts.length = 0;
        break;
      }
      pts.push({ id, lat: la, lon: lo });
    }
    if (pts.length === 0) continue;

    if (kind) {
      // Amenity mapped as a building outline: use its centroid.
      const c = pts.reduce((a, p) => ({ lat: a.lat + p.lat / pts.length, lon: a.lon + p.lon / pts.length }), { lat: 0, lon: 0 });
      pois.push([kind, str(tags.name, MAX_NAME) ?? '', c.lat, c.lon]);
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
  return keepMainComponent({ v: 1, fetchedAt, lat, lon, edges: edgeList, names, pois });
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
  if (!isRecord(v) || v.v !== 1) return null;
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
    if (la === null || lo === null || !inBbox(la, lo)) return null;
  }
  for (let e = 0; e < edges.length; e += 3) {
    if (int(edges[e], 0, n - 1) === null || int(edges[e + 1], 0, n - 1) === null || int(edges[e + 2], -1, names.length - 1) === null) return null;
  }
  if (!names.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_NAME)) return null;
  const cleanPois: PoiTuple[] = [];
  for (const p of pois) {
    if (!Array.isArray(p) || p.length !== 4) continue;
    const kind = p[0] === 'toilets' || p[0] === 'food' || p[0] === 'water' ? p[0] : null;
    const name = typeof p[1] === 'string' && p[1].length <= MAX_NAME ? p[1] : null;
    const la = num(p[2], -90, 90);
    const lo = num(p[3], -180, 180);
    if (kind && name !== null && la !== null && lo !== null && inBbox(la, lo)) cleanPois.push([kind, name, la, lo]);
  }
  return { v: 1, fetchedAt, lat: lat as number[], lon: lon as number[], edges: edges as number[], names: names as string[], pois: cleanPois };
}

export async function fetchOsm(fetchFn: FetchFn, now: number): Promise<CompactOsm> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(`${OVERPASS_URL}?data=${encodeURIComponent(overpassQuery())}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return buildCompactOsm(await res.json(), now);
  } finally {
    clearTimeout(timer);
  }
}
