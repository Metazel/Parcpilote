import { describe, expect, it } from 'vitest';
import { buildCompactOsm, keepMainComponent, overpassQuery, parseCompactOsm, RESORT_BBOX } from '../src/data/osm';
import { buildPois } from '../src/data/pois';
import { DETOUR_FACTOR, haversineM, legMeters, walkMinutes } from '../src/domain/geo';
import { WalkGraph } from '../src/domain/walkGraph';
import type { CompactOsm } from '../src/domain/walkGraph';
import { computePlan } from '../src/domain/planner';
import { overpassGrid } from './fixtures';
import { at, catalog, input } from './helpers';

const NOW = at(10);
const data = buildCompactOsm(overpassGrid(), NOW);
const graph = new WalkGraph(data);

describe('OpenStreetMap parsing', () => {
  it('builds a single connected walkable network, without backstage roads', () => {
    expect(data.lat.length).toBeGreaterThan(500);
    // Private service road nodes 5/6 and the detached fragment 7/8 are gone.
    expect(data.lat.some((la, i) => la === 48.8616 && data.lon[i] === 2.7681)).toBe(false);
    expect(data.names).toEqual(expect.arrayContaining(['Allée centrale', 'Promenade Est']));
  });

  it('keeps service points with defaults and centroids, drops invalid ones', () => {
    const kinds = data.pois.map((p) => p[0]);
    expect(kinds.filter((k) => k === 'toilets')).toHaveLength(2);
    expect(data.pois.find((p) => p[1] === 'Bistrot')?.[2]).toBeCloseTo(48.87257, 4);
    expect(data.pois.some((p) => p[1] === '' && p[0] === 'toilets')).toBe(true);
    expect(data.pois).toHaveLength(5);
  });

  it('rejects malformed responses', () => {
    expect(() => buildCompactOsm('oops', NOW)).toThrow();
    expect(() => buildCompactOsm({ elements: 'x' }, NOW)).toThrow();
  });

  it('asks only for the fixed resort area', () => {
    const q = overpassQuery();
    expect(q).toContain(RESORT_BBOX.join(','));
    expect(q).toContain('out geom');
  });

  it('round-trips through the device cache and rejects tampered or stale caches', () => {
    const back = parseCompactOsm(JSON.parse(JSON.stringify(data)), NOW);
    expect(back?.lat.length).toBe(data.lat.length);
    expect(parseCompactOsm({ ...data, edges: [0, 999_999, -1] }, NOW)).toBeNull();
    expect(parseCompactOsm({ ...data, lat: [...data.lat.slice(0, -1), 10] }, NOW)).toBeNull();
    expect(parseCompactOsm({ ...data, names: ['<script>'.repeat(30)] }, NOW)).toBeNull();
    expect(parseCompactOsm(data, NOW + 40 * 24 * 3_600_000)).toBeNull();
  });

  it('keeps the largest component', () => {
    const tiny: CompactOsm = { v: 1, fetchedAt: NOW, lat: [48.87, 48.8701, 48.8702, 48.875, 48.8751], lon: [2.77, 2.77, 2.77, 2.78, 2.78], edges: [0, 1, -1, 1, 2, -1, 3, 4, -1], names: [], pois: [] };
    expect(keepMainComponent(tiny).lat).toHaveLength(3);
  });
});

describe('walking network', () => {
  const a = { lat: 48.8702, lon: 2.7701 };
  const b = { lat: 48.8752, lon: 2.7801 };

  it('routes along footways (Manhattan distance on a grid)', () => {
    const d = graph.distanceM(a, b)!;
    const crow = haversineM(a, b);
    expect(d).toBeGreaterThan(crow);
    expect(d).toBeLessThan(crow * 1.5);
    const route = graph.route(a, b)!;
    expect(route.meters).toBeCloseTo(d, 3);
    expect(route.points[0]).toEqual(a);
    expect(route.points.at(-1)).toEqual(b);
    expect(route.points.length).toBeGreaterThan(10);
  });

  it('names the ways followed', () => {
    const r = graph.route({ lat: 48.872, lon: 2.7712 }, { lat: 48.872, lon: 2.7838 })!;
    expect(r.via).toContain('Allée centrale');
  });

  it('refuses to snap far outside the network', () => {
    expect(graph.distanceM({ lat: 48.9, lon: 2.9 }, b)).toBeNull();
  });

  it('feeds walking times, with a fallback when the network is unusable', () => {
    const pa = { ...a, park: 'dlp' as const };
    const pb = { ...b, park: 'dlp' as const };
    const opts = { pace: 'normal' as const, stroller: false };
    const network = (x: typeof a, y: typeof a) => graph.distanceM(x, y);
    expect(walkMinutes(pa, pb, opts, network)).toBe(Math.ceil(graph.distanceM(a, b)! / 70));
    // Absurd network value (bad data) → straight-line model.
    expect(legMeters(a, b, () => 1e7)).toBeCloseTo(haversineM(a, b) * DETOUR_FACTOR, 3);
    expect(legMeters(a, b, () => null)).toBeCloseTo(haversineM(a, b) * DETOUR_FACTOR, 3);
  });

  it('is used by the planner and stays fast', () => {
    const network = (x: { lat: number; lon: number }, y: { lat: number; lon: number }) => graph.distanceM(x, y);
    const wishList: Array<[string, 'must']> = ['dlp-big-thunder', 'dlp-peter-pan', 'dlp-buzz', 'dlp-pirates', 'daw-crush', 'daw-ratatouille'].map((id) => [id, 'must']);
    const t0 = performance.now();
    const plan = computePlan(input({ wishList, network }));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(plan.steps).toHaveLength(6);
    const first = plan.steps[0]!;
    const expected = walkMinutes(input().position, first.position, { pace: 'normal', stroller: false }, network);
    expect(first.walkMin).toBe(expected);
  });
});

describe('service points', () => {
  it('keeps in-park points, prefers official restaurants and names defaults', () => {
    const official = [{ park: 'dlp' as const, id: 'r1', name: 'Pizzeria Bella Notte', lat: 48.87451, lon: 2.77551 }];
    const pois = buildPois(data, official, catalog);
    expect(pois.find((p) => p.name === 'Hôtel lointain')).toBeUndefined();
    expect(pois.filter((p) => p.kind === 'food' && haversineM(p, official[0]!) < 35)).toHaveLength(1);
    expect(pois[0]).toMatchObject({ source: 'official', name: 'Pizzeria Bella Notte' });
    expect(pois.some((p) => p.kind === 'toilets' && p.name === 'Toilettes')).toBe(true);
    expect(pois.find((p) => p.name === 'Toilettes Worlds of Pixar')?.park).toBe('daw');
  });
});
