import { seedCatalog } from '../src/data/catalog';
import { curatedParks } from '../src/data/demo';
import { DEFAULT_PROFILE } from '../src/state/storage';
import type { StorageLike } from '../src/state/storage';
import { MINUTE, parkWallTime } from '../src/domain/time';
import type { GroupProfile, LiveAttraction, LiveSnapshot, Place, Priority } from '../src/domain/types';
import type { PlanInput } from '../src/domain/planner';
import { PARK_ENTRANCES } from '../src/domain/geo';

/** 22 Oct 2026 — a fixed park day for reproducible tests. */
export const DAY_REF = Date.UTC(2026, 9, 22, 12, 0);
export const at = (hh: number, mm = 0) => parkWallTime(DAY_REF, hh * 60 + mm);

export const catalog: Map<string, Place> = seedCatalog();

export function snapshot(overrides: Record<string, Partial<LiveAttraction>> = {}, now = at(10), showtimes: Record<string, number[]> = {}): LiveSnapshot {
  const attractions: Record<string, LiveAttraction> = {};
  for (const p of catalog.values()) {
    if (p.kind !== 'ride') continue;
    attractions[p.id] = { status: 'OPERATING', standby: 20, singleRider: p.singleRider ? 10 : null, pa: null, ...overrides[p.id] };
  }
  return {
    source: 'demo',
    fetchedAt: now,
    parks: curatedParks(),
    attractions,
    showtimes,
    hours: {
      dlp: { open: at(9, 30), close: at(22), emh: { open: at(8, 30), close: at(9, 30) } },
      daw: { open: at(9, 30), close: at(21), emh: null },
    },
  };
}

export function profile(p: Partial<GroupProfile> = {}): GroupProfile {
  return { ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false }, ...p };
}

export function input(p: Partial<PlanInput> & { wishList?: Array<[string, Priority]> } = {}): PlanInput {
  const { wishList, ...rest } = p;
  return {
    now: at(10),
    position: PARK_ENTRANCES.dlp,
    positionKey: 'gate-dlp',
    catalog,
    snapshot: snapshot(),
    profile: profile(),
    wishes: new Map(wishList ?? []),
    shows: [],
    paBookings: [],
    done: new Set(),
    lunchDone: false,
    corrections: {},
    ...rest,
  };
}

export class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

export { MINUTE };
