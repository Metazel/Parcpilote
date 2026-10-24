import { describe, expect, it } from 'vitest';
import { buildCompactOsm, parseCompactOsm } from '../src/data/osm';
import { buildPois } from '../src/data/pois';
import { DLP_DINING, officialService } from '../src/data/resort';
import { safeUrl } from '../src/data/validate';
import { DEFAULT_REENTRY_MIN, RESERVATION_GRACE_MIN, computePlan } from '../src/domain/planner';
import type { MealMode, MealPref, Poi } from '../src/domain/types';
import { DEFAULT_PROFILE, STORAGE_KEY, loadState } from '../src/state/storage';
import { MINUTE, MemoryStorage, at, catalog, input, profile } from './helpers';

const meal = (mode: MealMode, atMin = 12 * 60 + 30, durationMin = 45): MealPref => ({ enabled: true, atMin, durationMin, mode });

const poi = (id: string, kind: Poi['kind'], service: Poi['service'], lat: number, lon: number, extra: Partial<Poi> = {}): Poi => ({
  id,
  kind,
  name: id,
  lat,
  lon,
  park: 'dlp',
  source: 'osm',
  service,
  url: null,
  outside: false,
  ...extra,
});

// Fantasyland area (where the planned rides are) and the far end of Frontierland.
const NEAR_QUICK = poi('quick-near', 'food', 'quick', 48.8745, 2.7762);
const FAR_QUICK = poi('quick-far', 'food', 'quick', 48.8722, 2.7705);
const TABLE = poi('table-1', 'food', 'table', 48.8712, 2.7745, { url: 'https://example.org/menu' });
const PICNIC = poi('picnic-1', 'picnic', null, 48.8693, 2.7812, { outside: true });
const PLACES = [NEAR_QUICK, FAR_QUICK, TABLE, PICNIC];
const FANTASY = [
  ['dlp-peter-pan', 'must'],
  ['dlp-dumbo', 'nice'],
  ['dlp-casey-jr', 'nice'],
  ['dlp-blanche-neige', 'nice'],
] as Array<[string, 'must' | 'nice']>;

const mealStep = (plan: ReturnType<typeof computePlan>, slot = 'lunch') => plan.steps.find((s) => s.kind === 'meal' && s.meal?.slot === slot);

describe('meals in the plan', () => {
  it('keeps the v0.1 break where the group stands', () => {
    const plan = computePlan(input({ profile: profile({ lunch: meal('free') }), wishList: FANTASY, mealPlaces: PLACES }));
    const step = mealStep(plan)!;
    expect(step.targetId).toBe('');
    expect(step.walkMin).toBe(0);
    expect(step.meal).toMatchObject({ slot: 'lunch', mode: 'free' });
  });

  it('eats on the go at the nearest counter on the route', () => {
    const plan = computePlan(input({ profile: profile({ lunch: meal('quick', 12 * 60 + 30, 30) }), wishList: FANTASY, mealPlaces: PLACES }));
    const step = mealStep(plan)!;
    expect(step.targetId).toBe('quick-near');
    expect(step.startAt).toBeGreaterThanOrEqual(at(12, 30));
    expect(step.endAt - step.startAt).toBe(30 * MINUTE);
    // Never a seated restaurant or a picnic area for "sur le pouce".
    expect(['table-1', 'picnic-1']).not.toContain(step.targetId);
  });

  it('goes to the place the user picked, even if further', () => {
    const plan = computePlan(
      input({ profile: profile({ lunch: meal('quick') }), wishList: FANTASY, mealPlaces: PLACES, mealPicks: { lunch: { placeId: 'quick-far', reservationAt: null } } }),
    );
    expect(mealStep(plan)!.targetId).toBe('quick-far');
  });

  it('is at the table for the reservation, and reports it when it cannot be kept', () => {
    const resa = at(12, 45);
    const plan = computePlan(
      input({ profile: profile({ lunch: meal('table', 12 * 60, 75) }), wishList: FANTASY, mealPlaces: PLACES, mealPicks: { lunch: { placeId: 'table-1', reservationAt: resa } } }),
    );
    const step = mealStep(plan)!;
    expect(step.targetId).toBe('table-1');
    expect(step.startAt).toBe(resa);
    expect(step.meal).toMatchObject({ reservationAt: resa, url: 'https://example.org/menu' });
    expect(step.latestDepartAt).toBe(resa - step.walkMin * MINUTE);
    expect(plan.droppedAnchors).toEqual([]);

    // Booked for 10:05 while it is 10:00 at the far end of the resort: impossible.
    const late = computePlan(
      input({
        profile: profile({ lunch: meal('table', 11 * 60, 75) }),
        mealPlaces: PLACES,
        position: { lat: 48.8668, lon: 2.7811, park: 'daw' },
        positionKey: 'test-daw',
        mealPicks: { lunch: { placeId: 'table-1', reservationAt: at(10, 5) } },
      }),
    );
    expect(at(10, 5) + RESERVATION_GRACE_MIN * MINUTE).toBeLessThan(mealStep(late)!.arriveAt);
    expect(late.droppedAnchors.map((d) => d.id)).toContain('table-1');
  });

  it('counts the way out and back through security for a picnic outside the gates', () => {
    const plan = computePlan(input({ profile: profile({ lunch: meal('picnic', 12 * 60 + 30, 40) }), wishList: FANTASY, mealPlaces: PLACES }));
    const step = mealStep(plan)!;
    expect(step.targetId).toBe('picnic-1');
    expect(step.meal?.reentryMin).toBe(DEFAULT_REENTRY_MIN);
    expect(step.endAt - step.startAt).toBe((40 + DEFAULT_REENTRY_MIN) * MINUTE);
  });

  it('plans lunch and dinner, and skips a meal already taken', () => {
    const both = profile({ lunch: meal('quick', 12 * 60 + 30, 30), dinner: meal('quick', 19 * 60, 30) });
    const plan = computePlan(input({ profile: both, wishList: FANTASY, mealPlaces: PLACES }));
    expect(mealStep(plan, 'lunch')).toBeDefined();
    const dinner = mealStep(plan, 'dinner')!;
    expect(dinner.startAt).toBeGreaterThanOrEqual(at(19));
    const after = computePlan(input({ profile: both, wishList: FANTASY, mealPlaces: PLACES, lunchDone: true }));
    expect(mealStep(after, 'lunch')).toBeUndefined();
    expect(mealStep(after, 'dinner')).toBeDefined();
  });

  it('falls back to a break in place when no suitable place is known', () => {
    const plan = computePlan(input({ profile: profile({ lunch: meal('table') }), wishList: FANTASY, mealPlaces: [NEAR_QUICK] }));
    const step = mealStep(plan)!;
    expect(step.targetId).toBe('');
    expect(step.name).toBe('Pause déjeuner');
  });
});

describe('dining data', () => {
  it('classifies the official Disneyland Paris restaurants', () => {
    expect(officialService("Captain Jack's - Restaurant des Pirates")).toBe('table');
    expect(officialService('Auberge de Cendrillon')).toBe('table');
    expect(officialService('Bistrot Chez Rémy')).toBe('table');
    expect(officialService("Colonel Hathi's Pizza Outpost")).toBe('quick');
  });

  it('accepts only https links without credentials', () => {
    expect(safeUrl('https://www.example.org/menu?a=1')).toBe('https://www.example.org/menu?a=1');
    for (const bad of ['javascript:alert(1)', 'http://example.org', 'https://user:pw@example.org', 'data:text/html,x', 'https://localhost', 42, 'x'.repeat(400)]) {
      expect(safeUrl(bad)).toBeNull();
    }
  });

  it('reads picnic areas, food service and menu links from OpenStreetMap, safely', () => {
    const osm = buildCompactOsm(
      {
        elements: [
          { type: 'node', id: 1, lat: 48.8693, lon: 2.7812, tags: { leisure: 'picnic_site', name: 'Aire de pique-nique' } },
          { type: 'node', id: 2, lat: 48.8712, lon: 2.7745, tags: { amenity: 'restaurant', name: 'Table', 'website:menu': 'https://example.org/carte' } },
          { type: 'node', id: 3, lat: 48.8745, lon: 2.7762, tags: { amenity: 'fast_food', name: 'Tacos', website: 'javascript:alert(1)' } },
        ],
      },
      at(10),
    );
    expect(osm.pois).toEqual([
      ['picnic', 'Aire de pique-nique', 48.8693, 2.7812, '', ''],
      ['food', 'Table', 48.8712, 2.7745, 'table', 'https://example.org/carte'],
      ['food', 'Tacos', 48.8745, 2.7762, 'quick', ''],
    ]);
    // Older caches (v1) are refetched; tampered v2 entries are dropped.
    expect(parseCompactOsm({ ...osm, v: 1 }, at(11))).toBeNull();
    const tampered = parseCompactOsm({ ...osm, pois: [...osm.pois, ['food', 'X', 48.87, 2.77, 'table', 'javascript:alert(1)'], ['food', 'Y', 48.87, 2.77, 'vip', '']] }, at(11));
    expect(tampered?.pois).toHaveLength(3);

    const pois = buildPois(osm, [], catalog);
    expect(pois.find((p) => p.kind === 'picnic')).toMatchObject({ outside: true, source: 'osm' });
    expect(pois.find((p) => p.name === 'Table')).toMatchObject({ service: 'table', url: 'https://example.org/carte' });
    expect(pois.find((p) => p.name === 'Tacos')).toMatchObject({ service: 'quick', url: null });
  });

  it('offers the resort picnic area when OpenStreetMap lists none', () => {
    const pois = buildPois(null, [{ park: 'dlp', id: 'r1', name: "Captain Jack's", lat: 48.8712, lon: 2.7745 }], catalog);
    expect(pois.find((p) => p.kind === 'picnic')).toMatchObject({ id: 'resort-picnic', outside: true, source: 'resort' });
    expect(pois.find((p) => p.id === 'api-r1')?.service).toBe('table');
    expect(DLP_DINING.restaurantsUrl.startsWith('https://www.disneylandparis.com/')).toBe(true);
  });
});

describe('meal settings persistence', () => {
  it('reads older profiles: lunch break in place, no dinner', () => {
    const s = new MemoryStorage();
    const legacy = { ...DEFAULT_PROFILE, lunch: { enabled: true, atMin: 750, durationMin: 45 } } as Record<string, unknown>;
    delete legacy.dinner;
    s.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profile: legacy }));
    const back = loadState(s, at(10)).profile!;
    expect(back.lunch).toEqual({ enabled: true, atMin: 750, durationMin: 45, mode: 'free' });
    expect(back.dinner.enabled).toBe(false);
  });

  it('rejects out-of-window or unknown meal settings and hostile picks', () => {
    const s = new MemoryStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profile: { ...DEFAULT_PROFILE, dinner: { enabled: true, atMin: 9 * 60, durationMin: 60, mode: 'quick' } } }));
    expect(loadState(s, at(10)).profile).toBeNull();
    s.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profile: { ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, mode: 'banquet' } } }));
    expect(loadState(s, at(10)).profile).toBeNull();
    s.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: DEFAULT_PROFILE,
        day: { dateKey: '2026-10-22', meals: { lunch: { placeId: '<script>', reservationAt: null }, dinner: { placeId: 'osm-3', reservationAt: at(19) } } },
      }),
    );
    expect(loadState(s, at(10)).day.meals).toEqual({ dinner: { placeId: 'osm-3', reservationAt: at(19) } });
  });
});
