import { seedCatalog } from '../data/catalog';
import { OSM_CACHE_PREFIX, RESORT_BBOX, bboxAround, fetchOsm, parseCompactOsm } from '../data/osm';
import { buildPois } from '../data/pois';
import { curatedParks, demoSnapshot } from '../data/demo';
import { type DestinationDef, destination } from '../data/destinations';
import { MANUAL_WAIT_MIN, cachedCatalog, customPlaces, defParks, manualCatalog, manualSnapshot } from '../data/manual';
import { type FetchFn, LiveDataError, loadLive } from '../data/themeparks';
import { DETOUR_FACTOR, type NetworkFn, haversineM, walkMinutes } from '../domain/geo';
import { type Route, WalkGraph } from '../domain/walkGraph';
import { MAX_REPEATS, type PlanInput, computePlan, entrancesOf, wantedRides } from '../domain/planner';
import { type PaAdvice, advisePremierAccess, remainingBudgetCents } from '../domain/premierAccess';
import { MINUTE, formatHM, parkDateKey, parkMinutesOfDay, parkWallTime } from '../domain/time';
import type { GeoPoint, GroupProfile, LiveSnapshot, MealSlot, ParkId, ParkInfo, Place, Plan, PlanStep, Poi, Position, Priority } from '../domain/types';
import { updateCorrection } from '../domain/waits';
import type { PlannerClient } from './planner';
import {
  type CustomPlace,
  type DayProgress,
  type PersistedState,
  type Settings,
  type StorageLike,
  emptyDay,
  loadState,
  saveState,
} from './storage';

export interface Alert {
  readonly id: string;
  readonly level: 'info' | 'warn';
  readonly text: string;
  readonly at: number;
}

export interface DataStatus {
  /** `manual`: estimated waits and visitor entries; `unavailable`: nothing to plan with yet. */
  readonly mode: 'live' | 'demo' | 'offline' | 'manual' | 'unavailable';
  readonly state: 'loading' | 'ok';
  readonly message: string | null;
  readonly fetchedAt: number | null;
}

/** The visited destination and its parks for the day. */
export interface ResortView {
  readonly def: DestinationDef;
  readonly parks: readonly ParkInfo[];
}

export interface AppState {
  readonly persisted: PersistedState;
  readonly resort: ResortView;
  readonly catalog: ReadonlyMap<string, Place>;
  readonly snapshot: LiveSnapshot | null;
  readonly now: number;
  readonly data: DataStatus;
  readonly plan: Plan | null;
  /** A newer plan is being computed (off-thread); the current one may be slightly stale. */
  readonly planPending: boolean;
  readonly advice: PaAdvice | null;
  readonly alerts: readonly Alert[];
  readonly forcedNextId: string | null;
  readonly gps: Position | null;
  readonly gpsAccuracyM: number | null;
  /** OpenStreetMap footways and service points. */
  readonly osm: { readonly status: 'loading' | 'ok' | 'unavailable'; readonly fetchedAt: number | null };
  readonly graph: WalkGraph | null;
  readonly pois: readonly Poi[];
}

/** A route to draw: along footways when the network is known, else a straight estimate. */
export interface DrawnRoute extends Route {
  readonly onNetwork: boolean;
}

export interface StoreDeps {
  readonly storage: StorageLike;
  readonly fetchFn: FetchFn | null;
  readonly realNow: () => number;
  /** Off-thread planner; plans are computed synchronously without one. */
  readonly planner?: PlannerClient | null;
}

const TICK_MS = 5_000;
const LIVE_REFRESH_MS = 5 * MINUTE;
const OFFLINE_MAX_AGE_MS = 90 * MINUTE;
const STALE_AFTER_MS = 20 * MINUTE;
const CLOSED_REPORT_MS = 30 * MINUTE;
const DEMO_BREAKDOWN_MS = 45 * MINUTE;
const MAX_ALERTS = 6;
const GPS_MAX_DISTANCE_M = 1_500;

export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextLiveAttempt = 0;
  private liveFailures = 0;
  /** Live load in flight, per destination (a switch starts its own load). */
  private inflight: { readonly dest: string; readonly promise: Promise<void> } | null = null;
  private lastPlanAt = 0;
  private lastDemoKey = '';
  private lastManualKey = '';
  /** Destination whose OpenStreetMap data is loaded. */
  private osmDest = '';
  private readonly firedAlerts = new Set<string>();
  private officialRestaurants: ReadonlyArray<{ park: ParkId; id: string; name: string; lat: number; lon: number }> = [];
  private osmData: ReturnType<typeof parseCompactOsm> = null;
  /** Sequence number of the latest plan request: older answers are ignored. */
  private planSeq = 0;

  constructor(private readonly deps: StoreDeps) {
    const real = deps.realNow();
    const persisted = loadState(deps.storage, real);
    const def = destination(persisted.settings.destination);
    this.state = {
      persisted,
      resort: { def, parks: AppStore.knownParks(def, persisted) },
      catalog: AppStore.initialCatalog(def, persisted),
      snapshot: null,
      now: real,
      data: { mode: persisted.settings.source === 'demo' && def.features.demo ? 'demo' : def.live ? 'live' : 'manual', state: 'loading', message: null, fetchedAt: null },
      plan: null,
      planPending: false,
      advice: null,
      alerts: [],
      forcedNextId: null,
      gps: null,
      gpsAccuracyM: null,
      osm: { status: 'loading', fetchedAt: null },
      graph: null,
      pois: [],
    };
    this.state = { ...this.state, now: this.clockNow() };
  }

  /** Parks known before any data arrives: curated, manual, or from the last download. */
  private static knownParks(def: DestinationDef, persisted: PersistedState): ParkInfo[] {
    if (def.parks.length > 0) return def.id === 'dlp' ? curatedParks() : defParks(def);
    const cache = persisted.catalogCache;
    return cache && cache.dest === def.id ? [...cache.parks] : [];
  }

  private static initialCatalog(def: DestinationDef, persisted: PersistedState): Map<string, Place> {
    if (def.id === 'dlp') return seedCatalog();
    if (!def.live) return manualCatalog(def, [], persisted.custom);
    const cache = persisted.catalogCache;
    return cache && cache.dest === def.id ? cachedCatalog(cache, persisted.custom) : new Map();
  }

  private get def(): DestinationDef {
    return this.state.resort.def;
  }

  // ---- subscription -------------------------------------------------------

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private persist(patch: Partial<PersistedState>): void {
    const persisted = { ...this.state.persisted, ...patch };
    saveState(this.deps.storage, persisted);
    this.set({ persisted });
  }

  private patchDay(patch: Partial<DayProgress>): void {
    this.persist({ day: { ...this.state.persisted.day, ...patch } });
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): void {
    if (this.timer) return;
    void this.refresh();
    if (this.osmArea()) void this.loadOsm();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Simulated time when demo data is in use, real time otherwise. */
  private clockNow(): number {
    const real = this.deps.realNow();
    const clock = this.state.persisted.settings.demoClock;
    if (this.state.data.mode === 'demo' && clock && this.def.features.demo) return clock.base + (real - clock.realBase) * clock.speed;
    return real;
  }

  tick(): void {
    const now = this.clockNow();
    const { day } = this.state.persisted;
    if (parkDateKey(now) !== day.dateKey) {
      this.firedAlerts.clear();
      this.persist({ day: emptyDay(now) });
    }
    this.set({ now });
    if (this.state.data.mode === 'demo') {
      // Demo data moves in 5-minute steps: regenerate only then (or when a breakdown is simulated).
      const key = `${Math.floor(now / (5 * MINUTE))}|${JSON.stringify(this.state.persisted.day.forcedDown)}`;
      if (key !== this.lastDemoKey) {
        this.lastDemoKey = key;
        this.useSnapshot(demoSnapshot(now, this.state.catalog, { forcedDown: this.state.persisted.day.forcedDown }));
      } else if (now - this.lastPlanAt >= MINUTE) {
        this.recompute();
      }
    } else if (this.state.data.mode === 'manual' && !this.def.live) {
      this.manualTick();
    } else if (this.deps.realNow() >= this.nextLiveAttempt) {
      void this.refresh();
    } else if (this.state.data.mode === 'manual') {
      this.manualTick();
    } else if (now - this.lastPlanAt >= MINUTE) {
      this.recompute();
    }
  }

  /** Manual data moves with the visitor's entries and the clock (5-minute steps). */
  private manualTick(force = false): void {
    const { day } = this.state.persisted;
    const now = this.state.now;
    const key = `${Math.floor(now / (5 * MINUTE))}|${JSON.stringify([day.manualShowtimes, day.manualWaits, day.manualHours, this.state.catalog.size])}`;
    if (force || key !== this.lastManualKey) {
      this.lastManualKey = key;
      this.useSnapshot(manualSnapshot(now, this.state.catalog, this.state.resort.parks, this.def.id, day));
    } else if (now - this.lastPlanAt >= MINUTE) {
      this.recompute();
    }
  }

  // ---- data ---------------------------------------------------------------

  refresh(): Promise<void> {
    const dest = this.def.id;
    if (this.inflight?.dest === dest) return this.inflight.promise;
    const promise = this.load().finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { dest, promise };
    return promise;
  }

  private async load(): Promise<void> {
    const { settings } = this.state.persisted;
    const def = this.def;
    if (!def.live) {
      this.enterManual(`Mode estimé : ${def.name} ne publie pas ses temps d’attente. Attentes estimées à ${MANUAL_WAIT_MIN} min, à corriger sur place depuis « Maintenant » ; saisissez les séances des spectacles dans Ma liste.`);
      return;
    }
    if (def.features.demo && (settings.source === 'demo' || !this.deps.fetchFn)) {
      this.enterDemo(settings.source === 'demo' ? null : 'Temps d’attente en direct inaccessibles ici : journée de démonstration simulée.');
      return;
    }
    if (!this.deps.fetchFn) {
      this.liveUnavailable('connexion indisponible');
      return;
    }
    const real = this.deps.realNow();
    try {
      const bundle = await loadLive(this.deps.fetchFn, def, def.id === 'dlp' ? seedCatalog() : new Map(), real);
      if (def.id !== this.def.id) return; // destination changed meanwhile
      this.liveFailures = 0;
      this.nextLiveAttempt = real + LIVE_REFRESH_MS;
      const wasFallback = this.state.data.mode === 'demo' || this.state.data.mode === 'manual';
      this.officialRestaurants = bundle.restaurants;
      const catalog = new Map(bundle.catalog);
      const park = bundle.snapshot.parks[0];
      if (park) for (const p of customPlaces(this.state.persisted.custom, def.id, park)) catalog.set(p.id, p);
      this.set({ catalog, resort: { def, parks: bundle.snapshot.parks }, data: { mode: 'live', state: 'ok', message: null, fetchedAt: real }, now: real });
      this.rebuildPois();
      this.persist({
        lastLive: bundle.snapshot,
        // Curated parks need no cache; others keep their list for offline days.
        catalogCache: def.id === 'dlp' ? this.state.persisted.catalogCache : { dest: def.id, fetchedAt: real, places: [...bundle.catalog.values()], parks: bundle.snapshot.parks },
      });
      if (wasFallback) this.pushAlert('live-back', 'info', 'Données en direct rétablies.');
      this.useSnapshot(bundle.snapshot);
      if (this.osmDest !== def.id) void this.loadOsm();
    } catch (e) {
      if (def.id !== this.def.id) return;
      this.liveFailures++;
      this.nextLiveAttempt = real + Math.min(15, 2 ** (this.liveFailures - 1)) * MINUTE;
      this.liveUnavailable(e instanceof LiveDataError ? e.message : 'Erreur inattendue');
    }
  }

  /** Live feed down: today's last data, else the demo day (Disneyland Paris), else estimates. */
  private liveUnavailable(reason: string): void {
    const real = this.deps.realNow();
    const why = reason.toLowerCase();
    const last = this.state.persisted.lastLive;
    if (last && real - last.fetchedAt <= OFFLINE_MAX_AGE_MS) {
      this.set({ resort: { def: this.def, parks: last.parks }, data: { mode: 'offline', state: 'ok', message: `Temps d’attente en direct inaccessibles (${why}) : dernières données de ${formatHM(last.fetchedAt)}.`, fetchedAt: last.fetchedAt }, now: real });
      this.useSnapshot(last);
    } else if (this.def.features.demo) {
      this.enterDemo(`Temps d’attente en direct inaccessibles (${why}) : journée de démonstration simulée.`);
    } else if (this.state.catalog.size > 0 && this.state.resort.parks.length > 0) {
      this.enterManual(`Mode estimé : temps d’attente en direct inaccessibles (${why}). Attentes estimées à ${MANUAL_WAIT_MIN} min, à corriger sur place depuis « Maintenant ».`);
    } else {
      this.set({ data: { mode: 'unavailable', state: 'ok', message: `Données de ${this.def.name} inaccessibles (${why}). Réessai automatique ; une première connexion est nécessaire pour ce parc.`, fetchedAt: null }, now: real });
    }
  }

  /** Estimated waits and the visitor's entries (parks without live feed, or feed down). */
  private enterManual(message: string): void {
    const real = this.deps.realNow();
    const def = this.def;
    if (!def.live) {
      const sights = this.osmDest === def.id && this.osmData ? this.osmData.sights : [];
      this.set({ catalog: manualCatalog(def, sights, this.state.persisted.custom), resort: { def, parks: defParks(def) } });
    }
    this.set({ data: { mode: 'manual', state: 'ok', message, fetchedAt: null }, now: real });
    if (parkDateKey(real) !== this.state.persisted.day.dateKey) this.persist({ day: emptyDay(real) });
    this.manualTick(true);
  }

  private enterDemo(message: string | null): void {
    const real = this.deps.realNow();
    let settings = this.state.persisted.settings;
    if (!settings.demoClock) {
      // Start the simulated day at the real time when parks are open, else at 10:00.
      const m = parkMinutesOfDay(real);
      const base = m >= 9 * 60 + 30 && m < 20 * 60 ? real : parkWallTime(real, 10 * 60);
      settings = { ...settings, demoClock: { base, realBase: real, speed: 1 } };
      this.persist({ settings });
    }
    this.set({ catalog: seedCatalog(), resort: { def: this.def, parks: curatedParks() }, data: { mode: 'demo', state: 'ok', message, fetchedAt: null } });
    const now = this.clockNow();
    if (parkDateKey(now) !== this.state.persisted.day.dateKey) this.persist({ day: emptyDay(now) });
    this.set({ now });
    this.useSnapshot(demoSnapshot(now, this.state.catalog, { forcedDown: this.state.persisted.day.forcedDown }));
  }

  private useSnapshot(next: LiveSnapshot): void {
    const prev = this.state.snapshot;
    this.set({ snapshot: next, data: { ...this.state.data, fetchedAt: next.source === 'demo' ? next.fetchedAt : this.state.data.fetchedAt } });
    this.statusAlerts(prev, next);
    this.recompute();
  }

  /** Snapshot with the user's own "closed" reports applied. */
  effectiveSnapshot(): LiveSnapshot | null {
    const snap = this.state.snapshot;
    if (!snap) return null;
    const reports = this.state.persisted.day.closedReports;
    const now = this.state.now;
    const active = Object.entries(reports).filter(([, until]) => until > now);
    if (active.length === 0) return snap;
    const attractions = { ...snap.attractions };
    for (const [id] of active) {
      const a = attractions[id];
      if (a) attractions[id] = { ...a, status: 'DOWN', standby: null, singleRider: null };
    }
    return { ...snap, attractions };
  }

  // ---- map data (OpenStreetMap) --------------------------------------------

  /** Area to download: Disneyland Paris' plaza, else around the known parks or the park centre. */
  private osmArea(): readonly [number, number, number, number] | null {
    const def = this.def;
    if (def.id === 'dlp') return RESORT_BBOX;
    const parks = this.state.resort.parks;
    const center = parks.length > 0 ? { lat: parks.reduce((a, p) => a + p.entrance.lat, 0) / parks.length, lon: parks.reduce((a, p) => a + p.entrance.lon, 0) / parks.length } : def.center;
    return center ? bboxAround(center, def.radiusM) : null;
  }

  /** Loads footways and service points: device cache first, then Overpass once. */
  async loadOsm(): Promise<void> {
    const now = this.deps.realNow();
    const def = this.def;
    const area = this.osmArea();
    const key = `${OSM_CACHE_PREFIX}${def.id}`;
    this.osmDest = def.id;
    let data = null;
    try {
      const raw = this.deps.storage.getItem(key);
      if (raw && raw.length < 6_000_000) data = parseCompactOsm(JSON.parse(raw), now);
    } catch {
      data = null;
    }
    if (!data && this.deps.fetchFn && area) {
      try {
        data = await fetchOsm(this.deps.fetchFn, now, area, !def.live);
        try {
          this.deps.storage.setItem(key, JSON.stringify(data));
        } catch {
          // Storage full or blocked: keep the data for this session only.
        }
      } catch {
        data = null;
      }
    }
    if (def.id !== this.def.id) return; // destination changed meanwhile
    this.osmData = data;
    this.deps.planner?.setNetwork(data);
    if (!data) {
      this.set({ osm: { status: 'unavailable', fetchedAt: null }, graph: null });
      this.rebuildPois();
      return;
    }
    const graph = data.lat.length >= 20 ? new WalkGraph(data) : null;
    this.set({ osm: { status: graph ? 'ok' : 'unavailable', fetchedAt: data.fetchedAt }, graph });
    // Parks without live feed take their attractions from the map data.
    if (!def.live) {
      this.set({ catalog: manualCatalog(def, data.sights, this.state.persisted.custom) });
      this.rebuildPois();
      this.manualTick(true);
      return;
    }
    this.rebuildPois();
    this.recompute();
  }

  private rebuildPois(): void {
    this.set({ pois: buildPois(this.osmData, this.officialRestaurants, this.state.catalog, this.def.dining) });
  }

  private network(): NetworkFn | undefined {
    const graph = this.state.graph;
    return graph ? (a, b) => graph.distanceM(a, b) : undefined;
  }

  /** Walking minutes from the group's current position (footways when known). */
  walkMinutesTo(to: Position): number {
    const profile = this.state.persisted.profile;
    const snapshot = this.state.snapshot;
    return walkMinutes(this.currentPosition(), to, { pace: profile?.pace ?? 'normal', stroller: profile?.stroller ?? false }, this.network(), snapshot ? entrancesOf(snapshot) : undefined);
  }

  /** Route between two points for display (footways when known). */
  route(from: GeoPoint, to: GeoPoint): DrawnRoute {
    const r = this.state.graph?.route(from, to);
    const crow = haversineM(from, to);
    if (r && r.meters <= crow * 4 + 300) return { ...r, onNetwork: true };
    return { meters: crow * DETOUR_FACTOR, points: [from, to], via: [], onNetwork: false };
  }

  // ---- planning -----------------------------------------------------------

  currentPosition(): Position & { key: string } {
    const { day, profile } = this.state.persisted;
    if (this.state.gps) return { ...this.state.gps, key: 'gps' };
    if (day.position) return day.position;
    const parks = this.state.resort.parks;
    const park = parks.find((p) => p.id === profile?.startPark) ?? parks[0];
    if (park) return { ...park.entrance, park: park.id, key: `gate-${park.id}` };
    const c = this.def.center ?? { lat: 48.87, lon: 2.777 };
    return { ...c, park: this.def.id, key: `gate-${this.def.id}` };
  }

  recompute(): void {
    const { persisted, now, catalog } = this.state;
    const snapshot = this.effectiveSnapshot();
    const profile = persisted.profile;
    if (!snapshot || !profile) {
      this.planSeq++;
      this.set({ plan: null, planPending: false, advice: null });
      return;
    }
    const { day } = persisted;
    const wishes = new Map<string, Priority>(persisted.wishes);
    const repeats = new Map(Object.entries(persisted.repeats));
    const doneCounts = new Map<string, number>();
    for (const id of day.done) doneCounts.set(id, (doneCounts.get(id) ?? 0) + 1);
    // Not to plan again: skipped, shows seen, rides done as many times as wished.
    const done = new Set(day.skipped);
    for (const [id, n] of doneCounts) {
      if (catalog.get(id)?.kind !== 'ride' || n >= wantedRides({ repeats }, id)) done.add(id);
    }
    const pos = this.currentPosition();
    const prevFirst = this.state.plan?.steps.find((s) => s.kind !== 'easy-book');
    const forcedNextId = this.state.forcedNextId && !done.has(this.state.forcedNextId) ? this.state.forcedNextId : undefined;
    const input: PlanInput = {
      now,
      position: pos,
      positionKey: pos.key,
      catalog,
      snapshot,
      // Disneyland Paris programmes only count where the destination offers them.
      profile: { ...profile, easyAccess: profile.easyAccess && this.def.features.easyAccess, emhAccess: profile.emhAccess && this.def.features.emh },
      wishes,
      repeats,
      shows: day.shows,
      paBookings: day.paBookings,
      done,
      doneCounts,
      lunchDone: day.lunchDone,
      dinnerDone: day.dinnerDone,
      mealPlaces: this.state.pois.filter((p) => p.kind === 'food' || p.kind === 'picnic'),
      mealPicks: day.meals,
      reentryMin: this.def.dining.reentryMin,
      corrections: persisted.corrections,
      easyAccessReservation: profile.easyAccess && this.def.features.easyAccess ? day.easyAccess : null,
      previousNextId: prevFirst?.kind === 'ride' ? prevFirst.targetId : undefined,
      forcedNextId,
    };
    this.lastPlanAt = now;
    const seq = ++this.planSeq;
    const planner = this.deps.planner;
    if (!planner) {
      this.applyPlan(seq, input, computePlan({ ...input, network: this.network() }));
      return;
    }
    this.set({ planPending: true });
    planner.plan(input).then(
      (plan) => this.applyPlan(seq, input, plan),
      // Worker failure: compute here rather than leave the user without a plan.
      () => this.applyPlan(seq, input, computePlan({ ...input, network: this.network() })),
    );
  }

  /** Installs a computed plan unless a newer request was made meanwhile. */
  private applyPlan(seq: number, input: PlanInput, plan: Plan): void {
    if (seq !== this.planSeq) return;
    const { now, catalog, snapshot, profile, wishes, done, forcedNextId } = input;
    const { persisted } = this.state;
    const day = persisted.day;
    const advice = advisePremierAccess({
      now,
      catalog,
      snapshot,
      profile,
      wishes,
      done,
      paBookings: day.paBookings,
      shows: day.shows,
      corrections: persisted.corrections,
      plan,
    });
    this.set({ plan, planPending: false, advice, forcedNextId: forcedNextId ?? null });
    this.planAlerts(plan);
  }

  /** Current plan without some steps, shown while the new plan is computed. */
  private planWithout(drop: (s: PlanStep, i: number) => boolean): Plan | null {
    const plan = this.state.plan;
    return plan ? { ...plan, steps: plan.steps.filter((s, i) => !drop(s, i)) } : null;
  }

  // ---- alerts -------------------------------------------------------------

  private pushAlert(key: string, level: Alert['level'], text: string): void {
    if (this.firedAlerts.has(key)) return;
    this.firedAlerts.add(key);
    const alert: Alert = { id: key, level, text, at: this.state.now };
    this.set({ alerts: [alert, ...this.state.alerts.filter((a) => a.id !== key)].slice(0, MAX_ALERTS) });
  }

  dismissAlert(id: string): void {
    this.set({ alerts: this.state.alerts.filter((a) => a.id !== id) });
  }

  private statusAlerts(prev: LiveSnapshot | null, next: LiveSnapshot): void {
    if (!prev || this.state.persisted.profile === null) return;
    const day = this.state.persisted.day.dateKey;
    for (const [id, priority] of this.state.persisted.wishes) {
      if (this.state.persisted.day.done.includes(id)) continue;
      const before = prev.attractions[id];
      const after = next.attractions[id];
      const name = this.state.catalog.get(id)?.name;
      if (!before || !after || !name) continue;
      if (before.status === 'OPERATING' && after.status === 'DOWN') {
        this.firedAlerts.delete(`up:${id}`);
        this.pushAlert(`down:${id}:${next.fetchedAt}`, 'warn', `${name} est en panne. Le plan a été recalculé.`);
      } else if (before.status === 'DOWN' && after.status === 'OPERATING') {
        this.pushAlert(`up:${id}:${next.fetchedAt}`, 'info', `${name} a rouvert.`);
      } else if (priority === 'must' && before.standby !== null && after.standby !== null && before.standby >= 25 && after.standby <= 15) {
        this.pushAlert(`low:${id}:${day}`, 'info', `Bonne fenêtre : ${name} à ${after.standby} min.`);
      }
    }
  }

  private planAlerts(plan: Plan): void {
    const { now, data } = this.state;
    for (const d of plan.droppedAnchors) {
      this.pushAlert(`dropped:${d.id}`, 'warn', `Impossible d’arriver à temps pour ${d.name}.`);
    }
    // Shows that can no longer be reached are removed from the day's picks.
    const droppedIds = new Set(plan.droppedAnchors.map((d) => d.id));
    const shows = this.state.persisted.day.shows.filter((s) => !droppedIds.has(s.showId));
    if (shows.length !== this.state.persisted.day.shows.length) this.patchDay({ shows });

    const first = plan.steps[0];
    if (first && (first.kind === 'show' || first.kind === 'pa') && first.latestDepartAt !== null) {
      const left = (first.latestDepartAt - now) / MINUTE;
      if (left <= 15 && left >= 0) {
        this.pushAlert(`go:${first.targetId}:${first.startAt}`, 'warn', `Pars vers ${first.name} au plus tard à ${formatHM(first.latestDepartAt)}.`);
      }
    }
    const resv = this.state.persisted.profile?.easyAccess ? this.state.persisted.day.easyAccess : null;
    if (resv && now >= resv.returnAt) {
      const name = this.state.catalog.get(resv.rideId)?.name ?? 'L’attraction';
      this.pushAlert(`easy:${resv.rideId}:${resv.returnAt}`, 'info', `Carte Facilité : ${name} est accessible depuis ${formatHM(resv.returnAt)}.`);
    }
    if (data.mode !== 'demo' && data.fetchedAt !== null && now - data.fetchedAt > STALE_AFTER_MS) {
      this.pushAlert(`stale:${data.fetchedAt}`, 'warn', `Données datant de ${formatHM(data.fetchedAt)} : prévisions moins fiables.`);
    }
  }

  // ---- actions ------------------------------------------------------------

  saveProfile(profile: GroupProfile): void {
    this.persist({ profile });
    this.recompute();
  }

  setWish(id: string, priority: Priority | null): void {
    if (!this.state.catalog.has(id)) return;
    const wishes = this.state.persisted.wishes.filter(([w]) => w !== id);
    if (priority) wishes.push([id, priority]);
    const repeats = { ...this.state.persisted.repeats };
    if (!priority) delete repeats[id];
    this.persist({ wishes, repeats });
    this.recompute();
  }

  /** Number of rides wanted today for an attraction (1 to MAX_REPEATS). */
  setRepeat(id: string, count: number): void {
    if (this.state.catalog.get(id)?.kind !== 'ride' || !Number.isInteger(count) || count < 1 || count > MAX_REPEATS) return;
    const repeats = { ...this.state.persisted.repeats };
    if (count === 1) delete repeats[id];
    else repeats[id] = count;
    this.persist({ repeats });
    this.recompute();
  }

  pickShow(showId: string, start: number | null): void {
    const place = this.state.catalog.get(showId);
    if (!place || place.kind !== 'show') return;
    const shows = this.state.persisted.day.shows.filter((s) => s.showId !== showId);
    if (start !== null) {
      const sessions = this.state.snapshot?.showtimes[showId] ?? [];
      if (!sessions.includes(start)) return;
      shows.push({ showId, start });
      this.firedAlerts.delete(`dropped:${showId}`);
    }
    this.patchDay({ shows });
    this.recompute();
  }

  completeStep(step: PlanStep): void {
    const { day } = this.state.persisted;
    if (step.kind === 'easy-book') {
      if (step.returnAt !== null) this.registerEasyAccess(step.targetId, step.returnAt);
      return;
    }
    if (step.kind === 'meal') {
      const slot = step.meal?.slot ?? 'lunch';
      this.patchDay({
        ...(slot === 'lunch' ? { lunchDone: true } : { dinnerDone: true }),
        ...(step.targetId ? { position: { lat: step.position.lat, lon: step.position.lon, park: step.position.park, key: step.targetId } } : {}),
      });
    } else {
      // Rides may be done several times a day; shows and Premier Access count once.
      const repeatable = step.kind === 'ride';
      this.patchDay({
        done: repeatable || !day.done.includes(step.targetId) ? [...day.done, step.targetId] : day.done,
        position: { lat: step.position.lat, lon: step.position.lon, park: step.position.park, key: step.targetId },
        easyAccess: day.easyAccess?.rideId === step.targetId ? null : day.easyAccess,
        paBookings: step.kind === 'pa' ? day.paBookings.map((b) => (b.attractionId === step.targetId ? { ...b, used: true } : b)) : day.paBookings,
      });
    }
    this.set({ forcedNextId: null, plan: this.planWithout((s) => s === step) });
    this.recompute();
  }

  /** Records the Carte Facilité registration, with the return time given by the Cast Member. */
  registerEasyAccess(rideId: string, returnAt: number): boolean {
    const place = this.state.catalog.get(rideId);
    const { now } = this.state;
    if (!this.state.persisted.profile?.easyAccess || place?.kind !== 'ride') return false;
    if (!Number.isFinite(returnAt) || returnAt < now - 15 * MINUTE || returnAt > now + 8 * 60 * MINUTE) return false;
    this.patchDay({
      easyAccess: { rideId, returnAt },
      position: { lat: place.lat, lon: place.lon, park: place.park, key: rideId },
    });
    this.set({ forcedNextId: null, plan: this.planWithout((s) => s.kind === 'easy-book' && s.targetId === rideId) });
    this.recompute();
    return true;
  }

  cancelEasyAccess(): void {
    this.patchDay({ easyAccess: null });
    this.recompute();
  }

  skip(targetId: string): void {
    const { day } = this.state.persisted;
    if (targetId === '') return;
    if (!day.skipped.includes(targetId)) this.patchDay({ skipped: [...day.skipped, targetId] });
    if (targetId !== '' && day.easyAccess?.rideId === targetId) this.patchDay({ easyAccess: null });
    if (this.state.persisted.day.shows.some((s) => s.showId === targetId)) {
      this.patchDay({ shows: this.state.persisted.day.shows.filter((s) => s.showId !== targetId) });
    }
    this.set({ forcedNextId: null, plan: this.planWithout((s) => s.targetId === targetId) });
    this.recompute();
  }

  /** "Passer" on any step: rides and shows are dropped for the day, a meal is marked as taken. */
  skipStep(step: PlanStep): void {
    if (step.kind !== 'meal') {
      this.skip(step.targetId);
      return;
    }
    this.patchDay(step.meal?.slot === 'dinner' ? { dinnerDone: true } : { lunchDone: true });
    this.set({ forcedNextId: null, plan: this.planWithout((s) => s === step) });
    this.recompute();
  }

  /** Where to eat for a meal (null: the most convenient on the route) and the table reservation. */
  setMealPick(slot: MealSlot, placeId: string | null, reservationAt: number | null): boolean {
    if (placeId !== null && !this.state.pois.some((p) => p.id === placeId && (p.kind === 'food' || p.kind === 'picnic'))) return false;
    const now = this.state.now;
    if (reservationAt !== null && (!Number.isFinite(reservationAt) || reservationAt < now - 60 * MINUTE || reservationAt > now + 16 * 60 * MINUTE)) return false;
    const meals = { ...this.state.persisted.day.meals, [slot]: { placeId, reservationAt } };
    this.patchDay({ meals });
    this.recompute();
    return true;
  }

  restore(targetId: string): void {
    const { day } = this.state.persisted;
    this.patchDay({ skipped: day.skipped.filter((id) => id !== targetId), done: day.done.filter((id) => id !== targetId) });
    this.recompute();
  }

  doNow(targetId: string): void {
    const place = this.state.catalog.get(targetId);
    if (place?.kind !== 'ride') return;
    this.set({ forcedNextId: targetId });
    this.recompute();
  }

  reportWait(id: string, actualMin: number): boolean {
    const live = this.state.snapshot?.attractions[id];
    if (!Number.isInteger(actualMin) || actualMin < 0 || actualMin > 300) return false;
    if (this.state.data.mode === 'manual' && this.state.catalog.get(id)?.kind === 'ride') {
      // No feed to correct: what the visitor sees becomes the wait for this ride.
      this.patchDay({ manualWaits: { ...this.state.persisted.day.manualWaits, [id]: actualMin } });
      this.manualTick(true);
      return true;
    }
    if (live?.standby == null) return false;
    const corrections = { ...this.state.persisted.corrections, [id]: updateCorrection(this.state.persisted.corrections[id], live.standby, actualMin) };
    this.persist({ corrections });
    this.recompute();
    return true;
  }

  reportClosed(id: string): void {
    if (this.state.catalog.get(id)?.kind !== 'ride') return;
    this.patchDay({ closedReports: { ...this.state.persisted.day.closedReports, [id]: this.state.now + CLOSED_REPORT_MS } });
    this.recompute();
  }

  reportShowFull(showId: string): void {
    const name = this.state.catalog.get(showId)?.name ?? 'Le spectacle';
    this.patchDay({ shows: this.state.persisted.day.shows.filter((s) => s.showId !== showId) });
    this.pushAlert(`full:${showId}:${this.state.now}`, 'info', `${name} retiré du plan (complet).`);
    this.recompute();
  }

  bookPremierAccess(attractionId: string, returnStart: number, priceCents: number): boolean {
    const profile = this.state.persisted.profile;
    const place = this.state.catalog.get(attractionId);
    if (!profile || place?.kind !== 'ride') return false;
    if (!Number.isFinite(returnStart) || !Number.isInteger(priceCents) || priceCents < 0 || priceCents > 100_000) return false;
    if (priceCents > remainingBudgetCents(profile, this.state.persisted.day.paBookings)) return false;
    const paBookings = [
      ...this.state.persisted.day.paBookings.filter((b) => b.attractionId !== attractionId),
      { attractionId, returnStart, returnEnd: returnStart + 60 * MINUTE, priceCents },
    ];
    this.patchDay({ paBookings });
    this.recompute();
    return true;
  }

  cancelPremierAccess(attractionId: string): void {
    this.patchDay({ paBookings: this.state.persisted.day.paBookings.filter((b) => b.attractionId !== attractionId) });
    this.recompute();
  }

  setSource(source: Settings['source']): void {
    this.persist({ settings: { ...this.state.persisted.settings, source } });
    this.nextLiveAttempt = 0;
    if (source === 'auto') this.set({ data: { ...this.state.data, mode: 'live', state: 'loading' } });
    void this.refresh();
  }

  setDemoTime(epoch: number): void {
    const clock = this.state.persisted.settings.demoClock;
    if (!clock || !Number.isFinite(epoch)) return;
    this.persist({ settings: { ...this.state.persisted.settings, demoClock: { ...clock, base: epoch, realBase: this.deps.realNow() } } });
    this.tick();
  }

  setDemoSpeed(speed: 1 | 10 | 60): void {
    const clock = this.state.persisted.settings.demoClock;
    if (!clock) return;
    const now = this.clockNow();
    this.persist({ settings: { ...this.state.persisted.settings, demoClock: { base: now, realBase: this.deps.realNow(), speed } } });
  }

  simulateBreakdown(id: string): void {
    if (this.state.data.mode !== 'demo' || this.state.catalog.get(id)?.kind !== 'ride') return;
    this.patchDay({ forcedDown: { ...this.state.persisted.day.forcedDown, [id]: this.state.now + DEMO_BREAKDOWN_MS } });
    this.tick();
  }

  // ---- destinations and manual mode -----------------------------------------

  /** Visits another park: its own list comes back, the day starts over. */
  setDestination(id: string): Promise<void> {
    const next = destination(id);
    const { persisted } = this.state;
    if (next.id === this.def.id) return Promise.resolve();
    const saved = { ...persisted.saved, [this.def.id]: { wishes: persisted.wishes, repeats: persisted.repeats } };
    const back = saved[next.id] ?? { wishes: [], repeats: {} };
    delete saved[next.id];
    const parks = next.parks.length > 0 ? (next.id === 'dlp' ? curatedParks() : defParks(next)) : [];
    this.planSeq++;
    this.firedAlerts.clear();
    this.officialRestaurants = [];
    this.osmData = null;
    this.osmDest = '';
    this.liveFailures = 0;
    this.nextLiveAttempt = 0;
    this.lastManualKey = '';
    this.persist({
      settings: { ...persisted.settings, destination: next.id, source: next.features.demo ? persisted.settings.source : 'auto' },
      wishes: back.wishes,
      repeats: back.repeats,
      saved,
      day: emptyDay(this.deps.realNow()),
      lastLive: null,
      profile: persisted.profile ? { ...persisted.profile, startPark: parks[0]?.id ?? next.id } : null,
    });
    const resort = { def: next, parks: AppStore.knownParks(next, this.state.persisted) };
    this.set({
      resort,
      catalog: AppStore.initialCatalog(next, this.state.persisted),
      snapshot: null,
      plan: null,
      planPending: false,
      advice: null,
      alerts: [],
      forcedNextId: null,
      gps: null,
      graph: null,
      pois: [],
      osm: { status: 'loading', fetchedAt: null },
      data: { mode: next.live ? 'live' : 'manual', state: 'loading', message: null, fetchedAt: null },
      now: this.deps.realNow(),
    });
    if (this.osmArea()) void this.loadOsm();
    return this.refresh();
  }

  /** Adds a ride or show missing from the list (manual mode or incomplete feed). */
  addCustomPlace(name: string, kind: 'ride' | 'show', durationMin: number): string | null {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 80 || !Number.isInteger(durationMin) || durationMin < 1 || durationMin > 180) return null;
    const custom = this.state.persisted.custom;
    if (custom.length >= 200) return null;
    const id = `custom-${this.deps.realNow().toString(36)}${custom.length.toString(36)}`;
    const entry: CustomPlace = { dest: this.def.id, id, name: clean, kind, durationMin };
    this.persist({ custom: [...custom, entry] });
    const park = this.state.resort.parks[0];
    if (park) {
      const catalog = new Map(this.state.catalog);
      for (const p of customPlaces([entry], this.def.id, park)) catalog.set(p.id, p);
      this.set({ catalog });
    }
    if (this.state.data.mode === 'manual') this.manualTick(true);
    else this.recompute();
    return id;
  }

  removeCustomPlace(id: string): void {
    if (!id.startsWith('custom-')) return;
    const catalog = new Map(this.state.catalog);
    catalog.delete(id);
    this.persist({ custom: this.state.persisted.custom.filter((c) => c.id !== id), wishes: this.state.persisted.wishes.filter(([w]) => w !== id) });
    this.set({ catalog });
    if (this.state.data.mode === 'manual') this.manualTick(true);
    else this.recompute();
  }

  /** Manual mode: a show session read on the day's programme. */
  addManualShowtime(showId: string, start: number): boolean {
    const now = this.state.now;
    if (this.state.catalog.get(showId)?.kind !== 'show' || !Number.isFinite(start) || parkDateKey(start) !== parkDateKey(now)) return false;
    const list = this.state.persisted.day.manualShowtimes[showId] ?? [];
    if (list.includes(start) || list.length >= 20) return list.includes(start);
    this.patchDay({ manualShowtimes: { ...this.state.persisted.day.manualShowtimes, [showId]: [...list, start].sort((a, b) => a - b) } });
    this.manualTick(true);
    return true;
  }

  removeManualShowtime(showId: string, start: number): void {
    const list = (this.state.persisted.day.manualShowtimes[showId] ?? []).filter((t) => t !== start);
    const manualShowtimes = { ...this.state.persisted.day.manualShowtimes, [showId]: list };
    this.patchDay({ manualShowtimes, shows: this.state.persisted.day.shows.filter((s) => !(s.showId === showId && s.start === start)) });
    this.manualTick(true);
  }

  /** Manual mode: the day's opening hours (minutes after midnight). */
  setManualHours(openMin: number, closeMin: number): boolean {
    if (!Number.isInteger(openMin) || !Number.isInteger(closeMin) || openMin < 6 * 60 || closeMin > 24 * 60 || closeMin <= openMin + 60) return false;
    const now = this.state.now;
    this.patchDay({ manualHours: { open: parkWallTime(now, openMin), close: parkWallTime(now, closeMin) } });
    this.manualTick(true);
    return true;
  }

  resetDay(): void {
    this.firedAlerts.clear();
    this.persist({ day: emptyDay(this.state.now) });
    this.set({ alerts: [], forcedNextId: null, plan: null, planPending: false });
    this.recompute();
  }

  setUseGps(useGps: boolean): void {
    this.persist({ settings: { ...this.state.persisted.settings, useGps } });
    if (!useGps) this.set({ gps: null });
  }

  /** Called when the device refuses or fails to give a position. */
  gpsUnavailable(): void {
    this.setUseGps(false);
    this.pushAlert(`gps:${this.state.now}`, 'info', 'Position du téléphone indisponible : la position utilisée est celle de la dernière étape.');
  }

  /** Accepts a device position only when it is inside the resort. */
  updateGps(lat: number, lon: number, accuracyM: number | null = null): void {
    if (!this.state.persisted.settings.useGps) return;
    const point = { lat, lon };
    let best: Position | null = null;
    let bestD = Infinity;
    for (const place of this.state.catalog.values()) {
      const d = haversineM(point, place);
      if (d < bestD) {
        bestD = d;
        best = place;
      }
    }
    const gates = this.state.resort.parks.map((p) => p.entrance);
    const gateD = gates.length > 0 ? Math.min(...gates.map((g) => haversineM(point, g))) : bestD;
    if (!best || gateD > GPS_MAX_DISTANCE_M) {
      if (this.state.gps) this.set({ gps: null, gpsAccuracyM: null });
      this.pushAlert('gps-far', 'info', 'Vous êtes hors des parcs : la position du téléphone sera utilisée dès votre arrivée.');
      return;
    }
    this.set({ gps: { lat, lon, park: best.park }, gpsAccuracyM: accuracyM !== null && Number.isFinite(accuracyM) ? Math.round(accuracyM) : null });
    this.recompute();
  }
}
