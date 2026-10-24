import { afterEach, describe, expect, it } from 'vitest';
import { DESTINATIONS, destination } from '../src/data/destinations';
import { MANUAL_WAIT_MIN, defParks, manualCatalog, manualSnapshot } from '../src/data/manual';
import { buildPois } from '../src/data/pois';
import { type FetchFn, destinationMatches, loadLive, parkGates, parseDestinations } from '../src/data/themeparks';
import { emptyDay, parseCatalogCache } from '../src/state/storage';
import { DEFAULT_PROFILE } from '../src/state/storage';
import { AppStore } from '../src/state/store';
import type { CompactOsm } from '../src/domain/walkGraph';
import type { Place } from '../src/domain/types';
import { MINUTE, MemoryStorage, at } from './helpers';

const ASTERIX = destination('asterix');
const PUY = destination('puydufou');

/** A small ThemeParks.wiki answer for Parc Astérix (one park, discovered at run time). */
const asterixRoutes: Record<string, unknown> = {
  '/destinations': {
    destinations: [
      { name: 'Disneyland Paris', slug: 'disneylandparis', parks: [{ id: 'p-dlp', name: 'Disneyland Park' }] },
      { name: 'Parc Astérix', slug: 'parcasterix', parks: [{ id: 'ast', name: 'Parc Asterix' }] },
    ],
  },
  '/entity/ast/children': {
    children: [
      { id: 'zeus', name: 'Tonnerre de Zeus', entityType: 'ATTRACTION', location: { latitude: 49.137, longitude: 2.57 } },
      { id: 'oziris', name: 'OzIris', entityType: 'ATTRACTION', location: { latitude: 49.135, longitude: 2.574 } },
      { id: 'goudurix', name: 'Goudurix', entityType: 'ATTRACTION', location: { latitude: 49.136, longitude: 2.572 } },
      { id: 'lost', name: 'Mal placée', entityType: 'ATTRACTION', location: { latitude: 45.0, longitude: 1.0 } },
      { id: 'dauphins', name: 'Le Théâtre de Poséidon', entityType: 'SHOW', location: { latitude: 49.1365, longitude: 2.573 } },
      { id: 'resto', name: 'Arena', entityType: 'RESTAURANT', location: { latitude: 49.1362, longitude: 2.5712 } },
    ],
  },
  '/entity/ast/live': {
    liveData: [
      { id: 'zeus', name: 'Tonnerre de Zeus', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 40 } } },
      { id: 'oziris', name: 'OzIris', entityType: 'ATTRACTION', status: 'DOWN' },
      { id: 'goudurix', name: 'Goudurix', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 10 } } },
      { id: 'lost', name: 'Mal placée', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 5 } } },
      { id: 'dauphins', name: 'Le Théâtre de Poséidon', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ type: 'Performance', startTime: '2026-10-22T14:00:00+02:00' }] },
    ],
  },
  '/entity/ast/schedule': { schedule: [] },
};

function routeFetch(routes: Record<string, unknown>, online: () => boolean = () => true): FetchFn {
  return async (url) => {
    if (!online()) throw new TypeError('offline');
    const path = url.replace('https://api.themeparks.wiki/v1', '');
    const body = routes[path];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

describe('destinations', () => {
  it('has unique ids and https official sites', () => {
    expect(new Set(DESTINATIONS.map((d) => d.id)).size).toBe(DESTINATIONS.length);
    for (const d of DESTINATIONS) expect(d.site).toMatch(/^https:\/\//);
    expect(destination('nope').id).toBe('dlp');
  });

  it('matches ThemeParks.wiki destinations by slug or name, not by accident', () => {
    expect(destinationMatches('parcasterix', 'Parc Astérix', ['parc asterix'])).toBe(true);
    expect(destinationMatches('gardalandresort', 'Gardaland Resort', ['gardaland'])).toBe(true);
    expect(destinationMatches('walibiholland', 'Walibi Holland', ['walibi rhone', 'walibirhonealpes'])).toBe(false);
    expect(destinationMatches('disneylandparis', 'Disneyland Paris', ['parc asterix'])).toBe(false);
  });

  it('discovers the parks of a destination without curated referential', () => {
    expect(parseDestinations(asterixRoutes['/destinations'], ASTERIX)).toEqual([{ id: 'ast', park: 'ast', name: 'Parc Asterix' }]);
    expect(() => parseDestinations(asterixRoutes['/destinations'], PUY)).toThrow();
  });

  it('places a park gate at the median of its attractions', () => {
    const gates = parkGates(ASTERIX, [
      { park: 'p', entity: { id: 'a', name: 'a', type: 'ATTRACTION', lat: 49.1, lon: 2.5 } },
      { park: 'p', entity: { id: 'b', name: 'b', type: 'ATTRACTION', lat: 49.2, lon: 2.6 } },
      { park: 'p', entity: { id: 'c', name: 'c', type: 'ATTRACTION', lat: 10, lon: 10 } },
      { park: 'p', entity: { id: 'd', name: 'd', type: 'ATTRACTION', lat: 49.15, lon: 2.55 } },
    ]);
    expect(gates.get('p')?.lat).toBeCloseTo(49.125, 3); // the outlier barely moves it
    // Curated destinations keep their known gates.
    expect(parkGates(destination('dlp'), []).get('dlp')).toEqual({ lat: 48.8703, lon: 2.7797 });
  });
});

describe('live loading for another park', () => {
  it('builds the catalogue, the gate, usual hours and restaurants from the feed', async () => {
    const bundle = await loadLive(routeFetch(asterixRoutes), ASTERIX, new Map(), at(10));
    const snap = bundle.snapshot;
    expect(snap.parks).toHaveLength(1);
    expect(snap.parks[0]).toMatchObject({ id: 'ast', name: 'Parc Asterix', color: 0 });
    expect(snap.attractions['api-zeus']).toMatchObject({ status: 'OPERATING', standby: 40 });
    expect(snap.attractions['api-oziris']?.status).toBe('DOWN');
    expect(snap.showtimes['api-dauphins']).toEqual([Date.parse('2026-10-22T14:00:00+02:00')]);
    // Usual hours when the schedule is empty (10:00–18:00).
    expect(snap.hours.ast).toMatchObject({ open: at(10), close: at(18), emh: null });
    // A misplaced attraction is put at the gate, not 400 km away.
    const lost = bundle.catalog.get('api-lost');
    expect(lost?.lat).toBeCloseTo(49.136, 2);
    expect(bundle.catalog.get('api-zeus')?.land).toBe('Parc Asterix');
    expect(bundle.restaurants.map((r) => r.name)).toEqual(['Arena']);
  });
});

describe('manual mode', () => {
  const sights = [
    ['Le Signe du Triomphe', 46.89, -0.93, 'show'],
    ['Les Vikings', 46.892, -0.931, 'show'],
    ['les vikings', 46.892, -0.931, 'show'],
  ] as const;

  it('builds the catalogue from OpenStreetMap places and visitor additions', () => {
    const custom = [
      { dest: 'puydufou', id: 'custom-a', name: 'Le Bal des Oiseaux Fantômes', kind: 'show' as const, durationMin: 35 },
      { dest: 'spirou', id: 'custom-b', name: 'Ailleurs', kind: 'ride' as const, durationMin: 5 },
    ];
    const catalog = manualCatalog(PUY, sights, custom);
    const names = [...catalog.values()].map((p) => p.name);
    expect(names).toEqual(['Le Signe du Triomphe', 'Les Vikings', 'Le Bal des Oiseaux Fantômes']);
    expect([...catalog.values()].every((p) => p.kind === 'show' && p.park === 'puydufou')).toBe(true);
    expect(catalog.get('custom-a')).toMatchObject({ durationMin: 35, land: 'Ajoutés par vous' });
  });

  it('estimates waits, keeps today’s entered sessions and the entered hours', () => {
    const spirou = destination('spirou');
    const catalog = manualCatalog(spirou, [['Marsupilami', 44.02, 4.97, 'ride'], ['Spectacle', 44.021, 4.971, 'show']], []);
    const ride = [...catalog.values()].find((p) => p.kind === 'ride')!;
    const show = [...catalog.values()].find((p) => p.kind === 'show')!;
    const day = {
      ...emptyDay(at(10)),
      manualWaits: { [ride.id]: 25 },
      manualShowtimes: { [show.id]: [at(15), at(15) - 24 * 60 * MINUTE] },
      manualHours: { open: at(9), close: at(19) },
    };
    const snap = manualSnapshot(at(10), catalog, defParks(spirou), 'spirou', day);
    expect(snap.source).toBe('manual');
    expect(snap.attractions[ride.id]).toMatchObject({ status: 'OPERATING', standby: 25 });
    expect(snap.showtimes[show.id]).toEqual([at(15)]);
    expect(snap.hours.spirou).toEqual({ open: at(9), close: at(19), emh: null });
    const usual = manualSnapshot(at(10), catalog, defParks(spirou), 'spirou', emptyDay(at(10)));
    expect(usual.attractions[ride.id]?.standby).toBe(MANUAL_WAIT_MIN);
    expect(usual.hours.spirou).toMatchObject({ open: at(10), close: at(18) });
    const late = manualSnapshot(at(18, 30), catalog, defParks(spirou), 'spirou', emptyDay(at(18, 30)));
    expect(late.attractions[ride.id]?.status).toBe('CLOSED');
  });
});

describe('catalogue cache', () => {
  const parks = [{ id: 'ast', name: 'Parc Asterix', short: 'Parc Asterix', entrance: { lat: 49.136, lon: 2.572 }, color: 0 }];
  const place = { kind: 'ride', id: 'api-zeus', name: 'Tonnerre de Zeus', park: 'ast', land: 'Parc Asterix', lat: 49.137, lon: 2.57, durationMin: 5, minHeightCm: 0, singleRider: false, premierAccess: false, intensity: 1 };

  it('accepts a recent, well-formed cache', () => {
    const c = parseCatalogCache({ dest: 'asterix', fetchedAt: at(9), parks, places: [place] }, at(10));
    expect(c?.places).toHaveLength(1);
  });

  it('rejects stale, foreign or hostile content', () => {
    expect(parseCatalogCache({ dest: 'asterix', fetchedAt: at(9) - 40 * 24 * 60 * MINUTE, parks, places: [place] }, at(10))).toBeNull();
    expect(parseCatalogCache({ dest: 'atlantis', fetchedAt: at(9), parks, places: [place] }, at(10))).toBeNull();
    expect(parseCatalogCache({ dest: 'asterix', fetchedAt: at(9), parks, places: [{ ...place, park: 'other' }] }, at(10))).toBeNull();
    expect(parseCatalogCache({ dest: 'asterix', fetchedAt: at(9), parks, places: [{ ...place, id: '<img onerror=x>' }] }, at(10))).toBeNull();
    expect(parseCatalogCache({ dest: 'asterix', fetchedAt: at(9), parks: [{ ...parks[0], entrance: { lat: 'x' } }], places: [place] }, at(10))).toBeNull();
  });
});

describe('POIs of another park', () => {
  const catalog = new Map<string, Place>([['api-zeus', { kind: 'ride', id: 'api-zeus', name: 'Zeus', park: 'ast', land: 'x', lat: 49.137, lon: 2.57, durationMin: 5, minHeightCm: 0, singleRider: false, premierAccess: false, intensity: 1 }]]);
  const osm: CompactOsm = {
    v: 3,
    fetchedAt: at(9),
    bbox: [49.12, 2.55, 49.15, 2.59],
    lat: [],
    lon: [],
    edges: [],
    names: [],
    sights: [],
    pois: [
      ['picnic', 'Aire du parc', 49.1372, 2.5702, '', ''],
      ['picnic', 'Aire du parking', 49.1405, 2.5745, '', ''],
      ['food', 'Arena', 49.13621, 2.57121, 'table', 'https://example.org/menu'],
    ],
  };

  it('guesses which picnic areas are outside and enriches official restaurants', () => {
    const pois = buildPois(osm, [{ park: 'ast', id: 'resto', name: 'Arena', lat: 49.1362, lon: 2.5712 }], catalog, ASTERIX.dining);
    expect(pois.find((p) => p.name === 'Aire du parc')?.outside).toBe(false);
    expect(pois.find((p) => p.name === 'Aire du parking')?.outside).toBe(true);
    const arena = pois.filter((p) => p.name === 'Arena');
    expect(arena).toHaveLength(1);
    expect(arena[0]).toMatchObject({ source: 'official', service: 'table', url: 'https://example.org/menu' });
  });
});

describe('AppStore across parks', () => {
  let stores: AppStore[] = [];
  afterEach(() => {
    for (const s of stores) s.stop();
    stores = [];
  });
  const make = (storage: MemoryStorage, fetchFn: FetchFn | null, now: () => number) => {
    const s = new AppStore({ storage, fetchFn, realNow: now });
    stores.push(s);
    return s;
  };

  it('switches park, keeps each list and plans with live data', async () => {
    const storage = new MemoryStorage();
    const store = make(storage, routeFetch(asterixRoutes), () => at(10));
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    await store.refresh();
    store.setWish('dlp-peter-pan', 'must');
    await store.setDestination('asterix');
    let s = store.getState();
    expect(s.resort.def.id).toBe('asterix');
    expect(s.data.mode).toBe('live');
    expect(s.persisted.wishes).toEqual([]);
    expect(s.resort.parks.map((p) => p.id)).toEqual(['ast']);
    store.setWish('api-zeus', 'must');
    store.setWish('api-goudurix', 'nice');
    s = store.getState();
    expect(s.plan?.steps.map((x) => x.targetId).sort()).toEqual(['api-goudurix', 'api-zeus']);
    expect(s.persisted.catalogCache?.dest).toBe('asterix');

    await store.setDestination('dlp');
    expect(store.getState().persisted.wishes).toEqual([['dlp-peter-pan', 'must']]);
    await store.setDestination('asterix');
    expect(store.getState().persisted.wishes).toEqual([
      ['api-zeus', 'must'],
      ['api-goudurix', 'nice'],
    ]);
  });

  it('falls back to estimates from the cached list when the feed is down', async () => {
    const storage = new MemoryStorage();
    let online = true;
    let real = at(10);
    const store = make(storage, routeFetch(asterixRoutes, () => online), () => real);
    await store.setDestination('asterix');
    online = false;
    real += 3 * 60 * MINUTE; // older than the offline snapshot limit
    const reloaded = make(storage, routeFetch(asterixRoutes, () => online), () => real);
    await reloaded.refresh();
    const s = reloaded.getState();
    expect(s.data.mode).toBe('manual');
    expect(s.snapshot?.attractions['api-zeus']).toMatchObject({ status: 'OPERATING', standby: MANUAL_WAIT_MIN });
  });

  it('says so when a park was never loaded and the feed is down', async () => {
    const store = make(new MemoryStorage(), routeFetch({}, () => false), () => at(10));
    await store.setDestination('europapark');
    expect(store.getState().data.mode).toBe('unavailable');
    expect(store.getState().snapshot).toBeNull();
  });

  it('runs Puy du Fou in manual mode with added shows, sessions and hours', async () => {
    const store = make(new MemoryStorage(), null, () => at(10));
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    await store.setDestination('puydufou');
    expect(store.getState().data.mode).toBe('manual');
    expect(store.addCustomPlace(' ', 'show', 30)).toBeNull();
    expect(store.addCustomPlace('Le Signe', 'show', 999)).toBeNull();
    const id = store.addCustomPlace('  Le   Signe du Triomphe ', 'show', 35)!;
    expect(store.getState().catalog.get(id)?.name).toBe('Le Signe du Triomphe');

    expect(store.addManualShowtime(id, at(14, 30))).toBe(true);
    expect(store.addManualShowtime(id, at(14, 30) + 24 * 60 * MINUTE)).toBe(false);
    expect(store.addManualShowtime('nope', at(15))).toBe(false);
    expect(store.getState().snapshot?.showtimes[id]).toEqual([at(14, 30)]);
    store.pickShow(id, at(14, 30));
    expect(store.getState().plan?.steps.some((s) => s.kind === 'show' && s.targetId === id)).toBe(true);

    expect(store.setManualHours(9 * 60 + 30, 9 * 60 + 45)).toBe(false);
    expect(store.setManualHours(9 * 60, 20 * 60)).toBe(true);
    expect(store.getState().snapshot?.hours.puydufou?.close).toBe(at(20));

    store.removeManualShowtime(id, at(14, 30));
    expect(store.getState().persisted.day.shows).toEqual([]);
    store.removeCustomPlace(id);
    expect(store.getState().catalog.has(id)).toBe(false);
  });

  it('keeps Disney-only programmes off other parks', async () => {
    const store = make(new MemoryStorage(), null, () => at(10));
    store.saveProfile({ ...DEFAULT_PROFILE, easyAccess: true, emhAccess: true, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    await store.setDestination('spirou');
    const id = store.addCustomPlace('Marsupilami', 'ride', 5)!;
    store.setWish(id, 'must');
    const step = store.getState().plan?.steps.find((s) => s.targetId === id);
    expect(step?.kind).toBe('ride');
    expect(store.getState().persisted.settings.source).toBe('auto');
  });
});
