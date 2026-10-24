import { parkDateKey } from '../domain/time';
import type {
  EasyAccessReservation,
  GroupProfile,
  LiveAttraction,
  LiveSnapshot,
  PaBooking,
  Pace,
  ParkHours,
  ParkId,
  Position,
  Priority,
  ShowPick,
  WaitCorrection,
} from '../domain/types';
import { arr, bool, int, isRecord, num, oneOf, safeId } from '../data/validate';
import { MAX_REPEATS } from '../domain/planner';

/**
 * Persistence on the device only (localStorage). Everything read back is treated as
 * untrusted and validated field by field; anything invalid falls back to defaults.
 */

export const STORAGE_KEY = 'parcpilote:v1';
const MAX_BYTES = 512 * 1024;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DayProgress {
  readonly dateKey: string;
  readonly done: readonly string[];
  readonly skipped: readonly string[];
  readonly lunchDone: boolean;
  readonly position: (Position & { readonly key: string }) | null;
  readonly shows: readonly ShowPick[];
  readonly paBookings: readonly PaBooking[];
  /** Ride id → epoch until which the user reported it closed. */
  readonly closedReports: Readonly<Record<string, number>>;
  /** Demo only: ride id → epoch until which a breakdown is simulated. */
  readonly forcedDown: Readonly<Record<string, number>>;
  /** Carte Facilité registration currently held. */
  readonly easyAccess: EasyAccessReservation | null;
}

export interface DemoClock {
  /** Simulated epoch at `realBase`. */
  readonly base: number;
  readonly realBase: number;
  readonly speed: 1 | 10 | 60;
}

export interface Settings {
  readonly source: 'auto' | 'demo';
  readonly demoClock: DemoClock | null;
  readonly useGps: boolean;
}

export interface PersistedState {
  readonly version: 1;
  readonly profile: GroupProfile | null;
  readonly wishes: ReadonlyArray<readonly [string, Priority]>;
  /** Ride id → rides wanted today, only when more than one. */
  readonly repeats: Readonly<Record<string, number>>;
  readonly corrections: Readonly<Record<string, WaitCorrection>>;
  readonly day: DayProgress;
  readonly settings: Settings;
  readonly lastLive: LiveSnapshot | null;
}

export const DEFAULT_PROFILE: GroupProfile = {
  size: 4,
  smallestHeightCm: null,
  singleRiderOk: false,
  paBudgetEur: 0,
  pace: 'normal',
  stroller: false,
  lunch: { enabled: true, atMin: 12 * 60 + 30, durationMin: 45 },
  startPark: 'dlp',
  emhAccess: false,
  easyAccess: false,
};

export function emptyDay(now: number): DayProgress {
  return { dateKey: parkDateKey(now), done: [], skipped: [], lunchDone: false, position: null, shows: [], paBookings: [], closedReports: {}, forcedDown: {}, easyAccess: null };
}

export function defaultState(now: number): PersistedState {
  return {
    version: 1,
    profile: null,
    wishes: [],
    repeats: {},
    corrections: {},
    day: emptyDay(now),
    settings: { source: 'auto', demoClock: null, useGps: false },
    lastLive: null,
  };
}

const PARKS = ['dlp', 'daw'] as const satisfies readonly ParkId[];
const TIME_MIN = Date.UTC(2020, 0, 1);
const TIME_MAX = Date.UTC(2100, 0, 1);
const epoch = (v: unknown) => int(v, TIME_MIN, TIME_MAX);

export function parseProfile(v: unknown): GroupProfile | null {
  if (!isRecord(v) || !isRecord(v.lunch)) return null;
  const size = int(v.size, 1, 20);
  const smallest = v.smallestHeightCm === null ? null : int(v.smallestHeightCm, 60, 220);
  const singleRiderOk = bool(v.singleRiderOk);
  const paBudgetEur = num(v.paBudgetEur, 0, 1000);
  const pace = oneOf(v.pace, ['slow', 'normal', 'fast'] as const satisfies readonly Pace[]);
  const stroller = bool(v.stroller);
  const lunchEnabled = bool(v.lunch.enabled);
  const atMin = int(v.lunch.atMin, 10 * 60, 16 * 60);
  const durationMin = int(v.lunch.durationMin, 15, 120);
  const startPark = oneOf(v.startPark, PARKS);
  // Absent in profiles saved by v0.1: defaults to no access.
  const emhAccess = v.emhAccess === undefined ? false : bool(v.emhAccess);
  // Absent before v0.3: no Carte Facilité.
  const easyAccess = v.easyAccess === undefined ? false : bool(v.easyAccess);
  if (emhAccess === null || easyAccess === null) return null;
  if (size === null || (v.smallestHeightCm !== null && smallest === null) || singleRiderOk === null || paBudgetEur === null) return null;
  if (!pace || stroller === null || lunchEnabled === null || atMin === null || durationMin === null || !startPark) return null;
  return { size, smallestHeightCm: smallest, singleRiderOk, paBudgetEur, pace, stroller, lunch: { enabled: lunchEnabled, atMin, durationMin }, startPark, emhAccess, easyAccess };
}

function parseIdList(v: unknown, max = 300): string[] {
  const out: string[] = [];
  for (const x of arr(v, max) ?? []) {
    const id = safeId(x);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Ids in order, repeats kept (a ride done twice appears twice). */
function parseIdSequence(v: unknown, max = 300): string[] {
  const out: string[] = [];
  for (const x of arr(v, max) ?? []) {
    const id = safeId(x);
    if (id) out.push(id);
  }
  return out;
}

function parseRepeats(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, 300)) {
    const id = safeId(k);
    const n = int(val, 2, MAX_REPEATS);
    if (id && n !== null) out[id] = n;
  }
  return out;
}

function parseEasyAccess(v: unknown): EasyAccessReservation | null {
  if (!isRecord(v)) return null;
  const rideId = safeId(v.rideId);
  const returnAt = epoch(v.returnAt);
  return rideId && returnAt !== null ? { rideId, returnAt } : null;
}

function parseEpochMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, 300)) {
    const id = safeId(k);
    const t = epoch(val);
    if (id && t !== null) out[id] = t;
  }
  return out;
}

function parsePosition(v: unknown): (Position & { key: string }) | null {
  if (!isRecord(v)) return null;
  const lat = num(v.lat, -90, 90);
  const lon = num(v.lon, -180, 180);
  const park = oneOf(v.park, PARKS);
  const key = safeId(v.key);
  return lat !== null && lon !== null && park && key ? { lat, lon, park, key } : null;
}

function parseDay(v: unknown, now: number): DayProgress {
  const today = parkDateKey(now);
  if (!isRecord(v) || v.dateKey !== today) return emptyDay(now);
  const shows: ShowPick[] = [];
  for (const s of arr(v.shows, 20) ?? []) {
    if (!isRecord(s)) continue;
    const showId = safeId(s.showId);
    const start = epoch(s.start);
    if (showId && start !== null && !shows.some((x) => x.showId === showId)) shows.push({ showId, start });
  }
  const paBookings: PaBooking[] = [];
  for (const b of arr(v.paBookings, 30) ?? []) {
    if (!isRecord(b)) continue;
    const attractionId = safeId(b.attractionId);
    const returnStart = epoch(b.returnStart);
    const returnEnd = epoch(b.returnEnd);
    const priceCents = int(b.priceCents, 0, 100_000);
    if (attractionId && returnStart !== null && returnEnd !== null && returnEnd > returnStart && priceCents !== null) {
      paBookings.push(b.used === true ? { attractionId, returnStart, returnEnd, priceCents, used: true } : { attractionId, returnStart, returnEnd, priceCents });
    }
  }
  return {
    dateKey: today,
    done: parseIdSequence(v.done),
    skipped: parseIdList(v.skipped),
    lunchDone: bool(v.lunchDone) ?? false,
    position: parsePosition(v.position),
    shows,
    paBookings,
    closedReports: parseEpochMap(v.closedReports),
    forcedDown: parseEpochMap(v.forcedDown),
    easyAccess: parseEasyAccess(v.easyAccess),
  };
}

function parseCorrections(v: unknown): Record<string, WaitCorrection> {
  const out: Record<string, WaitCorrection> = {};
  if (!isRecord(v)) return out;
  for (const [k, c] of Object.entries(v).slice(0, 300)) {
    const id = safeId(k);
    if (!id || !isRecord(c)) continue;
    const ratio = num(c.ratio, 0.4, 1.5);
    const samples = int(c.samples, 1, 20);
    if (ratio !== null && samples !== null) out[id] = { ratio, samples };
  }
  return out;
}

function parseSettings(v: unknown): Settings {
  const d: Settings = { source: 'auto', demoClock: null, useGps: false };
  if (!isRecord(v)) return d;
  let demoClock: DemoClock | null = null;
  if (isRecord(v.demoClock)) {
    const base = epoch(v.demoClock.base);
    const realBase = epoch(v.demoClock.realBase);
    const speed = v.demoClock.speed === 1 || v.demoClock.speed === 10 || v.demoClock.speed === 60 ? v.demoClock.speed : null;
    if (base !== null && realBase !== null && speed !== null) demoClock = { base, realBase, speed };
  }
  return { source: oneOf(v.source, ['auto', 'demo'] as const) ?? 'auto', demoClock, useGps: bool(v.useGps) ?? false };
}

function parseLiveAttraction(v: unknown): LiveAttraction | null {
  if (!isRecord(v)) return null;
  const status = oneOf(v.status, ['OPERATING', 'DOWN', 'CLOSED', 'REFURBISHMENT'] as const);
  if (!status) return null;
  const wait = (x: unknown) => (x === null ? null : int(x, 0, 600));
  let pa: LiveAttraction['pa'] = null;
  if (isRecord(v.pa)) {
    const state = oneOf(v.pa.state, ['AVAILABLE', 'TEMP_FULL', 'FINISHED'] as const);
    if (state) {
      pa = {
        state,
        priceCents: v.pa.priceCents === null ? null : int(v.pa.priceCents, 0, 100_000),
        returnStart: v.pa.returnStart === null ? null : epoch(v.pa.returnStart),
        returnEnd: v.pa.returnEnd === null ? null : epoch(v.pa.returnEnd),
      };
    }
  }
  return { status, standby: wait(v.standby), singleRider: wait(v.singleRider), pa };
}

/** Only a live snapshot of the current day is kept (offline fallback). */
export function parseSnapshot(v: unknown, now: number): LiveSnapshot | null {
  if (!isRecord(v) || v.source !== 'live' || !isRecord(v.attractions) || !isRecord(v.showtimes) || !isRecord(v.hours)) return null;
  const fetchedAt = epoch(v.fetchedAt);
  if (fetchedAt === null || parkDateKey(fetchedAt) !== parkDateKey(now)) return null;
  const attractions: Record<string, LiveAttraction> = {};
  for (const [k, a] of Object.entries(v.attractions).slice(0, 500)) {
    const id = safeId(k);
    const parsed = parseLiveAttraction(a);
    if (id && parsed) attractions[id] = parsed;
  }
  const showtimes: Record<string, number[]> = {};
  for (const [k, list] of Object.entries(v.showtimes).slice(0, 200)) {
    const id = safeId(k);
    if (!id) continue;
    showtimes[id] = (arr(list, 50) ?? []).map(epoch).filter((t): t is number => t !== null);
  }
  const hours = {} as Record<ParkId, ParkHours>;
  for (const park of PARKS) {
    const h = v.hours[park];
    const open = isRecord(h) ? epoch(h.open) : null;
    const close = isRecord(h) ? epoch(h.close) : null;
    if (open === null || close === null || close <= open) return null;
    let emh: ParkHours['emh'] = null;
    if (isRecord(h) && isRecord(h.emh)) {
      const eo = epoch(h.emh.open);
      const ec = epoch(h.emh.close);
      if (eo !== null && ec !== null && ec > eo) emh = { open: eo, close: ec };
    }
    hours[park] = { open, close, emh };
  }
  return { source: 'live', fetchedAt, attractions, showtimes, hours };
}

export function loadState(storage: StorageLike, now: number): PersistedState {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return defaultState(now);
  }
  if (!raw || raw.length > MAX_BYTES) return defaultState(now);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return defaultState(now);
  }
  if (!isRecord(json) || json.version !== 1) return defaultState(now);
  const wishes: Array<[string, Priority]> = [];
  for (const w of arr(json.wishes, 300) ?? []) {
    if (!Array.isArray(w)) continue;
    const id = safeId(w[0]);
    const p = oneOf(w[1], ['must', 'nice'] as const);
    if (id && p && !wishes.some(([x]) => x === id)) wishes.push([id, p]);
  }
  return {
    version: 1,
    profile: parseProfile(json.profile),
    wishes,
    repeats: parseRepeats(json.repeats),
    corrections: parseCorrections(json.corrections),
    day: parseDay(json.day, now),
    settings: parseSettings(json.settings),
    lastLive: parseSnapshot(json.lastLive, now),
  };
}

export function saveState(storage: StorageLike, state: PersistedState): boolean {
  try {
    const raw = JSON.stringify(state);
    if (raw.length > MAX_BYTES) return false;
    storage.setItem(STORAGE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}
