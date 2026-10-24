import { haversineM } from './geo';
import type { FoodService, GeoPoint, PoiKind } from './types';

/**
 * Pedestrian network built from OpenStreetMap footways: shortest paths (Dijkstra) between
 * any two points, snapped to the nearest walkable node. Pure, no I/O.
 */

/** Compact, serialisable network: node coordinates, edge triples [a, b, nameIndex|-1], POIs. */
/** POI: kind, name, lat, lon, food service ('' when not food), https link ('' when none). */
export type CompactPoi = readonly [PoiKind, string, number, number, FoodService | '', string];

/** Named attraction or show (manual-mode catalogue): name, lat, lon, kind hint. */
export type CompactSight = readonly [string, number, number, 'ride' | 'show'];

/** South, West, North, East. */
export type Bbox = readonly [number, number, number, number];

export interface CompactOsm {
  readonly v: 3;
  /** Area the data was fetched for (positions are checked against it). */
  readonly bbox: Bbox;
  readonly fetchedAt: number;
  readonly lat: readonly number[];
  readonly lon: readonly number[];
  readonly edges: readonly number[];
  readonly names: readonly string[];
  readonly pois: readonly CompactPoi[];
  readonly sights: readonly CompactSight[];
}

export interface Route {
  readonly meters: number;
  readonly points: readonly GeoPoint[];
  /** Named ways along the route, in order, without repeats. */
  readonly via: readonly string[];
}

/** Snapping further than this falls back to the straight-line model. */
const MAX_SNAP_M = 250;
const CELL_DEG = 0.0005;
const CACHE_SOURCES = 64;

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0]!, v[0]!];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= k.length) break;
        const r = l + 1;
        const c = r < k.length && k[r]! < k[l]! ? r : l;
        if (k[c]! >= lastK) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

interface Tree {
  readonly dist: Float64Array;
  readonly prev: Int32Array;
  readonly prevName: Int32Array;
}

export class WalkGraph {
  readonly nodeCount: number;
  private readonly lat: Float64Array;
  private readonly lon: Float64Array;
  private readonly offsets: Int32Array;
  private readonly targets: Int32Array;
  private readonly weights: Float64Array;
  private readonly edgeNames: Int32Array;
  private readonly names: readonly string[];
  private readonly grid = new Map<string, number[]>();
  private readonly trees = new Map<number, Tree>();

  constructor(data: CompactOsm) {
    const n = data.lat.length;
    this.nodeCount = n;
    this.names = data.names;
    this.lat = Float64Array.from(data.lat);
    this.lon = Float64Array.from(data.lon);
    const degree = new Int32Array(n);
    for (let e = 0; e < data.edges.length; e += 3) {
      degree[data.edges[e]!]!++;
      degree[data.edges[e + 1]!]!++;
    }
    this.offsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i]! + degree[i]!;
    const m = this.offsets[n]!;
    this.targets = new Int32Array(m);
    this.weights = new Float64Array(m);
    this.edgeNames = new Int32Array(m);
    const fill = this.offsets.slice(0, n);
    for (let e = 0; e < data.edges.length; e += 3) {
      const a = data.edges[e]!;
      const b = data.edges[e + 1]!;
      const name = data.edges[e + 2]!;
      const w = haversineM({ lat: this.lat[a]!, lon: this.lon[a]! }, { lat: this.lat[b]!, lon: this.lon[b]! });
      for (const [u, v] of [
        [a, b],
        [b, a],
      ] as const) {
        const slot = fill[u]!++;
        this.targets[slot] = v;
        this.weights[slot] = w;
        this.edgeNames[slot] = name;
      }
    }
    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.lat[i]!, this.lon[i]!);
      const cell = this.grid.get(key);
      if (cell) cell.push(i);
      else this.grid.set(key, [i]);
    }
  }

  private cellKey(lat: number, lon: number): string {
    return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
  }

  /** Nearest network node and its distance, or null beyond the snapping limit. */
  nearest(p: GeoPoint): { node: number; meters: number } | null {
    const cy = Math.floor(p.lat / CELL_DEG);
    const cx = Math.floor(p.lon / CELL_DEG);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= 6; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const i of this.grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
            const d = haversineM(p, { lat: this.lat[i]!, lon: this.lon[i]! });
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Cells are ≥ 37 m wide: once a match is closer than the ring radius, stop.
      if (best >= 0 && bestD <= ring * 37) break;
    }
    return best >= 0 && bestD <= MAX_SNAP_M ? { node: best, meters: bestD } : null;
  }

  private tree(src: number): Tree {
    const cached = this.trees.get(src);
    if (cached) {
      this.trees.delete(src);
      this.trees.set(src, cached);
      return cached;
    }
    const n = this.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevName = new Int32Array(n).fill(-1);
    dist[src] = 0;
    const heap = new MinHeap();
    heap.push(0, src);
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (d > dist[u]!) continue;
      for (let s = this.offsets[u]!; s < this.offsets[u + 1]!; s++) {
        const v = this.targets[s]!;
        const nd = d + this.weights[s]!;
        if (nd < dist[v]!) {
          dist[v] = nd;
          prev[v] = u;
          prevName[v] = this.edgeNames[s]!;
          heap.push(nd, v);
        }
      }
    }
    const tree = { dist, prev, prevName };
    this.trees.set(src, tree);
    if (this.trees.size > CACHE_SOURCES) this.trees.delete(this.trees.keys().next().value!);
    return tree;
  }

  /** Walking distance in metres along the network, or null when either end cannot be snapped. */
  distanceM(a: GeoPoint, b: GeoPoint): number | null {
    const sa = this.nearest(a);
    const sb = this.nearest(b);
    if (!sa || !sb) return null;
    const d = this.tree(sa.node).dist[sb.node]!;
    return Number.isFinite(d) ? d + sa.meters + sb.meters : null;
  }

  /** Full route geometry with the named ways it follows. */
  route(a: GeoPoint, b: GeoPoint): Route | null {
    const sa = this.nearest(a);
    const sb = this.nearest(b);
    if (!sa || !sb) return null;
    const t = this.tree(sa.node);
    if (!Number.isFinite(t.dist[sb.node]!)) return null;
    const nodes: number[] = [];
    const via: string[] = [];
    for (let v = sb.node; v !== -1; v = t.prev[v]!) {
      nodes.push(v);
      const name = t.prevName[v]!;
      if (name >= 0) {
        const label = this.names[name]!;
        if (via[via.length - 1] !== label) via.push(label);
      }
    }
    nodes.reverse();
    via.reverse();
    const points: GeoPoint[] = [a, ...nodes.map((i) => ({ lat: this.lat[i]!, lon: this.lon[i]! })), b];
    return { meters: t.dist[sb.node]! + sa.meters + sb.meters, points, via: via.filter((v, i) => via.indexOf(v) === i) };
  }

  /** Network edges as segments, for drawing the footways when the base map is unavailable. */
  segments(): Array<[GeoPoint, GeoPoint]> {
    const out: Array<[GeoPoint, GeoPoint]> = [];
    for (let u = 0; u < this.nodeCount; u++) {
      for (let s = this.offsets[u]!; s < this.offsets[u + 1]!; s++) {
        const v = this.targets[s]!;
        if (v > u) out.push([{ lat: this.lat[u]!, lon: this.lon[u]! }, { lat: this.lat[v]!, lon: this.lon[v]! }]);
      }
    }
    return out;
  }
}
