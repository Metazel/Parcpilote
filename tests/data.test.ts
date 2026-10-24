import { describe, expect, it } from 'vitest';
import { normalizeName, seedCatalog } from '../src/data/catalog';
import { curatedParks, demoSnapshot } from '../src/data/demo';
import { destination } from '../src/data/destinations';
import {
  type FetchFn,
  LiveDataError,
  buildSnapshot,
  loadLive,
  mergeCatalog,
  namesMatch,
  parseChildren,
  parseDestinations,
  parseLive,
  parkGates,
  parseSchedule,
} from '../src/data/themeparks';
import { MINUTE, at, catalog } from './helpers';

const DLP = destination('dlp');
const DLP_ID = 'dae968d5-630d-4719-8b06-3d107e944401';
const DAW_ID = 'ca888437-ebb4-4d50-aed2-d227f7096968';

const destinations = {
  destinations: [
    { id: 'x1', name: 'Walt Disney World', slug: 'waltdisneyworldresort', parks: [{ id: 'mk', name: 'Magic Kingdom Park' }] },
    {
      id: 'e8d0207f',
      name: 'Disneyland Paris',
      slug: 'disneylandparis',
      parks: [
        { id: DLP_ID, name: 'Disneyland Park' },
        { id: DAW_ID, name: 'Disney Adventure World' },
      ],
    },
  ],
};

const children = {
  id: DLP_ID,
  children: [
    { id: 'btm', name: 'Big Thunder Mountain', entityType: 'ATTRACTION', location: { latitude: 48.8741, longitude: 2.7711 } },
    { id: 'auto', name: 'Autopia, presented by Avis', entityType: 'ATTRACTION' },
    { id: 'hsm', name: 'Star Wars Hyperspace Mountain', entityType: 'ATTRACTION' },
    { id: 'hsm-sr', name: 'Star Wars Hyperspace Mountain Single Rider', entityType: 'ATTRACTION' },
    { id: 'new', name: 'Nouvelle <b>Attraction</b>', entityType: 'ATTRACTION', location: { latitude: 10, longitude: 10 } },
    { id: 'bad id!', name: 'Injected', entityType: 'ATTRACTION' },
    { id: 'rest', name: 'Restaurant', entityType: 'RESTAURANT' },
    'garbage',
  ],
};

const live = {
  liveData: [
    { id: 'btm', name: 'Big Thunder Mountain', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 45 }, PAID_RETURN_TIME: { state: 'AVAILABLE', returnStart: '2026-10-22T11:00:00+02:00', returnEnd: '2026-10-22T12:00:00+02:00', price: { amount: 1400, currency: 'EUR', formatted: '€14.00' } } } },
    { entityId: 'auto', name: 'Autopia', entityType: 'ATTRACTION', status: 'DOWN', queue: { STANDBY: { waitTime: null } } },
    { id: 'hsm', name: 'Star Wars Hyperspace Mountain', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 50 } } },
    { id: 'hsm-sr', name: 'Star Wars Hyperspace Mountain Single Rider', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 15 } } },
    { id: 'btm', name: 'x', entityType: 'ATTRACTION', status: 'EXPLODED' },
    { id: 'neg', name: 'Neg', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: -5 } } },
  ],
};

describe('ThemeParks.wiki parsing', () => {
  it('finds the Disneyland Paris parks', () => {
    expect(parseDestinations(destinations, DLP)).toEqual([
      { id: DLP_ID, park: 'dlp', name: 'Disneyland Park' },
      { id: DAW_ID, park: 'daw', name: 'Disney Adventure World' },
    ]);
    expect(() => parseDestinations({ destinations: [] }, DLP)).toThrow(LiveDataError);
    expect(() => parseDestinations('nope', DLP)).toThrow(LiveDataError);
  });

  it('keeps only well-formed attractions, shows and restaurants', () => {
    const list = parseChildren(children);
    expect(list.map((e) => e.id)).toEqual(['btm', 'auto', 'hsm', 'hsm-sr', 'new', 'rest']);
    expect(list[0]).toMatchObject({ lat: 48.8741, lon: 2.7711 });
    expect(list[1]).toMatchObject({ lat: null, lon: null });
  });

  it('validates live entries (status enum, non-negative waits, id or entityId)', () => {
    const list = parseLive(live);
    expect(list.map((e) => e.id)).toEqual(['btm', 'auto', 'hsm', 'hsm-sr', 'neg']);
    expect(list.find((e) => e.id === 'neg')?.standby).toBeNull();
    const btm = list[0]!;
    expect(btm.pa).toEqual({ state: 'AVAILABLE', priceCents: 1400, returnStart: Date.parse('2026-10-22T11:00:00+02:00'), returnEnd: Date.parse('2026-10-22T12:00:00+02:00') });
  });

  it('reads today’s operating hours only', () => {
    const json = {
      schedule: [
        { date: '2026-10-21', type: 'OPERATING', openingTime: '2026-10-21T09:30:00+02:00', closingTime: '2026-10-21T23:00:00+02:00' },
        { date: '2026-10-22', type: 'EXTRA_HOURS', openingTime: '2026-10-22T08:30:00+02:00', closingTime: '2026-10-22T09:30:00+02:00' },
        { date: '2026-10-22', type: 'OPERATING', openingTime: '2026-10-22T09:30:00+02:00', closingTime: '2026-10-22T22:00:00+02:00' },
      ],
    };
    expect(parseSchedule(json, at(10))).toEqual({ open: at(9, 30), close: at(22), emh: { open: at(8, 30), close: at(9, 30) } });
    expect(parseSchedule({ schedule: [] }, at(10))).toBeNull();
  });
});

describe('catalog merge', () => {
  it('matches API names to the seed', () => {
    expect(namesMatch(normalizeName('Autopia, presented by Avis'), normalizeName('Autopia'))).toBe(true);
    expect(namesMatch(normalizeName('Phantom Manor'), normalizeName('Big Thunder Mountain'))).toBe(false);
    expect(normalizeName('Indiana Jones™ and the Temple of Peril')).toBe('indiana jones and temple of peril');
  });

  it('merges positions, single-rider twins and unknown entities', () => {
    const merged = mergeCatalog(seedCatalog(), parseChildren(children).map((entity) => ({ park: 'dlp' as const, entity })), parkGates(DLP, []));
    expect(merged.idMap.get('btm')).toEqual({ id: 'dlp-big-thunder', single: false });
    expect(merged.idMap.get('auto')).toEqual({ id: 'dlp-autopia', single: false });
    expect(merged.idMap.get('hsm-sr')).toEqual({ id: 'dlp-hyperspace', single: true });
    expect(merged.catalog.get('dlp-big-thunder')).toMatchObject({ lat: 48.8741, lon: 2.7711 });
    const added = merged.catalog.get('api-new');
    expect(added?.name).toBe('Nouvelle <b>Attraction</b>'); // kept as plain text, rendered escaped
    // Far-away coordinates are rejected in favour of the park gate.
    expect(added?.lat).toBeCloseTo(48.87, 1);
  });

  it('builds a snapshot with API queue options winning over the seed', () => {
    const merged = mergeCatalog(seedCatalog(), parseChildren(children).map((entity) => ({ park: 'dlp' as const, entity })), parkGates(DLP, []));
    const snap = buildSnapshot(merged, parseLive(live), {}, at(10), curatedParks(), DLP);
    expect(snap.attractions['dlp-big-thunder']).toMatchObject({ status: 'OPERATING', standby: 45 });
    expect(snap.attractions['dlp-autopia']?.status).toBe('DOWN');
    expect(snap.attractions['dlp-hyperspace']?.singleRider).toBe(15);
    expect(merged.catalog.get('dlp-big-thunder')).toMatchObject({ premierAccess: true });
    expect(snap.hours.dlp?.close).toBe(at(22));
  });
});

describe('live loading', () => {
  function mockFetch(routes: Record<string, unknown>, status = 200): FetchFn {
    return async (url) => {
      const path = url.replace('https://api.themeparks.wiki/v1', '');
      const body = routes[path];
      return { ok: status === 200 && body !== undefined, status: body === undefined ? 404 : status, json: async () => body };
    };
  }

  it('loads both parks end to end', async () => {
    const fetchFn = mockFetch({
      '/destinations': destinations,
      [`/entity/${DLP_ID}/children`]: children,
      [`/entity/${DLP_ID}/live`]: live,
      [`/entity/${DLP_ID}/schedule`]: { schedule: [] },
      [`/entity/${DAW_ID}/children`]: { children: [{ id: 'crush', name: "Crush's Coaster", entityType: 'ATTRACTION' }] },
      [`/entity/${DAW_ID}/live`]: { liveData: [{ id: 'crush', name: "Crush's Coaster", entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 70 } } }] },
      [`/entity/${DAW_ID}/schedule`]: { schedule: [] },
    });
    const bundle = await loadLive(fetchFn, DLP, seedCatalog(), at(10));
    expect(bundle.snapshot.source).toBe('live');
    expect(bundle.snapshot.attractions['daw-crush']?.standby).toBe(70);
    expect(bundle.snapshot.attractions['dlp-big-thunder']?.standby).toBe(45);
  });

  it('fails cleanly on HTTP errors and garbage', async () => {
    await expect(loadLive(mockFetch({ '/destinations': destinations }, 500), DLP, seedCatalog(), at(10))).rejects.toBeInstanceOf(LiveDataError);
    await expect(loadLive(mockFetch({ '/destinations': { destinations: 'x' } }), DLP, seedCatalog(), at(10))).rejects.toBeInstanceOf(LiveDataError);
    const throwing: FetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(loadLive(throwing, DLP, seedCatalog(), at(10))).rejects.toThrow('Réseau indisponible');
  });
});

describe('demo data', () => {
  it('is deterministic and realistic', () => {
    const a = demoSnapshot(at(11), catalog);
    const b = demoSnapshot(at(11), catalog);
    expect(a).toEqual(b);
    for (const live of Object.values(a.attractions)) {
      if (live.status !== 'OPERATING') continue;
      expect(live.standby! % 5).toBe(0);
      expect(live.standby!).toBeGreaterThanOrEqual(5);
    }
    expect(a.showtimes['daw-show-arendelle']?.length).toBeGreaterThan(0);
  });

  it('closes rides outside opening hours and honours simulated breakdowns', () => {
    expect(demoSnapshot(at(8), catalog).attractions['dlp-buzz']?.status).toBe('CLOSED');
    expect(demoSnapshot(at(21, 30), catalog).attractions['daw-crush']?.status).toBe('CLOSED');
    const forced = demoSnapshot(at(12), catalog, { forcedDown: { 'dlp-buzz': at(12) + 30 * MINUTE } });
    expect(forced.attractions['dlp-buzz']?.status).toBe('DOWN');
  });
});
