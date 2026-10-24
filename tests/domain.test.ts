import { describe, expect, it } from 'vitest';
import { PARK_ENTRANCES, PARK_SWITCH_PENALTY_MIN, haversineM, walkMinutes } from '../src/domain/geo';
import { crowdFactor, crowdLevel, predictWait, updateCorrection } from '../src/domain/waits';
import { formatHM, minuteOfDayFn, parkDateKey, parkMinutesOfDay, parkWallTime } from '../src/domain/time';
import { at, catalog, snapshot } from './helpers';

const ride = (id: string) => {
  const p = catalog.get(id);
  if (!p) throw new Error(id);
  return p;
};

describe('time (Europe/Paris)', () => {
  it('converts wall time both ways, including across DST', () => {
    const t = at(9, 30);
    expect(parkMinutesOfDay(t)).toBe(570);
    expect(formatHM(t)).toBe('09:30');
    expect(parkDateKey(t)).toBe('2026-10-22');
    // 25 Oct 2026 is the DST switch day in France.
    const dst = parkWallTime(Date.UTC(2026, 9, 25, 12), 10 * 60);
    expect(formatHM(dst)).toBe('10:00');
  });

  it('fast minutes-of-day matches the Intl version all day', () => {
    const ref = at(9, 30) + 37_123; // with seconds
    const fast = minuteOfDayFn(ref);
    for (let t = at(8); t <= at(23, 59); t += 7 * 60_000 + 13_000) expect(fast(t)).toBe(parkMinutesOfDay(t));
  });
});

describe('walking model', () => {
  it('measures distances', () => {
    expect(haversineM({ lat: 48.87, lon: 2.77 }, { lat: 48.871, lon: 2.77 })).toBeCloseTo(111, 0);
  });

  it('is zero in place, positive elsewhere, slower with a stroller or a slow pace', () => {
    const a = ride('dlp-peter-pan');
    const b = ride('dlp-big-thunder');
    const normal = { pace: 'normal' as const, stroller: false };
    expect(walkMinutes(a, a, normal)).toBe(0);
    const base = walkMinutes(a, b, normal);
    expect(base).toBeGreaterThan(0);
    expect(walkMinutes(a, b, { pace: 'normal', stroller: true })).toBeGreaterThanOrEqual(base);
    expect(walkMinutes(a, b, { pace: 'slow', stroller: false })).toBeGreaterThanOrEqual(base);
    expect(walkMinutes(a, b, { pace: 'fast', stroller: false })).toBeLessThanOrEqual(base);
  });

  it('adds the park switch penalty between parks', () => {
    const t = walkMinutes(PARK_ENTRANCES.dlp, PARK_ENTRANCES.daw, { pace: 'normal', stroller: false });
    expect(t).toBeGreaterThanOrEqual(PARK_SWITCH_PENALTY_MIN);
    expect(walkMinutes(ride('dlp-buzz'), ride('daw-crush'), { pace: 'normal', stroller: false })).toBeGreaterThan(t);
  });
});

describe('wait forecast', () => {
  it('keeps the posted wait for an immediate arrival', () => {
    expect(predictWait(23, at(10), at(10, 5))).toBe(25);
  });

  it('expects busier early afternoons and quieter evenings', () => {
    expect(predictWait(30, at(10), at(14))).toBeGreaterThan(30);
    expect(predictWait(60, at(14), at(21))).toBeLessThan(60);
    expect(crowdFactor(14 * 60)).toBe(1);
  });

  it('applies the local correction progressively', () => {
    const c1 = updateCorrection(undefined, 40, 20);
    expect(c1.samples).toBe(1);
    expect(c1.ratio).toBeCloseTo(0.5);
    const once = predictWait(40, at(10), at(10), c1);
    const c3 = updateCorrection(updateCorrection(c1, 40, 20), 40, 20);
    const thrice = predictWait(40, at(10), at(10), c3);
    expect(once).toBeLessThan(40);
    expect(thrice).toBeLessThan(once);
  });

  it('clamps absurd reports', () => {
    expect(updateCorrection(undefined, 10, 300).ratio).toBeLessThanOrEqual(1.5);
    expect(updateCorrection(undefined, 0, 30).ratio).toBe(1);
  });

  it('derives the crowd level from posted waits', () => {
    const ids = [...catalog.values()].filter((p) => p.kind === 'ride').map((p) => p.id);
    const all = (standby: number) => Object.fromEntries(ids.map((id) => [id, { standby }]));
    expect(crowdLevel(snapshot(all(10)))).toBe('low');
    expect(crowdLevel(snapshot(all(30)))).toBe('mid');
    expect(crowdLevel(snapshot(all(50)))).toBe('high');
  });
});
