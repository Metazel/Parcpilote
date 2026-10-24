import { parkDateKey } from '../domain/time';
import type {
  EasyAccessReservation,
  GroupProfile,
  MealMode,
  MealPick,
  MealPref,
  MealSlot,
  LiveAttraction,
  LiveSnapshot,
  PaBooking,
  Pace,
  ParkHours,
  ParkId,
  ParkInfo,
  Place,
  Position,
  Priority,
  ShowPick,
  WaitCorrection,
} from '../domain/types';
import { arr, bool, int, isRecord, num, oneOf, safeId, str } from '../data/validate';
import { DEFAULT_DESTINATION, DESTINATION_IDS } from '../data/destinations';
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
  readonly dinnerDone: boolean;
  /** Place and table reservation chosen for each meal today. */
  readonly meals: Readonly<Partial<Record<MealSlot, MealPick>>>;
  readonly position: (Position & { readonly key: string }) | null;
  readonly shows: readonly ShowPick[];
  readonly paBookings: readonly PaBooking[];
  /** Ride id → epoch until which the user reported it closed. */
  readonly closedReports: Readonly<Record<string, number>>;
  /** Demo only: ride id → epoch until which a breakdown is simulated. */
  readonly forcedDown: Readonly<Record<string, number>>;
  /** Carte Facilité registration currently held. */
  readonly easyAccess: EasyAccessReservation | null;
  /** Manual mode: show sessions entered by the visitor (show id → start instants). */
  readonly manualShowtimes: Readonly<Record<string, readonly number[]>>;
  /** Manual mode: waits seen on site (ride id → minutes). */
  readonly manualWaits: Readonly<Record<string, number>>;
  /** Manual mode: the day's opening hours, when the visitor set them. */
  readonly manualHours: { readonly open: number; readonly close: number } | null;
}

/** A ride or show the visitor added (manual mode, or anything missing from the feed). */
export interface CustomPlace {
  readonly dest: string;
  readonly id: string;
  readonly name: string;
  readonly kind: 'ride' | 'show';
  readonly durationMin: number;
}

/** Wish list kept per destination while another park is visited. */
export interface SavedList {
  readonly wishes: ReadonlyArray<readonly [string, Priority]>;
  readonly repeats: Readonly<Record<string, number>>;
}

/** Last attractions list read from the live feed, for offline use (30 days). */
export interface CatalogCache {
  readonly dest: string;
  readonly fetchedAt: number;
  readonly places: readonly Place[];
  readonly parks: readonly ParkInfo[];
}

export interface DemoClock {
  /** Simulated epoch at `realBase`. */
  readonly base: number;
  readonly realBase: number;
  readonly speed: 1 | 10 | 60;
}

export interface Settings {
  /** Destination visited (see data/destinations). */
  readonly destination: string;
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
  /** Lists of the other destinations, restored when the visitor goes back there. */
  readonly saved: Readonly<Record<string, SavedList>>;
  readonly custom: readonly CustomPlace[];
  readonly catalogCache: CatalogCache | null;
}

export const DEFAULT_PROFILE: GroupProfile = {
  size: 4,
  smallestHeightCm: null,
  singleRiderOk: false,
  paBudgetEur: 0,
  pace: 'normal',
  stroller: false,
  lunch: { enabled: true, atMin: 12 * 60 + 30, durationMin: 45, mode: 'quick' },
  dinner: { enabled: false, atMin: 19 * 60, durationMin: 60, mode: 'quick' },
  startPark: 'dlp',
  emhAccess: false,
  easyAccess: false,
};

export function emptyDay(now: number): DayProgress {
  return { dateKey: parkDateKey(now), done: [], skipped: [], lunchDone: false, dinnerDone: false, meals: {}, position: null, shows: [], paBookings: [], closedReports: {}, forcedDown: {}, easyAccess: null, manualShowtimes: {}, manualWaits: {}, manualHours: null };
}

export function defaultState(now: number): PersistedState {
  return {
    version: 1,
    profile: null,
    wishes: [],
    repeats: {},
    corrections: {},
    day: emptyDay(now),
    settings: { destination: DEFAULT_DESTINATION, source: 'auto', demoClock: null, useGps: false },
    lastLive: null,
    saved: {},
    custom: [],
    catalogCache: null,
  };
}

const CATALOG_MAX_AGE_MS = 30 * 24 * 3_600_000;
const TIME_MIN = Date.UTC(2020, 0, 1);
const TIME_MAX = Date.UTC(2100, 0, 1);
const epoch = (v: unknown) => int(v, TIME_MIN, TIME_MAX);

const MEAL_MODES = ['free', 'picnic', 'quick', 'table'] as const satisfies readonly MealMode[];
/** Preferred start bounds (minutes after midnight). */
export const MEAL_WINDOWS: Readonly<Record<MealSlot, readonly [number, number]>> = { lunch: [10 * 60, 16 * 60], dinner: [16 * 60 + 30, 22 * 60 + 30] };

/** A meal preference; `fallbackMode` reads older profiles that had no mode (a break in place). */
function parseMeal(v: unknown, slot: MealSlot, fallbackMode: MealMode): MealPref | null {
  if (!isRecord(v)) return null;
  const enabled = bool(v.enabled);
  const atMin = int(v.atMin, MEAL_WINDOWS[slot][0], MEAL_WINDOWS[slot][1]);
  const durationMin = int(v.durationMin, 15, 150);
  const mode = v.mode === undefined ? fallbackMode : oneOf(v.mode, MEAL_MODES);
  return enabled === null || atMin === null || durationMin === null || !mode ? null : { enabled, atMin, durationMin, mode };
}

export function parseProfile(v: unknown): GroupProfile | null {
  if (!isRecord(v) || !isRecord(v.lunch)) return null;
  const size = int(v.size, 1, 20);
  const smallest = v.smallestHeightCm === null ? null : int(v.smallestHeightCm, 60, 220);
  const singleRiderOk = bool(v.singleRiderOk);
  const paBudgetEur = num(v.paBudgetEur, 0, 1000);
  const pace = oneOf(v.pace, ['slow', 'normal', 'fast'] as const satisfies readonly Pace[]);
  const stroller = bool(v.stroller);
  // Profiles before v0.5 had a lunch break without mode, and no dinner.
  const lunch = parseMeal(v.lunch, 'lunch', 'free');
  const dinner = v.dinner === undefined ? DEFAULT_PROFILE.dinner : parseMeal(v.dinner, 'dinner', 'quick');
  const startPark = safeId(v.startPark);
  // Absent in profiles saved by v0.1: defaults to no access.
  const emhAccess = v.emhAccess === undefined ? false : bool(v.emhAccess);
  // Absent before v0.3: no Carte Facilité.
  const easyAccess = v.easyAccess === undefined ? false : bool(v.easyAccess);
  if (emhAccess === null || easyAccess === null) return null;
  if (size === null || (v.smallestHeightCm !== null && smallest === null) || singleRiderOk === null || paBudgetEur === null) return null;
  if (!pace || stroller === null || !lunch || !dinner || !startPark) return null;
  return { size, smallestHeightCm: smallest, singleRiderOk, paBudgetEur, pace, stroller, lunch, dinner, startPark, emhAccess, easyAccess };
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

function parseShowtimes(v: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!isRecord(v)) return out;
  for (const [k, list] of Object.entries(v).slice(0, 200)) {
    const id = safeId(k);
    if (!id) continue;
    const times = [...new Set((arr(list, 30) ?? []).map(epoch).filter((t): t is number => t !== null))].sort((a, b) => a - b);
    if (times.length > 0) out[id] = times;
  }
  return out;
}

function parseWaits(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, w] of Object.entries(v).slice(0, 300)) {
    const id = safeId(k);
    const n = int(w, 0, 300);
    if (id && n !== null) out[id] = n;
  }
  return out;
}

function parseWindow(v: unknown): { open: number; close: number } | null {
  if (!isRecord(v)) return null;
  const open = epoch(v.open);
  const close = epoch(v.close);
  return open !== null && close !== null && close > open ? { open, close } : null;
}

function parseWishes(v: unknown): Array<[string, Priority]> {
  const wishes: Array<[string, Priority]> = [];
  for (const w of arr(v, 300) ?? []) {
    if (!Array.isArray(w)) continue;
    const id = safeId(w[0]);
    const p = oneOf(w[1], ['must', 'nice'] as const);
    if (id && p && !wishes.some(([x]) => x === id)) wishes.push([id, p]);
  }
  return wishes;
}

function parseSaved(v: unknown): Record<string, SavedList> {
  const out: Record<string, SavedList> = {};
  if (!isRecord(v)) return out;
  for (const [k, list] of Object.entries(v).slice(0, 20)) {
    const dest = oneOf(k, DESTINATION_IDS);
    if (dest && isRecord(list)) out[dest] = { wishes: parseWishes(list.wishes), repeats: parseRepeats(list.repeats) };
  }
  return out;
}

function parseCustom(v: unknown): CustomPlace[] {
  const out: CustomPlace[] = [];
  for (const c of arr(v, 200) ?? []) {
    if (!isRecord(c)) continue;
    const dest = oneOf(c.dest, DESTINATION_IDS);
    const id = safeId(c.id);
    const name = str(c.name, 80);
    const kind = oneOf(c.kind, ['ride', 'show'] as const);
    const durationMin = int(c.durationMin, 1, 180);
    if (dest && id && id.startsWith('custom-') && name && kind && durationMin !== null && !out.some((x) => x.id === id)) out.push({ dest, id, name, kind, durationMin });
  }
  return out;
}

function parseParkInfo(v: unknown): ParkInfo | null {
  if (!isRecord(v) || !isRecord(v.entrance)) return null;
  const id = safeId(v.id);
  const name = str(v.name, 120);
  const short = str(v.short, 120);
  const lat = num(v.entrance.lat, -90, 90);
  const lon = num(v.entrance.lon, -180, 180);
  const color = int(v.color, 0, 20);
  return id && name && short && lat !== null && lon !== null && color !== null ? { id, name, short, entrance: { lat, lon }, color } : null;
}

function parseParks(v: unknown): ParkInfo[] | null {
  const list = arr(v, 10);
  if (!list || list.length === 0) return null;
  const parks = list.map(parseParkInfo);
  return parks.every((p): p is ParkInfo => p !== null) && new Set(parks.map((p) => p.id)).size === parks.length ? parks : null;
}

function parsePlace(v: unknown, parkIds: ReadonlySet<string>): Place | null {
  if (!isRecord(v)) return null;
  const id = safeId(v.id);
  const name = str(v.name, 120);
  const park = typeof v.park === 'string' && parkIds.has(v.park) ? v.park : null;
  const land = str(v.land, 120);
  const lat = num(v.lat, -90, 90);
  const lon = num(v.lon, -180, 180);
  const durationMin = int(v.durationMin, 1, 180);
  if (!id || !name || !park || !land || lat === null || lon === null || durationMin === null) return null;
  if (v.kind === 'ride') {
    const minHeightCm = int(v.minHeightCm, 0, 220);
    const singleRider = bool(v.singleRider);
    const premierAccess = bool(v.premierAccess);
    const intensity = v.intensity === 1 || v.intensity === 2 || v.intensity === 3 ? v.intensity : null;
    if (minHeightCm === null || singleRider === null || premierAccess === null || intensity === null) return null;
    return { kind: 'ride', id, name, park, land, lat, lon, durationMin, minHeightCm, singleRider, premierAccess, intensity };
  }
  if (v.kind === 'show' && isRecord(v.arriveBeforeMin)) {
    const low = int(v.arriveBeforeMin.low, 0, 120);
    const mid = int(v.arriveBeforeMin.mid, 0, 120);
    const high = int(v.arriveBeforeMin.high, 0, 120);
    if (low === null || mid === null || high === null) return null;
    return { kind: 'show', id, name, park, land, lat, lon, durationMin, arriveBeforeMin: { low, mid, high } };
  }
  return null;
}

/** Cached live catalogue: validated like any untrusted input, dropped after 30 days. */
export function parseCatalogCache(v: unknown, now: number): CatalogCache | null {
  if (!isRecord(v)) return null;
  const dest = oneOf(v.dest, DESTINATION_IDS);
  const fetchedAt = epoch(v.fetchedAt);
  const parks = parseParks(v.parks);
  if (!dest || fetchedAt === null || now - fetchedAt > CATALOG_MAX_AGE_MS || !parks) return null;
  const ids = new Set(parks.map((p) => p.id));
  const places: Place[] = [];
  for (const p of arr(v.places, 600) ?? []) {
    const place = parsePlace(p, ids);
    if (place && !places.some((x) => x.id === place.id)) places.push(place);
  }
  return places.length > 0 ? { dest, fetchedAt, places, parks } : null;
}

function parseMealPicks(v: unknown): Partial<Record<MealSlot, MealPick>> {
  const out: Partial<Record<MealSlot, MealPick>> = {};
  if (!isRecord(v)) return out;
  for (const slot of ['lunch', 'dinner'] as const) {
    const m = v[slot];
    if (!isRecord(m)) continue;
    const placeId = m.placeId === null ? null : safeId(m.placeId);
    const reservationAt = m.reservationAt === null ? null : epoch(m.reservationAt);
    if ((m.placeId === null || placeId) && (m.reservationAt === null || reservationAt !== null)) out[slot] = { placeId, reservationAt };
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
  const park = safeId(v.park);
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
    dinnerDone: bool(v.dinnerDone) ?? false,
    meals: parseMealPicks(v.meals),
    position: parsePosition(v.position),
    shows,
    paBookings,
    closedReports: parseEpochMap(v.closedReports),
    forcedDown: parseEpochMap(v.forcedDown),
    easyAccess: parseEasyAccess(v.easyAccess),
    manualShowtimes: parseShowtimes(v.manualShowtimes),
    manualWaits: parseWaits(v.manualWaits),
    manualHours: parseWindow(v.manualHours),
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
  const d: Settings = { destination: DEFAULT_DESTINATION, source: 'auto', demoClock: null, useGps: false };
  if (!isRecord(v)) return d;
  let demoClock: DemoClock | null = null;
  if (isRecord(v.demoClock)) {
    const base = epoch(v.demoClock.base);
    const realBase = epoch(v.demoClock.realBase);
    const speed = v.demoClock.speed === 1 || v.demoClock.speed === 10 || v.demoClock.speed === 60 ? v.demoClock.speed : null;
    if (base !== null && realBase !== null && speed !== null) demoClock = { base, realBase, speed };
  }
  return {
    destination: oneOf(v.destination, DESTINATION_IDS) ?? DEFAULT_DESTINATION,
    source: oneOf(v.source, ['auto', 'demo'] as const) ?? 'auto',
    demoClock,
    useGps: bool(v.useGps) ?? false,
  };
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
  const parks = parseParks(v.parks);
  if (!parks) return null;
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
  const hours: Record<ParkId, ParkHours> = {};
  for (const { id: park } of parks) {
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
  return { source: 'live', fetchedAt, parks, attractions, showtimes, hours };
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
  return {
    version: 1,
    profile: parseProfile(json.profile),
    wishes: parseWishes(json.wishes),
    repeats: parseRepeats(json.repeats),
    corrections: parseCorrections(json.corrections),
    day: parseDay(json.day, now),
    settings: parseSettings(json.settings),
    lastLive: parseSnapshot(json.lastLive, now),
    saved: parseSaved(json.saved),
    custom: parseCustom(json.custom),
    catalogCache: parseCatalogCache(json.catalogCache, now),
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
