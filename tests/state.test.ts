import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, STORAGE_KEY, defaultState, loadState, saveState } from '../src/state/storage';
import { AppStore } from '../src/state/store';
import type { FetchFn } from '../src/data/themeparks';
import { MINUTE, MemoryStorage, at } from './helpers';

describe('storage', () => {
  it('round-trips a valid state', () => {
    const s = new MemoryStorage();
    const state = { ...defaultState(at(10)), profile: DEFAULT_PROFILE, wishes: [['dlp-buzz', 'must']] as const };
    expect(saveState(s, state)).toBe(true);
    const back = loadState(s, at(11));
    expect(back.profile).toEqual(DEFAULT_PROFILE);
    expect(back.wishes).toEqual([['dlp-buzz', 'must']]);
  });

  it('falls back to defaults on corrupt or hostile content', () => {
    const s = new MemoryStorage();
    s.setItem(STORAGE_KEY, '{not json');
    expect(loadState(s, at(10)).profile).toBeNull();
    s.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: { ...DEFAULT_PROFILE, size: 9999 },
        wishes: [['<img src=x onerror=alert(1)>', 'must'], ['dlp-buzz', 'evil'], ['dlp-dumbo', 'nice']],
        corrections: { __proto__: { ratio: 1, samples: 1 }, 'dlp-buzz': { ratio: 99, samples: 1 } },
        day: { dateKey: '2026-10-22', done: ['ok-id', 42, '../../etc'], position: { lat: 'x' } },
      }),
    );
    const back = loadState(s, at(10));
    expect(back.profile).toBeNull();
    expect(back.wishes).toEqual([['dlp-dumbo', 'nice']]);
    expect(back.corrections).toEqual({});
    expect(Object.prototype.hasOwnProperty.call({}, 'ratio')).toBe(false);
    expect(back.day.done).toEqual(['ok-id']);
    expect(back.day.position).toBeNull();
  });

  it('ignores oversized payloads and throwing storages', () => {
    const s = new MemoryStorage();
    s.setItem(STORAGE_KEY, 'x'.repeat(600_000));
    expect(loadState(s, at(10)).version).toBe(1);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    expect(loadState(broken, at(10)).profile).toBeNull();
    expect(saveState(broken, defaultState(at(10)))).toBe(false);
  });

  it('resets the day’s progress on a new day but keeps preferences', () => {
    const s = new MemoryStorage();
    const state = defaultState(at(10));
    saveState(s, { ...state, profile: DEFAULT_PROFILE, day: { ...state.day, done: ['dlp-buzz'] } });
    const tomorrow = loadState(s, at(10) + 24 * 60 * MINUTE);
    expect(tomorrow.profile).toEqual(DEFAULT_PROFILE);
    expect(tomorrow.day.done).toEqual([]);
  });
});

describe('AppStore (demo mode)', () => {
  let store: AppStore | null = null;
  afterEach(() => store?.stop());

  async function demoStore(now = at(10)) {
    const storage = new MemoryStorage();
    let real = now;
    store = new AppStore({ storage, fetchFn: null, realNow: () => real });
    await store.refresh();
    return { store, storage, advance: (min: number) => { real += min * MINUTE; store!.tick(); } };
  }

  it('falls back to demo data without network and plans the wish list', async () => {
    const { store } = await demoStore();
    expect(store.getState().data.mode).toBe('demo');
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-peter-pan', 'must');
    store.setWish('dlp-buzz', 'nice');
    store.setWish('unknown-ride', 'must');
    const plan = store.getState().plan!;
    expect(plan.steps.map((s) => s.targetId).sort()).toEqual(['dlp-buzz', 'dlp-peter-pan']);
    expect(store.getState().persisted.wishes).toHaveLength(2);
  });

  it('moves the group when a step is completed and persists progress', async () => {
    const { store, storage } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-peter-pan', 'must');
    store.setWish('dlp-big-thunder', 'must');
    const first = store.getState().plan!.steps[0]!;
    store.completeStep(first);
    const s = store.getState();
    expect(s.persisted.day.done).toEqual([first.targetId]);
    expect(s.plan!.steps.map((x) => x.targetId)).not.toContain(first.targetId);
    expect(s.plan!.steps[0]!.departAt).toBe(s.now);
    expect(loadState(storage, s.now).day.done).toEqual([first.targetId]);
  });

  it('replans on a breakdown and raises an alert', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    for (const id of ['dlp-peter-pan', 'dlp-big-thunder', 'dlp-buzz']) store.setWish(id, 'must');
    const first = store.getState().plan!.steps[0]!.targetId;
    store.simulateBreakdown(first);
    const s = store.getState();
    expect(s.plan!.steps.map((x) => x.targetId)).not.toContain(first);
    expect(s.alerts.some((a) => a.text.includes('en panne'))).toBe(true);
  });

  it('applies user reports (closed ride, actual wait)', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-peter-pan', 'must');
    store.reportClosed('dlp-peter-pan');
    expect(store.getState().plan!.unplanned).toContainEqual({ id: 'dlp-peter-pan', reason: 'closed' });
    expect(store.reportWait('dlp-big-thunder', 5)).toBe(true);
    expect(store.reportWait('dlp-big-thunder', -3)).toBe(false);
    expect(store.reportWait('dlp-big-thunder', 1.5)).toBe(false);
    expect(store.getState().persisted.corrections['dlp-big-thunder']?.samples).toBe(1);
  });

  it('records a Premier Access purchase within budget only', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, paBudgetEur: 15, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-big-thunder', 'must');
    expect(store.bookPremierAccess('dlp-big-thunder', at(11), 2000)).toBe(false);
    expect(store.bookPremierAccess('dlp-big-thunder', at(11), 1400)).toBe(true);
    const step = store.getState().plan!.steps.find((s) => s.targetId === 'dlp-big-thunder');
    expect(step?.kind).toBe('pa');
  });

  it('only accepts real sessions when picking a show', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.pickShow('daw-show-arendelle', at(10, 7));
    expect(store.getState().persisted.day.shows).toEqual([]);
    const session = store.getState().snapshot!.showtimes['daw-show-arendelle']![2]!;
    store.pickShow('daw-show-arendelle', session);
    expect(store.getState().plan!.steps.some((s) => s.kind === 'show')).toBe(true);
  });

  it('advances the simulated clock', async () => {
    const { store, advance } = await demoStore();
    store.setDemoSpeed(60);
    const t0 = store.getState().now;
    advance(1);
    expect(store.getState().now - t0).toBeGreaterThanOrEqual(59 * MINUTE);
  });
});

describe('AppStore (live mode)', () => {
  it('uses the last live snapshot when the network drops', async () => {
    const storage = new MemoryStorage();
    let online = true;
    const fetchFn: FetchFn = async (url) => {
      if (!online) throw new TypeError('offline');
      const path = url.replace('https://api.themeparks.wiki/v1', '');
      const routes: Record<string, unknown> = {
        '/destinations': { destinations: [{ name: 'Disneyland Paris', slug: 'disneylandparis', parks: [{ id: 'p1', name: 'Disneyland Park' }] }] },
        '/entity/p1/children': { children: [{ id: 'pp', name: "Peter Pan's Flight", entityType: 'ATTRACTION' }] },
        '/entity/p1/live': { liveData: [{ id: 'pp', name: "Peter Pan's Flight", entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 55 } } }] },
        '/entity/p1/schedule': { schedule: [] },
      };
      return { ok: path in routes, status: path in routes ? 200 : 404, json: async () => routes[path] };
    };
    let real = at(10);
    const store = new AppStore({ storage, fetchFn, realNow: () => real });
    await store.refresh();
    expect(store.getState().data.mode).toBe('live');
    expect(store.getState().snapshot?.attractions['dlp-peter-pan']?.standby).toBe(55);

    online = false;
    real += 10 * MINUTE;
    const reloaded = new AppStore({ storage, fetchFn, realNow: () => real });
    await reloaded.refresh();
    expect(reloaded.getState().data.mode).toBe('offline');
    expect(reloaded.getState().snapshot?.attractions['dlp-peter-pan']?.standby).toBe(55);
  });
});

describe('AppStore (OpenStreetMap)', () => {
  it('fetches the footway network once, caches it and plans with it', async () => {
    const { overpassGrid } = await import('./fixtures');
    const { OSM_CACHE_KEY } = await import('../src/data/osm');
    const storage = new MemoryStorage();
    let overpassCalls = 0;
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith('https://overpass-api.de/')) {
        overpassCalls++;
        return { ok: true, status: 200, json: async () => overpassGrid() };
      }
      throw new TypeError('offline');
    };
    const real = at(10);
    const store = new AppStore({ storage, fetchFn, realNow: () => real });
    await store.refresh();
    await store.loadOsm();
    expect(store.getState().osm.status).toBe('ok');
    expect(store.getState().pois.some((p) => p.kind === 'toilets')).toBe(true);
    expect(storage.getItem(OSM_CACHE_KEY)).not.toBeNull();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-big-thunder', 'must');
    const step = store.getState().plan!.steps[0]!;
    expect(step.walkMin).toBe(store.walkMinutesTo(step.position));
    expect(store.route(store.currentPosition(), step.position).onNetwork).toBe(true);

    // Second start: served from the device cache, no network call.
    const again = new AppStore({ storage, fetchFn, realNow: () => real });
    await again.loadOsm();
    expect(again.getState().osm.status).toBe('ok');
    expect(overpassCalls).toBe(1);
  });

  it('degrades to straight-line estimates without network data', async () => {
    const store = new AppStore({ storage: new MemoryStorage(), fetchFn: null, realNow: () => at(10) });
    await store.loadOsm();
    expect(store.getState().osm.status).toBe('unavailable');
    expect(store.route({ lat: 48.87, lon: 2.77 }, { lat: 48.872, lon: 2.772 }).onNetwork).toBe(false);
  });
});

describe('Carte Facilité, repeated rides and split group: persistence and store', () => {
  let store: AppStore | null = null;
  afterEach(() => store?.stop());

  async function demoStore(now = at(10)) {
    const storage = new MemoryStorage();
    store = new AppStore({ storage, fetchFn: null, realNow: () => now });
    await store.refresh();
    return { store, storage };
  }

  it('round-trips repeats, repeated rides, the held registration and used Premier Access', () => {
    const s = new MemoryStorage();
    const state = defaultState(at(10));
    const day = {
      ...state.day,
      done: ['dlp-buzz', 'dlp-buzz'],
      easyAccess: { rideId: 'dlp-peter-pan', returnAt: at(10, 45) },
      paBookings: [{ attractionId: 'dlp-buzz', returnStart: at(11), returnEnd: at(12), priceCents: 1000, used: true }],
    };
    saveState(s, { ...state, profile: { ...DEFAULT_PROFILE, size: 7, easyAccess: true }, repeats: { 'dlp-buzz': 3 }, day });
    const back = loadState(s, at(11));
    expect(back.profile?.easyAccess).toBe(true);
    expect(back.repeats).toEqual({ 'dlp-buzz': 3 });
    expect(back.day.done).toEqual(['dlp-buzz', 'dlp-buzz']);
    expect(back.day.easyAccess).toEqual({ rideId: 'dlp-peter-pan', returnAt: at(10, 45) });
    expect(back.day.paBookings[0]?.used).toBe(true);
  });

  it('rejects hostile or out-of-range values and reads older profiles', () => {
    const s = new MemoryStorage();
    s.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: { ...DEFAULT_PROFILE, easyAccess: undefined },
        repeats: { 'dlp-buzz': 99, '<img>': 2, 'dlp-orbitron': 1.5, 'dlp-dumbo': 2 },
        day: { dateKey: '2026-10-22', easyAccess: { rideId: '../etc', returnAt: 'soon' } },
      }),
    );
    const back = loadState(s, at(10));
    expect(back.profile?.easyAccess).toBe(false);
    expect(back.repeats).toEqual({ 'dlp-dumbo': 2 });
    expect(back.day.easyAccess).toBeNull();
    s.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profile: { ...DEFAULT_PROFILE, easyAccess: 'yes' } }));
    expect(loadState(s, at(10)).profile).toBeNull();
  });

  it('records the return time given, plans the ride through the card, and frees it once ridden', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, easyAccess: true, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    for (const id of ['dlp-peter-pan', 'dlp-dumbo', 'dlp-lancelot']) store.setWish(id, 'must');
    const now = store.getState().now;
    expect(store.registerEasyAccess('dlp-peter-pan', now + 9 * 60 * MINUTE)).toBe(false);
    expect(store.registerEasyAccess('dlp-peter-pan', now + 35 * MINUTE)).toBe(true);
    let plan = store.getState().plan!;
    expect(plan.steps.some((s) => s.kind === 'easy-book')).toBe(false);
    const pp = plan.steps.find((s) => s.targetId === 'dlp-peter-pan')!;
    expect(pp.queue).toBe('easy');
    expect(pp.startAt).toBeGreaterThanOrEqual(now + 35 * MINUTE);
    store.completeStep(pp);
    expect(store.getState().persisted.day.easyAccess).toBeNull();
    plan = store.getState().plan!;
    expect(plan.steps.some((s) => s.targetId === 'dlp-peter-pan')).toBe(false);
  });

  it('refuses a registration without the card, and drops it when the ride is skipped', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-peter-pan', 'must');
    const now = store.getState().now;
    expect(store.registerEasyAccess('dlp-peter-pan', now + 30 * MINUTE)).toBe(false);
    store.saveProfile({ ...DEFAULT_PROFILE, easyAccess: true, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    expect(store.registerEasyAccess('dlp-peter-pan', now + 30 * MINUTE)).toBe(true);
    store.skip('dlp-peter-pan');
    expect(store.getState().persisted.day.easyAccess).toBeNull();
  });

  it('plans a ride again until it has been done as many times as wished', async () => {
    const { store } = await demoStore();
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-buzz', 'must');
    store.setRepeat('dlp-buzz', 2);
    store.setRepeat('dlp-buzz', 99);
    expect(store.getState().persisted.repeats).toEqual({ 'dlp-buzz': 2 });
    const buzz = () => store.getState().plan!.steps.filter((s) => s.targetId === 'dlp-buzz');
    expect(buzz().map((s) => s.rep)).toEqual([1, 2]);
    store.completeStep(buzz()[0]!);
    expect(buzz().map((s) => s.rep)).toEqual([2]);
    store.completeStep(buzz()[0]!);
    expect(buzz()).toEqual([]);
    expect(store.getState().persisted.day.done).toEqual(['dlp-buzz', 'dlp-buzz']);
    store.setWish('dlp-buzz', null);
    expect(store.getState().persisted.repeats).toEqual({});
  });
});

describe('off-thread planner', () => {
  it('shows the next step at once, ignores stale answers and keeps the latest plan', async () => {
    const { computePlan } = await import('../src/domain/planner');
    const queue: Array<() => void> = [];
    const planner = {
      plan: (req: Parameters<typeof computePlan>[0]) => new Promise<ReturnType<typeof computePlan>>((resolve) => queue.push(() => resolve(computePlan(req)))),
      setNetwork: () => undefined,
    };
    const storage = new MemoryStorage();
    const s = new AppStore({ storage, fetchFn: null, realNow: () => at(10), planner });
    await s.refresh();
    const flush = async () => {
      while (queue.length) queue.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    };
    s.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    s.setWish('dlp-peter-pan', 'must');
    s.setWish('dlp-buzz', 'must');
    expect(s.getState().planPending).toBe(true);
    await flush();
    const state = s.getState();
    expect(state.planPending).toBe(false);
    const [first, second] = state.plan!.steps;
    // Completing a step removes it immediately, before the new plan arrives.
    s.completeStep(first!);
    expect(s.getState().plan!.steps[0]).toBe(second);
    expect(s.getState().planPending).toBe(true);
    // Two requests in flight: only the latest is applied, whatever the answer order.
    s.setWish('dlp-dumbo', 'nice');
    const [older, newer] = [queue.shift()!, queue.shift()!];
    newer();
    await Promise.resolve();
    await Promise.resolve();
    const latest = s.getState().plan;
    older();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.getState().plan).toBe(latest);
    expect(latest!.steps.map((x) => x.targetId)).toContain('dlp-dumbo');
    s.stop();
  });
});

describe('meals in the store', () => {
  it('validates the chosen place, completes and skips meals', async () => {
    const storage = new MemoryStorage();
    const s = new AppStore({ storage, fetchFn: null, realNow: () => at(10) });
    await s.refresh();
    await s.loadOsm();
    s.saveProfile({
      ...DEFAULT_PROFILE,
      lunch: { enabled: true, atMin: 12 * 60 + 30, durationMin: 40, mode: 'picnic' },
      dinner: { enabled: true, atMin: 19 * 60, durationMin: 30, mode: 'quick' },
    });
    s.setWish('dlp-peter-pan', 'must');
    const lunch = () => s.getState().plan!.steps.find((x) => x.kind === 'meal' && x.meal?.slot === 'lunch');
    // Without network, the resort's own picnic area is offered (outside the gates).
    expect(lunch()?.targetId).toBe('resort-picnic');
    expect(lunch()?.meal?.reentryMin).toBe(15);
    expect(s.setMealPick('lunch', 'not-a-place', null)).toBe(false);
    expect(s.setMealPick('lunch', 'resort-picnic', at(10) + 30 * 60 * MINUTE)).toBe(false);
    expect(s.setMealPick('lunch', 'resort-picnic', null)).toBe(true);
    s.completeStep(lunch()!);
    expect(s.getState().persisted.day.lunchDone).toBe(true);
    expect(s.getState().persisted.day.position?.key).toBe('resort-picnic');
    const dinner = s.getState().plan!.steps.find((x) => x.kind === 'meal' && x.meal?.slot === 'dinner')!;
    s.skipStep(dinner);
    expect(s.getState().persisted.day.dinnerDone).toBe(true);
    expect(s.getState().plan!.steps.some((x) => x.kind === 'meal')).toBe(false);
    s.stop();
  });
});
