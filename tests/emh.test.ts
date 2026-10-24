import { describe, expect, it } from 'vitest';
import { demoSnapshot } from '../src/data/demo';
import { parseSchedule } from '../src/data/themeparks';
import { availableFrom, computePlan } from '../src/domain/planner';
import { DEFAULT_PROFILE, parseProfile } from '../src/state/storage';
import { at, catalog, input, profile, snapshot } from './helpers';

const ride = (id: string) => {
  const p = catalog.get(id);
  if (p?.kind !== 'ride') throw new Error(id);
  return p;
};

describe('Extra Magic Hours', () => {
  it('reads EXTRA_HOURS from the official schedule', () => {
    const json = {
      schedule: [
        { date: '2026-10-22', type: 'EXTRA_HOURS', openingTime: '2026-10-22T08:30:00+02:00', closingTime: '2026-10-22T09:30:00+02:00' },
        { date: '2026-10-22', type: 'OPERATING', openingTime: '2026-10-22T09:30:00+02:00', closingTime: '2026-10-22T22:00:00+02:00' },
        { date: '2026-10-22', type: 'TICKETED_EVENT', openingTime: '2026-10-22T22:00:00+02:00', closingTime: '2026-10-23T01:00:00+02:00' },
      ],
    };
    expect(parseSchedule(json, at(8))).toEqual({ open: at(9, 30), close: at(22), emh: { open: at(8, 30), close: at(9, 30) } });
  });

  // 08:40: an EMH ride is operating, a regular ride is closed until opening.
  const early = snapshot({ 'dlp-peter-pan': { status: 'OPERATING', standby: 10 }, 'dlp-big-thunder': { status: 'CLOSED', standby: null } }, at(8, 40));

  it('lets eligible groups ride early, others from official opening', () => {
    const base = { now: at(8, 40), snapshot: early };
    expect(availableFrom(ride('dlp-peter-pan'), { ...base, profile: profile({ emhAccess: true }) })).toBe(at(8, 30));
    expect(availableFrom(ride('dlp-peter-pan'), { ...base, profile: profile() })).toBe(at(9, 30));
    expect(availableFrom(ride('dlp-big-thunder'), { ...base, profile: profile({ emhAccess: true }) })).toBe(at(9, 30));
  });

  it('plans before opening instead of reporting rides as closed', () => {
    const wishList: Array<[string, 'must']> = [['dlp-peter-pan', 'must'], ['dlp-big-thunder', 'must']];
    const eligible = computePlan(input({ now: at(8, 40), snapshot: early, wishList, profile: profile({ emhAccess: true }) }));
    expect(eligible.unplanned).toEqual([]);
    expect(eligible.steps[0]?.targetId).toBe('dlp-peter-pan');
    expect(eligible.steps[0]!.arriveAt).toBeLessThan(at(9, 30));
    const regular = computePlan(input({ now: at(8, 40), snapshot: early, wishList }));
    expect(regular.steps).toHaveLength(2);
    expect(regular.steps.every((s) => s.arriveAt >= at(9, 30))).toBe(true);
  });

  it('treats a ride closed after opening as closed for the day', () => {
    const snap = snapshot({ 'dlp-big-thunder': { status: 'CLOSED', standby: null } }, at(11));
    expect(availableFrom(ride('dlp-big-thunder'), { now: at(11), snapshot: snap, profile: profile() })).toBeNull();
  });

  it('simulates EMH in the demo (two lands only)', () => {
    const snap = demoSnapshot(at(8, 45), catalog);
    expect(snap.hours.dlp?.emh).toEqual({ open: at(8, 30), close: at(9, 30) });
    expect(snap.attractions['dlp-peter-pan']?.status).toBe('OPERATING');
    expect(snap.attractions['dlp-big-thunder']?.status).toBe('CLOSED');
    expect(snap.attractions['daw-crush']?.status).toBe('CLOSED');
  });

  it('keeps v0.1 profiles valid (no EMH field)', () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_PROFILE };
    delete legacy.emhAccess;
    expect(parseProfile(legacy)?.emhAccess).toBe(false);
    expect(parseProfile({ ...DEFAULT_PROFILE, emhAccess: 'yes' })).toBeNull();
  });
});
