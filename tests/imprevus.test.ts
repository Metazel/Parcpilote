import { describe, expect, it } from 'vitest';
import { seedCatalog } from '../src/data/catalog';
import { forChildren, isGraded } from '../src/data/forecast';
import type { Attraction, Place } from '../src/domain/types';
import { DEFAULT_PROFILE, loadState } from '../src/state/storage';
import { AppStore } from '../src/state/store';
import { MINUTE, MemoryStorage, at } from './helpers';

function demoStore(storage = new MemoryStorage()) {
  const store = new AppStore({ storage, fetchFn: null, realNow: () => at(10) });
  store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
  return store;
}

describe('unforeseen events during the visit', () => {
  it('« Plus tard » takes a ride out for an hour, then it comes back by itself', async () => {
    const store = demoStore();
    await store.refresh();
    store.setWish('dlp-big-thunder', 'must');
    store.setWish('dlp-peter-pan', 'must');
    const first = store.getState().plan!.steps[0]!.targetId;
    store.postpone(first);
    expect(store.getState().plan!.steps.some((s) => s.targetId === first)).toBe(false);
    expect(store.getState().persisted.day.later[first]).toBe(store.getState().now + 60 * MINUTE);
    // Not dropped for the day, unlike « Passer ».
    expect(store.getState().persisted.day.skipped).not.toContain(first);
    store.restore(first);
    expect(store.getState().persisted.day.later[first]).toBeUndefined();
    expect(store.getState().plan!.steps.some((s) => s.targetId === first)).toBe(true);
    // Unknown places and odd durations are refused.
    store.postpone('nope');
    store.postpone(first, 5000);
    expect(store.getState().persisted.day.later).toEqual({});
  });

  it('a break shifts the whole plan after it, and can be ended early', async () => {
    const store = demoStore();
    await store.refresh();
    store.setWish('dlp-peter-pan', 'must');
    const before = store.getState().plan!.steps[0]!.departAt;
    store.pause(30);
    const now = store.getState().now;
    expect(store.getState().persisted.day.pauseUntil).toBe(now + 30 * MINUTE);
    expect(store.getState().plan!.steps[0]!.departAt).toBeGreaterThanOrEqual(now + 30 * MINUTE);
    store.resume();
    expect(store.getState().persisted.day.pauseUntil).toBeNull();
    expect(store.getState().plan!.steps[0]!.departAt).toBeLessThanOrEqual(before + MINUTE);
    store.pause(0);
    store.pause(500);
    expect(store.getState().persisted.day.pauseUntil).toBeNull();
  });

  it('keeps the break and the postponed rides across a reload, and checks them', () => {
    const storage = new MemoryStorage();
    storage.setItem('parcpilote:v1', JSON.stringify({ version: 1, day: { dateKey: '2026-10-22', pauseUntil: at(11), later: { 'dlp-dumbo': at(12), '../x': at(12), 'dlp-casey-jr': 'soon' } } }));
    const day = loadState(storage, at(10)).day;
    expect(day.pauseUntil).toBe(at(11));
    expect(day.later).toEqual({ 'dlp-dumbo': at(12) });
  });

  it('opens the map on a service point only when it exists', async () => {
    const store = demoStore();
    store.setMapFocus('dlp-peter-pan');
    expect(store.getState().mapFocus).toBe('dlp-peter-pan');
    store.setMapFocus('javascript:alert(1)');
    expect(store.getState().mapFocus).toBe('dlp-peter-pan');
    store.setMapFocus(null);
    expect(store.getState().mapFocus).toBeNull();
    expect(store.nearest('toilets')).toEqual([]);
  });
});

describe('rides for the children', () => {
  const catalog = seedCatalog();
  const get = (id: string) => catalog.get(id) as Place;

  it('keeps gentle rides open to the smallest member, and the shows', () => {
    expect(isGraded(catalog)).toBe(true);
    expect(forChildren(get('dlp-dumbo'), 95)).toBe(true);
    expect(forChildren(get('dlp-big-thunder'), 95)).toBe(false);
    expect(forChildren(get('dlp-big-thunder'), null)).toBe(false);
    const show = [...catalog.values()].find((p) => p.kind === 'show')!;
    expect(forChildren(show, 95)).toBe(true);
  });

  it('does not pretend to know for lists without grading', () => {
    const plain = new Map<string, Place>([['a', { ...(get('dlp-dumbo') as Attraction), intensity: 1, minHeightCm: 0 }]]);
    expect(isGraded(plain)).toBe(false);
  });
});
