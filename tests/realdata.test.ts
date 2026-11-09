import { describe, expect, it } from 'vitest';
import { destination } from '../src/data/destinations';
import { type FetchFn, loadLive, parseDestinations, placeFromSights, scheduleOutlook } from '../src/data/themeparks';
import type { CompactSight } from '../src/domain/walkGraph';
import type { ParkInfo, Place } from '../src/domain/types';
import { liveNotice } from '../src/state/store';
import { at } from './helpers';

/**
 * Cases found on the real ThemeParks.wiki feed on 09/11/2026 (structures as observed, values
 * made up): destinations bundling a water park or an event, a feed without any position,
 * closed days with a published calendar, and parks that publish no calendar at all.
 */

const NIGLO = destination('nigloland');
const EUROPA = destination('europapark');
const PORTA = destination('portaventura');

function routeFetch(routes: Record<string, unknown>): FetchFn {
  return async (url) => {
    const body = routes[url.replace('https://api.themeparks.wiki/v1', '')];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

const iso = (day: string, hm: string) => `${day}T${hm}:00+02:00`;

describe('real feed: destinations bundling other parks', () => {
  it('keeps only the main park of Europa-Park and PortAventura World', () => {
    const json = {
      destinations: [
        { slug: 'europapark', name: 'Europa-Park', parks: [{ id: 'trauma', name: 'Traumatica' }, { id: 'rul', name: 'Rulantica' }, { id: 'ep', name: 'Europa-Park' }] },
        { slug: 'portaventuraworld', name: 'PortAventura World', parks: [{ id: 'pa', name: 'PortAventura Park' }, { id: 'fl', name: 'Ferrari Land' }, { id: 'car', name: 'Caribe Aquatic Park' }] },
      ],
    };
    expect(parseDestinations(json, EUROPA)).toEqual([{ id: 'ep', park: 'ep', name: 'Europa-Park' }]);
    expect(parseDestinations(json, PORTA)).toEqual([{ id: 'pa', park: 'pa', name: 'PortAventura Park' }]);
  });
});

describe('real feed: Nigloland gives no position', () => {
  const routes = (schedule: unknown) => ({
    '/destinations': { destinations: [{ slug: 'niglolandresort', name: 'Nigloland', parks: [{ id: 'nig', name: 'Nigloland' }] }] },
    '/entity/nig/children': {
      children: [
        { id: 'r1', name: 'Krampus Expédition', entityType: 'ATTRACTION' },
        { id: 'r2', name: 'La Tour des Petits Fantômes', entityType: 'ATTRACTION', location: null },
        { id: 's1', name: 'Spectacle', entityType: 'SHOW' },
      ],
    },
    '/entity/nig/live': {
      liveData: [
        { id: 'r1', name: 'Krampus Expédition', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 15 } } },
        { id: 'r2', name: 'La Tour des Petits Fantômes', entityType: 'ATTRACTION', status: 'CLOSED' },
      ],
    },
    '/entity/nig/schedule': schedule,
  });

  it('places the park at its known centre instead of dropping every attraction', async () => {
    const bundle = await loadLive(routeFetch(routes({ schedule: [{ date: '2026-10-22', type: 'OPERATING', openingTime: iso('2026-10-22', '10:00'), closingTime: iso('2026-10-22', '19:00') }] })), NIGLO, new Map(), at(11));
    expect(bundle.snapshot.parks).toEqual([expect.objectContaining({ id: 'nig', entrance: NIGLO.center })]);
    const rides = [...bundle.catalog.values()].filter((p) => p.kind === 'ride');
    expect(rides).toHaveLength(2);
    for (const r of rides) expect({ lat: r.lat, lon: r.lon }).toEqual(NIGLO.center);
    expect(bundle.snapshot.attractions['api-r1']?.standby).toBe(15);
    expect(bundle.closure).toBeNull();
    expect(bundle.hoursUnknown).toBe(false);
  });

  it('then takes positions from OpenStreetMap by name, articles and spelling aside', async () => {
    const bundle = await loadLive(routeFetch(routes({ schedule: [] })), NIGLO, new Map(), at(11));
    const sights: CompactSight[] = [
      ['Krampus Expedition', 48.2635, 4.615, 'ride'],
      ['Tour des Petits Fantômes', 48.2621, 4.6131, 'ride'],
      ['Krampus Expédition', 45.0, 1.0, 'ride'],
    ];
    const placed = placeFromSights(bundle.catalog, sights, bundle.snapshot.parks)!;
    expect(placed.get('api-r1')).toMatchObject({ lat: 48.2635, lon: 4.615 });
    expect(placed.get('api-r2')).toMatchObject({ lat: 48.2621, lon: 4.6131 });
    expect(placed.get('api-s1')).toMatchObject(NIGLO.center!);
    // Places with their own position are never moved, and nothing to place returns null.
    expect(placeFromSights(placed, sights, bundle.snapshot.parks)).toBeNull();
    expect(placeFromSights(bundle.catalog, [], bundle.snapshot.parks)).toBeNull();
  });
});

describe('real feed: closed days and missing calendars', () => {
  const routes = (schedule: unknown, status = 'OPERATING') => ({
    '/destinations': { destinations: [{ slug: 'futuroscopedestination', name: 'Futuroscope', parks: [{ id: 'fut', name: 'Futuroscope' }] }] },
    '/entity/fut/children': { children: [{ id: 'r1', name: 'Objectif Mars', entityType: 'ATTRACTION', location: { latitude: 46.668, longitude: 0.3676 } }, { id: 's1', name: 'La Clé des Songes', entityType: 'SHOW', location: { latitude: 46.669, longitude: 0.368 } }] },
    '/entity/fut/live': {
      liveData: [
        { id: 'r1', name: 'Objectif Mars', entityType: 'ATTRACTION', status, queue: { STANDBY: { waitTime: 25 } } },
        { id: 's1', name: 'La Clé des Songes', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ startTime: iso('2026-10-22', '21:00') }] },
      ],
    },
    '/entity/fut/schedule': schedule,
  });
  const later = {
    schedule: [
      { date: '2026-10-24', type: 'OPERATING', openingTime: iso('2026-10-24', '10:00'), closingTime: iso('2026-10-24', '21:30') },
      { date: '2026-10-25', type: 'OPERATING', openingTime: iso('2026-10-25', '10:00'), closingTime: iso('2026-10-25', '18:30') },
      { date: '2026-10-21', type: 'OPERATING', openingTime: iso('2026-10-21', '10:00'), closingTime: iso('2026-10-21', '18:00') },
    ],
  };

  it('reads the next opening day from the calendar', () => {
    expect(scheduleOutlook(later, at(10))).toEqual({ known: true, next: { open: Date.parse(iso('2026-10-24', '10:00')), close: Date.parse(iso('2026-10-24', '21:30')) } });
    expect(scheduleOutlook({ schedule: [] }, at(10))).toEqual({ known: false, next: null });
    expect(scheduleOutlook({ schedule: [{ type: 'OPERATING', openingTime: 'x', closingTime: 3 }] }, at(10))).toEqual({ known: false, next: null });
    expect(scheduleOutlook('nope', at(10))).toEqual({ known: false, next: null });
  });

  it('closes the park for the day and ignores stale statuses and sessions', async () => {
    const bundle = await loadLive(routeFetch(routes(later)), destination('futuroscope'), new Map(), at(10));
    expect(bundle.closure?.next?.open).toBe(Date.parse(iso('2026-10-24', '10:00')));
    const h = bundle.snapshot.hours.fut!;
    expect(h.close).toBeLessThanOrEqual(at(10));
    expect(bundle.snapshot.attractions['api-r1']).toMatchObject({ status: 'CLOSED', standby: null });
    expect(bundle.snapshot.showtimes['api-s1'] ?? []).toEqual([]);
    const notice = liveNotice(destination('futuroscope'), bundle);
    expect(notice).toContain('Futuroscope est fermé aujourd’hui');
    expect(notice).toContain('samedi 24 octobre, 10:00–21:30');
  });

  it('says when a park publishes no calendar, and stays quiet on a normal day', async () => {
    const none = await loadLive(routeFetch(routes({ schedule: [] })), destination('futuroscope'), new Map(), at(10));
    expect(none.closure).toBeNull();
    expect(none.hoursUnknown).toBe(true);
    expect(liveNotice(destination('futuroscope'), none)).toBe('Futuroscope ne publie pas ses horaires du jour : 10:00–18:00 supposés. Vérifiez-les sur le site officiel avant de partir.');
    const open = await loadLive(routeFetch(routes(later)), destination('futuroscope'), new Map(), Date.parse(iso('2026-10-21', '11:00')));
    expect(open.closure).toBeNull();
    expect(open.hoursUnknown).toBe(false);
    expect(liveNotice(destination('futuroscope'), open)).toBeNull();
    expect(open.snapshot.attractions['api-r1']?.standby).toBe(25);
  });
});

describe('placing from OpenStreetMap stays within the park', () => {
  it('ignores places of other parks and sights too far from the entrance', () => {
    const gate = { lat: 48.0, lon: 4.0 };
    const parks: ParkInfo[] = [{ id: 'p', name: 'P', short: 'P', entrance: gate, color: 0 }];
    const ride = (id: string, name: string, park = 'p'): Place => ({ kind: 'ride', id, name, park, land: 'P', ...gate, durationMin: 5, minHeightCm: 0, singleRider: false, premierAccess: false, intensity: 1 });
    const catalog = new Map<string, Place>([
      ['a', ride('a', 'Grand Huit')],
      ['b', ride('b', 'Grand Huit', 'other')],
    ]);
    expect(placeFromSights(catalog, [['Grand Huit', 48.5, 4.5, 'ride']], parks)).toBeNull();
    const placed = placeFromSights(catalog, [['Grand Huit', 48.001, 4.001, 'ride']], parks)!;
    expect(placed.get('a')).toMatchObject({ lat: 48.001, lon: 4.001 });
    expect(placed.get('b')).toMatchObject(gate);
  });
});

describe('real feed: Nigloland in the app', () => {
  it('tries OpenStreetMap again after a busy Overpass, then places the attractions', async () => {
    const { AppStore } = await import('../src/state/store');
    const { MemoryStorage } = await import('./helpers');
    let overpassCalls = 0;
    const api: Record<string, unknown> = {
      '/destinations': { destinations: [{ slug: 'niglolandresort', name: 'Nigloland', parks: [{ id: 'nig', name: 'Nigloland' }] }] },
      '/entity/nig/children': { children: [{ id: 'r1', name: 'Krampus Expédition', entityType: 'ATTRACTION' }] },
      '/entity/nig/live': { liveData: [{ id: 'r1', name: 'Krampus Expédition', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 15 } } }] },
      '/entity/nig/schedule': { schedule: [] },
    };
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith('https://overpass-api.de/')) {
        overpassCalls++;
        if (overpassCalls === 1) return { ok: false, status: 502, json: async () => null };
        return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 1, lat: 48.2635, lon: 4.615, tags: { attraction: 'roller_coaster', name: 'Krampus Expedition' } }] }) };
      }
      const body = api[url.replace('https://api.themeparks.wiki/v1', '')];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };
    const store = new AppStore({ storage: new MemoryStorage(), fetchFn, realNow: () => at(11) });
    await store.setDestination('nigloland');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().data.mode).toBe('live');
    // The first download fails; the live load that follows tries once more, and succeeds.
    expect(overpassCalls).toBe(2);
    expect(store.getState().catalog.get('api-r1')).toMatchObject({ lat: 48.2635, lon: 4.615 });
    // A later live refresh keeps the OpenStreetMap position.
    await store.refresh();
    expect(store.getState().catalog.get('api-r1')).toMatchObject({ lat: 48.2635, lon: 4.615 });
    expect(overpassCalls).toBe(2);
  });
});
