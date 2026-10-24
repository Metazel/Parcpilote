import { type NetworkFn, createWalkCache } from './geo';
import { MINUTE, minuteOfDayFn, parkWallTime } from './time';
import {
  type Attraction,
  EASY_ACCESS_MAX_PARTY,
  type EasyAccessReservation,
  type GroupProfile,
  type LiveSnapshot,
  type OthersPlan,
  type PaBooking,
  type Place,
  type Plan,
  type PlanStep,
  type Position,
  type Priority,
  type QueueKind,
  type Show,
  type ShowPick,
  type UnplannedReason,
  type WaitCorrection,
} from './types';
import { SINGLE_RIDER_MIN_GAIN, crowdLevel, predictWaitAt } from './waits';

/**
 * Planner: a time-dependent orienteering problem with time windows, solved by a
 * priority-weighted greedy construction followed by local search (insert / relocate /
 * swap / remove / Carte Facilité on-off), evaluated by full timeline simulation.
 * Pure and deterministic.
 *
 * Carte Facilité model (Disneyland Paris, long-term illness): the holder registers at the
 * ride's Premier Access entrance and gets a return time equal to the current wait; one
 * registration at a time. The simulator registers the next "card" ride as soon as no
 * registration is held, so the wait is filled with other rides in the regular queues.
 */

export const PRIORITY_WEIGHT: Readonly<Record<Priority, number>> = { must: 5, nice: 1 };
/** Second and later rides of the same attraction count less than a first discovery. */
export const REPEAT_WEIGHT = 0.6;
/** Most rides of one attraction a wish may ask for. */
export const MAX_REPEATS = 5;
/** Exit / regroup margin after a ride (minutes). */
export const EXIT_MARGIN_MIN = 2;
/** Assumed residual wait in the Premier Access line (minutes). */
export const PA_RESIDUAL_WAIT_MIN = 10;
/** Registering the Carte Facilité with the Cast Member (minutes). */
export const EASY_ACCESS_BOOK_MIN = 2;
/** Residual wait at the Premier Access entrance once the return time is reached (minutes). */
export const EASY_ACCESS_RESIDUAL_WAIT_MIN = 5;
/** Initial guess: use the card on rides whose wait reaches this (the optimiser then decides). */
export const EASY_ACCESS_MIN_WAIT = 20;
/** The card is only moved around for rides whose wait reaches this (minutes). */
const EASY_ACCESS_MOVE_MIN_WAIT = 15;
/** Members outside the card party only ride if they exit at most this long after it (minutes). */
export const OTHERS_REGROUP_TOLERANCE_MIN = 10;
/** Default wait when a ride has no published wait (minutes). */
export const UNKNOWN_WAIT_MIN = 15;
/** The next step only changes if the new plan saves more than this (minutes). */
export const HYSTERESIS_MIN = 10;
/** Lunch may slip this long after the preferred time (minutes). */
export const LUNCH_SLACK_MIN = 60;

const WEIGHT_SCALE = 10_000;
const MISSED_ANCHOR_PENALTY = 1e9;
const OTHERS_IDLE_PENALTY_MIN = 5;
const RESERVED_WEIGHT_FACTOR = 3;
/** Search budget: simulated steps per plan (bounds the cost on phones), and evaluations. */
const MAX_WORK = 400_000;
const MAX_EVALUATIONS = 30_000;

export interface PlanInput {
  readonly now: number;
  readonly position: Position;
  /** Id of the place the group stands at (cache key), or a synthetic key. */
  readonly positionKey: string;
  readonly catalog: ReadonlyMap<string, Place>;
  readonly snapshot: LiveSnapshot;
  readonly profile: GroupProfile;
  readonly wishes: ReadonlyMap<string, Priority>;
  /** Ride id → number of rides wanted today (default 1). */
  readonly repeats?: ReadonlyMap<string, number> | undefined;
  readonly shows: readonly ShowPick[];
  readonly paBookings: readonly PaBooking[];
  /** Places not to plan any more today (skipped rides, shows seen). */
  readonly done: ReadonlySet<string>;
  /** Ride id → rides already done today. */
  readonly doneCounts?: ReadonlyMap<string, number> | undefined;
  readonly lunchDone: boolean;
  readonly corrections: Readonly<Record<string, WaitCorrection>>;
  /** Carte Facilité registration currently held, if any. */
  readonly easyAccessReservation?: EasyAccessReservation | null | undefined;
  /** Target of the previous plan's first step, for recommendation stability. */
  readonly previousNextId?: string | undefined;
  /** Ride the user explicitly asked to do next ("Faire maintenant"). */
  readonly forcedNextId?: string | undefined;
  /** Pedestrian network distances (OpenStreetMap); straight-line model when absent. */
  readonly network?: NetworkFn | undefined;
}

type Anchor =
  | { readonly type: 'show'; readonly key: string; readonly show: Show; readonly start: number; readonly deadline: number }
  | { readonly type: 'pa'; readonly key: string; readonly ride: Attraction; readonly booking: PaBooking }
  | { readonly type: 'lunch'; readonly key: string; readonly earliest: number; readonly latest: number; readonly durationMin: number };

/**
 * One ride of one attraction. `key` is unique (`id#occurrence`).
 * `availableFrom`: earliest instant the group may queue (official opening, or Extra Magic Hours).
 * `easy`: done with the Carte Facilité; `reserved`: the registration is already held.
 */
interface RideItem {
  readonly kind: 'ride';
  readonly key: string;
  readonly ride: Attraction;
  readonly weight: number;
  readonly availableFrom: number;
  readonly easy: boolean;
  readonly reserved: boolean;
}

type Item = RideItem | { readonly kind: 'anchor'; readonly anchor: Anchor };

interface SimResult {
  readonly steps: PlanStep[];
  readonly score: number;
  readonly weight: number;
  readonly elapsedMin: number;
  readonly feasible: boolean;
  readonly missed: number;
  /** Ride item keys in the sequence that could not be done (park closed by arrival). */
  readonly skipped: ReadonlySet<string>;
  /** Ride item key → index of its step. */
  readonly stepOf: ReadonlyMap<string, number>;
}

export function heightAllowed(ride: Attraction, profile: GroupProfile): boolean {
  return profile.smallestHeightCm === null || ride.minHeightCm <= profile.smallestHeightCm;
}

export function singleRiderAllowed(profile: GroupProfile): boolean {
  // Never split a group that includes a child.
  return profile.singleRiderOk && profile.smallestHeightCm === null && profile.size > 1;
}

/** Members riding on their own because the Carte Facilité party is full (children stay with the holder). */
export function othersCount(profile: GroupProfile): number {
  return profile.easyAccess ? Math.max(0, profile.size - EASY_ACCESS_MAX_PARTY) : 0;
}

function anchorDeadline(a: Anchor): number {
  switch (a.type) {
    case 'show':
      return a.deadline;
    case 'pa':
      return a.booking.returnEnd;
    case 'lunch':
      return a.latest;
  }
}

class Simulator {
  private readonly walk;
  private readonly srMain: boolean;
  private readonly srOthers: boolean;
  private readonly others: number;
  readonly easyOn: boolean;
  private readonly minuteOfDay: (epoch: number) => number;
  private readonly nowMin: number;
  readonly now: number;
  private readonly standbyCache = new Map<string, number>();
  private readonly waitCache = new Map<string, { wait: number; queue: QueueKind }>();
  private readonly othersCache = new Map<string, { wait: number; queue: QueueKind }>();
  evaluations = 0;
  /** Evaluation budget for this problem size. */
  maxEvaluations = MAX_EVALUATIONS;

  constructor(
    private readonly input: PlanInput,
    /** Rides already done today (or covered by Premier Access), to number occurrences. */
    private readonly repBase: ReadonlyMap<string, number>,
    /** Item key holding the current Carte Facilité registration. */
    private readonly reservedKey: string | null,
    /** "Do this now": no registration detour before the first item. */
    private readonly firstIsForced: boolean,
  ) {
    const { profile } = input;
    this.walk = createWalkCache({ pace: profile.pace, stroller: profile.stroller }, input.network);
    this.srMain = singleRiderAllowed(profile);
    this.others = othersCount(profile);
    this.srOthers = this.others > 0 && profile.singleRiderOk;
    this.easyOn = profile.easyAccess;
    this.minuteOfDay = minuteOfDayFn(input.now);
    this.nowMin = this.minuteOfDay(input.now);
    this.now = input.now;
  }

  /** Forecast standby wait, memoised per ride and arrival minute. */
  standbyWait(ride: Attraction, arrive: number): number {
    const key = `${ride.id}@${Math.floor(arrive / MINUTE)}`;
    let v = this.standbyCache.get(key);
    if (v === undefined) {
      const live = this.input.snapshot.attractions[ride.id];
      v = live?.standby == null ? UNKNOWN_WAIT_MIN : predictWaitAt(live.standby, this.nowMin, this.minuteOfDay(arrive), (arrive - this.input.now) / MINUTE, this.input.corrections[ride.id]);
      this.standbyCache.set(key, v);
    }
    return v;
  }

  private singleWait(ride: Attraction, arrive: number): number | null {
    const live = this.input.snapshot.attractions[ride.id];
    if (!ride.singleRider || live?.singleRider == null) return null;
    return predictWaitAt(live.singleRider, this.nowMin, this.minuteOfDay(arrive), (arrive - this.input.now) / MINUTE);
  }

  private bestQueue(ride: Attraction, arrive: number, srOk: boolean, cache: Map<string, { wait: number; queue: QueueKind }>): { wait: number; queue: QueueKind } {
    const key = `${ride.id}@${Math.floor(arrive / MINUTE)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const standby = this.standbyWait(ride, arrive);
    let result: { wait: number; queue: QueueKind } = { wait: standby, queue: 'standby' };
    const single = srOk ? this.singleWait(ride, arrive) : null;
    if (single !== null && single <= standby - SINGLE_RIDER_MIN_GAIN) result = { wait: single, queue: 'single' };
    cache.set(key, result);
    return result;
  }

  /** Queue and wait for the group (or the card party) in the regular queues. */
  rideWait(ride: Attraction, arrive: number): { wait: number; queue: QueueKind } {
    return this.bestQueue(ride, arrive, this.srMain, this.waitCache);
  }

  run(seq: readonly Item[]): SimResult {
    this.evaluations++;
    const { now, snapshot } = this.input;
    let t = now;
    let pos = this.input.position;
    let posKey = this.input.positionKey;
    let weight = 0;
    let missed = 0;
    let othersIdle = 0;
    const steps: PlanStep[] = [];
    const skipped = new Set<string>();
    const stepOf = new Map<string, number>();
    const occurrences = new Map<string, number>();
    let held: { key: string; returnAt: number } | null =
      this.reservedKey && this.input.easyAccessReservation ? { key: this.reservedKey, returnAt: this.input.easyAccessReservation.returnAt } : null;

    // nextEasy[i]: first card ride at or after position i.
    const nextEasy: Array<RideItem | null> = new Array<RideItem | null>(seq.length + 1).fill(null);
    if (this.easyOn) {
      for (let j = seq.length - 1; j >= 0; j--) {
        const it = seq[j]!;
        nextEasy[j] = it.kind === 'ride' && it.easy ? it : nextEasy[j + 1]!;
      }
    }

    /** Registers the next card ride of the sequence when no registration is held. */
    const register = (from: number): void => {
      if (!this.easyOn || held || (from === 0 && this.firstIsForced)) return;
      const next = nextEasy[from];
      if (!next) return;
      const ride = next.ride;
      const walk = this.walk(posKey, pos, ride.id, ride);
      const arrive = Math.max(t + walk * MINUTE, next.availableFrom);
      if (arrive + EASY_ACCESS_BOOK_MIN * MINUTE > snapshot.hours[ride.park].close) return;
      const returnAt = arrive + this.standbyWait(ride, arrive) * MINUTE;
      const endAt = arrive + EASY_ACCESS_BOOK_MIN * MINUTE;
      steps.push({
        kind: 'easy-book',
        targetId: ride.id,
        name: ride.name,
        position: ride,
        departAt: t,
        walkMin: walk,
        arriveAt: arrive,
        waitMin: 0,
        queue: null,
        startAt: arrive,
        endAt,
        latestDepartAt: null,
        rep: 0,
        returnAt,
        others: null,
      });
      held = { key: next.key, returnAt };
      t = endAt;
      pos = ride;
      posKey = ride.id;
    };

    for (let i = 0; i < seq.length; i++) {
      register(i);
      const item = seq[i]!;
      if (item.kind === 'ride') {
        const ride = item.ride;
        const hours = snapshot.hours[ride.park];
        const walk = this.walk(posKey, pos, ride.id, ride);
        let arrive = t + walk * MINUTE;
        const viaCard = held !== null && held.key === item.key;
        if (arrive > hours.close) {
          skipped.add(item.key);
          if (viaCard) held = null;
          continue;
        }
        if (arrive < item.availableFrom) arrive = item.availableFrom;
        let startAt: number;
        let queue: QueueKind;
        if (viaCard) {
          startAt = Math.max(arrive, held!.returnAt) + EASY_ACCESS_RESIDUAL_WAIT_MIN * MINUTE;
          queue = 'easy';
          held = null;
        } else {
          const w = this.rideWait(ride, arrive);
          startAt = arrive + w.wait * MINUTE;
          queue = w.queue;
        }
        const rideMin = ride.durationMin + EXIT_MARGIN_MIN;
        let endAt = startAt + rideMin * MINUTE;
        let others: OthersPlan | null = null;
        if (this.others > 0) {
          // The others queue on arrival, in Single Rider when allowed and worth it.
          const o = this.bestQueue(ride, arrive, this.srOthers, this.othersCache);
          const othersEnd = arrive + (o.wait + rideMin) * MINUTE;
          const rides = othersEnd <= endAt + OTHERS_REGROUP_TOLERANCE_MIN * MINUTE;
          if (rides) endAt = Math.max(endAt, othersEnd);
          else othersIdle++;
          others = { count: this.others, rides, queue: o.queue, waitMin: o.wait };
        }
        const n = (occurrences.get(ride.id) ?? 0) + 1;
        occurrences.set(ride.id, n);
        stepOf.set(item.key, steps.length);
        steps.push({
          kind: 'ride',
          targetId: ride.id,
          name: ride.name,
          position: ride,
          departAt: t,
          walkMin: walk,
          arriveAt: arrive,
          waitMin: Math.round((startAt - arrive) / MINUTE),
          queue,
          startAt,
          endAt,
          latestDepartAt: null,
          rep: (this.repBase.get(ride.id) ?? 0) + n,
          returnAt: null,
          others,
        });
        weight += item.weight;
        t = endAt;
        pos = ride;
        posKey = ride.id;
        continue;
      }

      const a = item.anchor;
      if (a.type === 'lunch') {
        const startAt = Math.max(t, a.earliest);
        if (startAt > a.latest) missed++;
        steps.push({
          kind: 'lunch',
          targetId: '',
          name: 'Pause repas',
          position: pos,
          departAt: t,
          walkMin: 0,
          arriveAt: startAt,
          waitMin: 0,
          queue: null,
          startAt,
          endAt: startAt + a.durationMin * MINUTE,
          latestDepartAt: a.latest,
          rep: 0,
          returnAt: null,
          others: null,
        });
        t = startAt + a.durationMin * MINUTE;
        continue;
      }

      const place: Show | Attraction = a.type === 'show' ? a.show : a.ride;
      const walk = this.walk(posKey, pos, place.id, place);
      const arrive = t + walk * MINUTE;
      let startAt: number;
      let endAt: number;
      let latest: number;
      if (a.type === 'show') {
        latest = a.deadline - walk * MINUTE;
        if (arrive > a.deadline) missed++;
        startAt = a.start;
        endAt = a.start + a.show.durationMin * MINUTE;
      } else {
        latest = a.booking.returnEnd - walk * MINUTE;
        if (arrive > a.booking.returnEnd) missed++;
        startAt = Math.max(arrive, a.booking.returnStart) + PA_RESIDUAL_WAIT_MIN * MINUTE;
        endAt = startAt + (a.ride.durationMin + EXIT_MARGIN_MIN) * MINUTE;
      }
      steps.push({
        kind: a.type,
        targetId: place.id,
        name: place.name,
        position: place,
        departAt: t,
        walkMin: walk,
        arriveAt: arrive,
        waitMin: Math.max(0, Math.round((startAt - arrive) / MINUTE)),
        queue: a.type === 'pa' ? 'premier' : null,
        startAt,
        endAt,
        latestDepartAt: latest,
        rep: 0,
        returnAt: null,
        others: null,
      });
      t = Math.max(t, endAt);
      pos = place;
      posKey = place.id;
    }

    const elapsedMin = (t - now) / MINUTE;
    const walkTotal = steps.reduce((s, x) => s + x.walkMin, 0);
    const score = weight * WEIGHT_SCALE - elapsedMin - 0.1 * walkTotal - othersIdle * OTHERS_IDLE_PENALTY_MIN - missed * MISSED_ANCHOR_PENALTY;
    return { steps, score, weight, elapsedMin, feasible: missed === 0, missed, skipped, stepOf };
  }
}

interface Prepared {
  readonly candidates: RideItem[];
  readonly anchors: Anchor[];
  readonly unplanned: Array<{ id: string; reason: UnplannedReason }>;
  readonly dropped: Array<{ id: string; name: string }>;
  readonly mustTotal: number;
  readonly repBase: ReadonlyMap<string, number>;
  readonly reservedKey: string | null;
}

/**
 * Earliest queueing instant for a ride, or null when it is out of reach today.
 * Before official opening, CLOSED rides open at opening time; rides already OPERATING are
 * Extra Magic Hours rides, usable early only by eligible groups.
 */
export function availableFrom(ride: Attraction, input: Pick<PlanInput, 'now' | 'snapshot' | 'profile'>): number | null {
  const hours = input.snapshot.hours[ride.park];
  const live = input.snapshot.attractions[ride.id];
  const preOpening = input.now < hours.open;
  if (!live) return hours.open;
  switch (live.status) {
    case 'DOWN':
    case 'REFURBISHMENT':
      return null;
    case 'CLOSED':
      return preOpening ? hours.open : null;
    case 'OPERATING':
      return preOpening && input.profile.emhAccess && hours.emh ? hours.emh.open : hours.open;
  }
}

/** Rides wanted today for a wish, bounded. */
export function wantedRides(input: Pick<PlanInput, 'repeats'>, id: string): number {
  const n = input.repeats?.get(id) ?? 1;
  return Number.isInteger(n) ? Math.min(MAX_REPEATS, Math.max(1, n)) : 1;
}

function prepare(input: PlanInput): Prepared {
  const { catalog, snapshot, profile, wishes, done, now } = input;
  // Unused Premier Access slots cover one ride each; used ones are already in doneCounts.
  const bookedIds = new Set(input.paBookings.filter((b) => !b.used).map((b) => b.attractionId));
  const candidates: RideItem[] = [];
  const unplanned: Prepared['unplanned'] = [];
  const repBase = new Map<string, number>();
  let mustTotal = 0;

  for (const [id, priority] of wishes) {
    const place = catalog.get(id);
    if (!place || place.kind !== 'ride') continue;
    if (priority === 'must') mustTotal++;
    if (done.has(id)) continue;
    const already = (input.doneCounts?.get(id) ?? 0) + (bookedIds.has(id) ? 1 : 0);
    const wanted = wantedRides(input, id);
    if (already >= wanted) continue;
    repBase.set(id, already);
    const from = availableFrom(place, input);
    if (!heightAllowed(place, profile)) unplanned.push({ id, reason: 'height' });
    else if (from === null) unplanned.push({ id, reason: 'closed' });
    else {
      for (let rep = already + 1; rep <= wanted; rep++) {
        const weight = PRIORITY_WEIGHT[priority] * (rep === 1 ? 1 : REPEAT_WEIGHT);
        candidates.push({ kind: 'ride', key: `${id}#${rep}`, ride: place, weight, availableFrom: from, easy: false, reserved: false });
      }
    }
  }

  // A held Carte Facilité registration pins its ride (first remaining occurrence).
  let reservedKey: string | null = null;
  const resv = input.easyAccessReservation;
  if (profile.easyAccess && resv) {
    const idx = candidates.findIndex((c) => c.ride.id === resv.rideId);
    const c = candidates[idx];
    if (c) {
      candidates[idx] = { ...c, easy: true, reserved: true, weight: c.weight * RESERVED_WEIGHT_FACTOR };
      reservedKey = c.key;
    }
  }

  const anchors: Anchor[] = [];
  const dropped: Prepared['dropped'] = [];
  const level = crowdLevel(snapshot);
  for (const pick of input.shows) {
    const show = catalog.get(pick.showId);
    if (!show || show.kind !== 'show' || done.has(show.id)) continue;
    const deadline = pick.start - show.arriveBeforeMin[level] * MINUTE;
    if (deadline < now) dropped.push({ id: show.id, name: show.name });
    else anchors.push({ type: 'show', key: `show:${show.id}`, show, start: pick.start, deadline });
  }
  for (const booking of input.paBookings) {
    const ride = catalog.get(booking.attractionId);
    if (!ride || ride.kind !== 'ride' || done.has(ride.id) || booking.used) continue;
    if (booking.returnEnd < now) dropped.push({ id: ride.id, name: `${ride.name} (Premier Access)` });
    else anchors.push({ type: 'pa', key: `pa:${ride.id}`, ride, booking });
  }
  if (profile.lunch.enabled && !input.lunchDone) {
    const earliest = parkWallTime(now, profile.lunch.atMin);
    const latest = earliest + LUNCH_SLACK_MIN * MINUTE;
    if (latest >= now) {
      anchors.push({ type: 'lunch', key: 'lunch', earliest, latest, durationMin: profile.lunch.durationMin });
    }
  }
  anchors.sort((a, b) => anchorDeadline(a) - anchorDeadline(b));
  return { candidates, anchors, unplanned, dropped, mustTotal, repBase, reservedKey };
}

/** Initial Carte Facilité choice: long waits use the card; local search refines it. */
function withEasyGuess(sim: Simulator, input: PlanInput, candidates: readonly RideItem[]): RideItem[] {
  if (!sim.easyOn) return [...candidates];
  return candidates.map((c) => (c.reserved ? c : { ...c, easy: sim.standbyWait(c.ride, Math.max(input.now, c.availableFrom)) >= EASY_ACCESS_MIN_WAIT }));
}

/** Greedy construction: best weight per minute, with an urgency bonus for waits that will grow. */
function construct(sim: Simulator, input: PlanInput, candidates: readonly RideItem[], anchors: readonly Anchor[], forcedFirst?: RideItem): Item[] {
  const seq: Item[] = [];
  const remaining = new Map(candidates.map((c) => [c.key, c]));
  if (forcedFirst) {
    remaining.delete(forcedFirst.key);
    seq.push(forcedFirst);
  }

  const anchorItems: Item[] = anchors.map((anchor) => ({ kind: 'anchor', anchor }));
  for (let k = 0; k <= anchorItems.length; k++) {
    // A ride is only taken if every remaining anchor can still be honoured after it.
    const tail = anchorItems.slice(k);
    const baseline = sim.run([...seq, ...tail]).missed;
    for (;;) {
      const base = sim.run(seq);
      let best: { key: string; utility: number } | null = null;
      const lastEnd = base.steps.at(-1)?.endAt ?? input.now;
      for (const [key, c] of remaining) {
        const trial = sim.run([...seq, c, ...tail]);
        if (trial.missed > baseline || trial.skipped.has(key)) continue;
        const step = trial.steps[trial.stepOf.get(key) ?? -1];
        if (!step) continue;
        const cost = Math.max(5, (step.endAt - lastEnd) / MINUTE);
        // Urgency: waits that grow later make "now" relatively cheaper.
        const later = sim.rideWait(c.ride, step.arriveAt + 120 * MINUTE).wait;
        const urgency = Math.max(0, later - step.waitMin) * 0.5;
        const utility = (c.weight * 100) / Math.max(5, cost - urgency);
        if (!best || utility > best.utility) best = { key, utility };
      }
      if (!best) break;
      seq.push(remaining.get(best.key)!);
      remaining.delete(best.key);
    }
    const next = anchorItems[k];
    if (next) seq.push(next);
  }
  return seq;
}

/** Local search over ride positions; anchors keep their relative order. */
function improve(sim: Simulator, seq: Item[], candidates: readonly RideItem[], lockFirst: boolean): Item[] {
  let current = seq;
  let currentRes = sim.run(current);
  const minPos = lockFirst ? 1 : 0;
  let improved = true;

  const tryAccept = (candidate: Item[]): boolean => {
    const res = sim.run(candidate);
    if (res.score > currentRes.score + 1e-6) {
      current = candidate;
      currentRes = res;
      return true;
    }
    return false;
  };

  while (improved && sim.evaluations < sim.maxEvaluations) {
    improved = false;
    const inSeq = new Set(current.map((i) => (i.kind === 'ride' ? i.key : '')));

    // 1. Insert unscheduled candidates.
    for (const c of candidates) {
      if (inSeq.has(c.key)) continue;
      for (let p = minPos; p <= current.length && !improved; p++) {
        improved = tryAccept([...current.slice(0, p), c, ...current.slice(p)]);
      }
      if (improved) break;
    }
    if (improved) continue;

    // 2. Remove rides that are skipped or that make an anchor infeasible.
    for (let i = minPos; i < current.length && !improved; i++) {
      if (current[i]!.kind !== 'ride') continue;
      improved = tryAccept([...current.slice(0, i), ...current.slice(i + 1)]);
    }
    if (improved) continue;

    // 3. Use the Carte Facilité on a ride or stop using it, at any position: switching the card
    //    to a long ride only pays once short rides sit between registration and return.
    if (sim.easyOn) {
      outer3: for (let i = 0; i < current.length; i++) {
        const it = current[i]!;
        if (it.kind !== 'ride' || it.reserved) continue;
        const toggled: RideItem = { ...it, easy: !it.easy };
        const without = [...current.slice(0, i), ...current.slice(i + 1)];
        // Dropping the card is only tried in place; the card is only worth moving for real waits.
        const anywhere = toggled.easy && sim.standbyWait(it.ride, Math.max(sim.now, it.availableFrom)) >= EASY_ACCESS_MOVE_MIN_WAIT;
        const from = anywhere ? (i < minPos ? i : minPos) : i;
        const to = anywhere ? without.length : i;
        for (let p = from; p <= to; p++) {
          if (tryAccept([...without.slice(0, p), toggled, ...without.slice(p)])) {
            improved = true;
            break outer3;
          }
          if (sim.evaluations >= sim.maxEvaluations) break outer3;
        }
      }
      if (improved) continue;
    }

    // 4. Relocate a ride.
    outer: for (let i = minPos; i < current.length; i++) {
      const item = current[i]!;
      if (item.kind !== 'ride') continue;
      const without = [...current.slice(0, i), ...current.slice(i + 1)];
      for (let p = minPos; p <= without.length; p++) {
        if (p === i) continue;
        if (tryAccept([...without.slice(0, p), item, ...without.slice(p)])) {
          improved = true;
          break outer;
        }
        if (sim.evaluations >= sim.maxEvaluations) break outer;
      }
    }
    if (improved) continue;

    // 5. Swap two rides.
    outer2: for (let i = minPos; i < current.length; i++) {
      if (current[i]!.kind !== 'ride') continue;
      for (let j = i + 1; j < current.length; j++) {
        if (current[j]!.kind !== 'ride') continue;
        const cand = [...current];
        cand[i] = current[j]!;
        cand[j] = current[i]!;
        if (tryAccept(cand)) {
          improved = true;
          break outer2;
        }
        if (sim.evaluations >= sim.maxEvaluations) break outer2;
      }
    }
  }
  return current;
}

function newSimulator(input: PlanInput, prep: Prepared, forced: boolean): Simulator {
  const sim = new Simulator(input, prep.repBase, prep.reservedKey, forced);
  // Each evaluation simulates the whole sequence (plus registrations with the card).
  const items = (prep.candidates.length + prep.anchors.length) * (input.profile.easyAccess ? 1.5 : 1);
  sim.maxEvaluations = Math.min(MAX_EVALUATIONS, Math.floor(MAX_WORK / Math.max(1, items)));
  return sim;
}

/**
 * Solves with `forcedId` (a ride id) done first when given; `noDetour` (the user asked for it
 * now) also forbids a Carte Facilité registration detour before it.
 */
function solve(input: PlanInput, prep: Prepared, forcedId?: string, noDetour = false): SimResult {
  const sim = newSimulator(input, prep, noDetour);
  const candidates = withEasyGuess(sim, input, prep.candidates);
  const forced = forcedId === undefined ? undefined : candidates.find((c) => c.ride.id === forcedId);
  const seq = improve(sim, construct(sim, input, candidates, prep.anchors, forced), candidates, forced !== undefined);
  return sim.run(seq);
}

function toPlan(input: PlanInput, prep: Prepared, res: SimResult): Plan {
  const plannedRides = new Map<string, number>();
  for (const s of res.steps) if (s.kind === 'ride') plannedRides.set(s.targetId, (plannedRides.get(s.targetId) ?? 0) + 1);
  const planned = new Set(res.steps.map((s) => s.targetId));
  const unplanned = [...prep.unplanned];
  const candidateIds = new Set(prep.candidates.map((c) => c.ride.id));
  for (const id of candidateIds) {
    const n = plannedRides.get(id) ?? 0;
    const missing = prep.candidates.filter((c) => c.ride.id === id).length - n;
    if (n === 0) unplanned.push({ id, reason: 'time' });
    else if (missing > 0) unplanned.push({ id, reason: 'repeat' });
  }
  const dropped = [...prep.dropped];
  // Anchors that the best plan still cannot honour are reported, not silently kept.
  if (!res.feasible) {
    for (const s of res.steps) {
      if ((s.kind === 'show' || s.kind === 'pa') && s.latestDepartAt !== null && s.departAt > s.latestDepartAt) {
        dropped.push({ id: s.targetId, name: s.name });
      }
    }
  }
  const mustPlanned = new Set<string>();
  for (const s of res.steps) if ((s.kind === 'ride' || s.kind === 'pa') && input.wishes.get(s.targetId) === 'must') mustPlanned.add(s.targetId);
  for (const b of input.paBookings) if (input.wishes.get(b.attractionId) === 'must' && planned.has(b.attractionId)) mustPlanned.add(b.attractionId);
  return {
    computedAt: input.now,
    steps: res.steps,
    unplanned,
    droppedAnchors: dropped,
    totals: {
      waitMin: res.steps.reduce((s, x) => s + (x.kind === 'ride' || x.kind === 'pa' ? x.waitMin : 0), 0),
      walkMin: res.steps.reduce((s, x) => s + x.walkMin, 0),
      mustPlanned: mustPlanned.size,
      mustTotal: prep.mustTotal,
    },
  };
}

/**
 * Evaluates rides in a fixed order (anchors appended after), without optimisation.
 * Used as a baseline to measure the optimiser.
 */
export function evaluateOrder(input: PlanInput, rideIds: readonly string[]): Plan {
  const prep = prepare(input);
  const sim = newSimulator(input, prep, false);
  const pool = withEasyGuess(sim, input, prep.candidates);
  const seq: Item[] = [];
  for (const id of rideIds) {
    const i = pool.findIndex((c) => c.ride.id === id);
    if (i >= 0) seq.push(...pool.splice(i, 1));
  }
  for (const anchor of prep.anchors) seq.push({ kind: 'anchor', anchor });
  return toPlan(input, prep, sim.run(seq));
}

/** Computes the day plan from the current state. */
export function computePlan(input: PlanInput): Plan {
  const prep = prepare(input);
  const forcedId = input.forcedNextId;
  if (forcedId && prep.candidates.some((c) => c.ride.id === forcedId)) return toPlan(input, prep, solve(input, prep, forcedId, true));
  const best = solve(input, prep);

  // Stability: keep the previous next ride unless switching saves enough.
  const prevId = input.previousNextId;
  const firstRide = best.steps.find((s) => s.kind !== 'easy-book');
  if (prevId && firstRide && firstRide.targetId !== prevId && prep.candidates.some((c) => c.ride.id === prevId)) {
    const kept = solve(input, prep, prevId);
    if (kept.feasible && kept.weight >= best.weight && kept.elapsedMin - best.elapsedMin <= HYSTERESIS_MIN) {
      return toPlan(input, prep, kept);
    }
  }
  return toPlan(input, prep, best);
}
