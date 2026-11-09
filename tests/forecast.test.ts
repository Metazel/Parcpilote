import { describe, expect, it } from 'vitest';
import { destination } from '../src/data/destinations';
import { TYPICAL_PEAK_WAIT, arrivalAdvice, dateRef, forecastSnapshot } from '../src/data/forecast';
import { type FetchFn, parseOpenings } from '../src/data/themeparks';
import { MINUTE, parkDateKey } from '../src/domain/time';
import type { ParkInfo, Place } from '../src/domain/types';
import { DEFAULT_PROFILE } from '../src/state/storage';
import { AppStore } from '../src/state/store';
import { MemoryStorage, at } from './helpers';

const iso = (day: string, hm: string) => `${day}T${hm}:00+01:00`;
const FUT = destination('futuroscope');
const gate = { lat: 46.668, lon: 0.3676 };
const parks: ParkInfo[] = [{ id: 'fut', name: 'Futuroscope', short: 'Futuroscope', entrance: gate, color: 0 }];
const ride = (id: string, intensity: 1 | 2 | 3, dLat = 0): Place => ({ kind: 'ride', id, name: id, park: 'fut', land: 'Futuroscope', lat: gate.lat + dLat, lon: gate.lon, durationMin: 5, minHeightCm: 0, singleRider: false, premierAccess: false, intensity });

describe('published opening days', () => {
  it('keeps days from today on, with Extra Magic Hours, ignoring broken entries', () => {
    const json = {
      schedule: [
        { type: 'OPERATING', openingTime: iso('2026-11-08', '10:00'), closingTime: iso('2026-11-08', '18:00') },
        { type: 'OPERATING', openingTime: iso('2026-11-14', '10:00'), closingTime: iso('2026-11-14', '21:30') },
        { type: 'EXTRA_HOURS', openingTime: iso('2026-11-14', '09:00'), closingTime: iso('2026-11-14', '10:00') },
        { type: 'OPERATING', openingTime: iso('2026-11-15', '10:00'), closingTime: 'demain' },
        { type: 'TICKETED_EVENT', openingTime: iso('2026-11-16', '19:00'), closingTime: iso('2026-11-16', '23:00') },
        { type: 'OPERATING', openingTime: iso('2026-11-20', '10:00'), closingTime: iso('2026-11-22', '18:00') },
      ],
    };
    const days = parseOpenings(json, Date.parse(iso('2026-11-09', '08:00')));
    expect([...days.keys()]).toEqual(['2026-11-14']);
    expect(days.get('2026-11-14')).toEqual({
      open: Date.parse(iso('2026-11-14', '10:00')),
      close: Date.parse(iso('2026-11-14', '21:30')),
      emh: { open: Date.parse(iso('2026-11-14', '09:00')), close: Date.parse(iso('2026-11-14', '10:00')) },
    });
    expect(parseOpenings('x', 0).size).toBe(0);
  });
});

describe('forecast of a day to come', () => {
  const catalog = new Map<string, Place>([
    ['big', ride('big', 3)],
    ['kid', ride('kid', 1, 0.001)],
  ]);

  it('uses the published hours, else the usual ones, with typical waits that grow later', () => {
    const published = { fut: { open: Date.parse(iso('2026-11-14', '10:00')), close: Date.parse(iso('2026-11-14', '21:30')), emh: null } };
    const snap = forecastSnapshot(FUT, catalog, parks, '2026-11-14', published);
    expect(snap.hours.fut).toEqual(published.fut);
    expect(snap.fetchedAt).toBe(published.fut.open);
    const big = snap.attractions.big!.standby!;
    const kid = snap.attractions.kid!.standby!;
    expect(big).toBeGreaterThan(kid);
    expect(big).toBeLessThan(TYPICAL_PEAK_WAIT[3]);
    expect(snap.showtimes).toEqual({});

    const usual = forecastSnapshot(FUT, catalog, parks, '2026-11-15', null);
    expect(parkDateKey(usual.hours.fut!.open)).toBe('2026-11-15');
    expect(new Date(usual.hours.fut!.open).toISOString()).toBe('2026-11-15T09:00:00.000Z'); // 10:00 in Paris

    // A day whose calendar does not open this park: nothing to plan there.
    const other = forecastSnapshot(FUT, catalog, parks, '2026-11-14', {});
    expect(other.parks).toEqual([]);
    expect(other.attractions).toEqual({});
  });

  it('advises to be at the gates 30 minutes before the first opening', () => {
    const snap = forecastSnapshot(FUT, catalog, parks, '2026-11-14', { fut: { open: dateRef('2026-11-14'), close: dateRef('2026-11-14') + 8 * 60 * MINUTE, emh: { open: dateRef('2026-11-14') - 60 * MINUTE, close: dateRef('2026-11-14') } } });
    expect(arrivalAdvice(snap, false)).toBe(dateRef('2026-11-14') - 30 * MINUTE);
    expect(arrivalAdvice(snap, true)).toBe(dateRef('2026-11-14') - 90 * MINUTE);
  });

  it('plans Disneyland Paris on the demo day model, with Extra Magic Hours', async () => {
    const store = new AppStore({ storage: new MemoryStorage(), fetchFn: null, realNow: () => at(10) });
    store.saveProfile({ ...DEFAULT_PROFILE, emhAccess: true, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    store.setWish('dlp-big-thunder', 'must');
    store.setWish('dlp-peter-pan', 'must');
    const before = JSON.stringify(store.getState().persisted.day);
    const day = parkDateKey(at(10) + 3 * 24 * 60 * MINUTE);
    const f = (await store.forecast(day))!;
    expect(f.published).toBe(false);
    expect(parkDateKey(f.plan.steps[0]!.startAt)).toBe(day);
    expect(f.plan.steps.map((s) => s.targetId)).toEqual(expect.arrayContaining(['dlp-big-thunder', 'dlp-peter-pan']));
    expect(f.arriveBy).not.toBeNull();
    // Preview only: today's progress is untouched.
    expect(JSON.stringify(store.getState().persisted.day)).toBe(before);
    expect(await store.forecast('demain')).toBeNull();
  });

  it('offers the published opening days, else the next two weeks', async () => {
    const store = new AppStore({ storage: new MemoryStorage(), fetchFn: null, realNow: () => at(10) });
    const days = store.prepDays();
    expect(days).toHaveLength(14);
    expect(days.every((d) => !d.published && d.dateKey > parkDateKey(at(10)))).toBe(true);
    store.setPrepDate(days[0]!.dateKey);
    expect(store.getState().prepDate).toBe(days[0]!.dateKey);
    store.setPrepDate('<script>');
    expect(store.getState().prepDate).toBe(days[0]!.dateKey);
    store.setPrepDate(null);
    expect(store.getState().prepDate).toBeNull();
  });

  it('reads the calendar of a live park and plans the chosen day from it', async () => {
    const api: Record<string, unknown> = {
      '/destinations': { destinations: [{ slug: 'futuroscopedestination', name: 'Futuroscope', parks: [{ id: 'fut', name: 'Futuroscope' }] }] },
      '/entity/fut/children': { children: [{ id: 'r1', name: 'Objectif Mars', entityType: 'ATTRACTION', location: { latitude: 46.668, longitude: 0.3676 } }] },
      '/entity/fut/live': { liveData: [{ id: 'r1', name: 'Objectif Mars', entityType: 'ATTRACTION', status: 'CLOSED' }] },
      '/entity/fut/schedule': { schedule: [{ type: 'OPERATING', openingTime: '2026-10-24T10:00:00+02:00', closingTime: '2026-10-24T21:30:00+02:00' }] },
    };
    const fetchFn: FetchFn = async (url) => {
      const body = api[url.replace('https://api.themeparks.wiki/v1', '')];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };
    const store = new AppStore({ storage: new MemoryStorage(), fetchFn, realNow: () => at(10) });
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    await store.setDestination('futuroscope');
    expect(store.prepDays()).toEqual([{ dateKey: '2026-10-24', published: true }]);
    store.setWish('api-r1', 'must');
    const f = (await store.forecast('2026-10-24'))!;
    expect(f.published).toBe(true);
    expect(f.plan.steps[0]).toMatchObject({ targetId: 'api-r1' });
    expect(f.plan.steps[0]!.startAt).toBeGreaterThanOrEqual(Date.parse('2026-10-24T10:00:00+02:00'));
    expect(f.arriveBy).toBe(Date.parse('2026-10-24T09:30:00+02:00'));
  });
});
