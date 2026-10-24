import { type NetworkFn, createWalkCache } from './geo';
import { MINUTE, minuteOfDayFn, parkWallTime } from './time';
import type {
  Attraction,
  GroupProfile,
  LiveSnapshot,
  PaBooking,
  Place,
  Plan,
  PlanStep,
  Position,
  Priority,
  QueueKind,
  Show,
  ShowPick,
  UnplannedReason,
  WaitCorrection,
} from './types';
import { SINGLE_RIDER_MIN_GAIN, crowdLevel, predictWaitAt } from './waits';

/**
 * Planner: a time-dependent orienteering problem with time windows, solved by a
 * priority-weighted greedy construction followed by local search (insert / relocate /
 * swap / remove), evaluated by full timeline simulation. Pure and deterministic.
 */

export const PRIORITY_WEIGHT: Readonly<Record<Priority, number>> = { must: 5, nice: 1 };
/** Exit / regroup margin after a ride (minutes). */
export const EXIT_MARGIN_MIN = 2;
/** Assumed residual wait in the Premier Access line (minutes). */
export const PA_RESIDUAL_WAIT_MIN = 10;
/** Default wait when a ride has no published wait (minutes). */
export const UNKNOWN_WAIT_MIN = 15;
/** The next step only changes if the new plan saves more than this (minutes). */
export const HYSTERESIS_MIN = 10;
/** Lunch may slip this long after the preferred time (minutes). */
export const LUNCH_SLACK_MIN = 60;

const WEIGHT_SCALE = 10_000;
const MISSED_ANCHOR_PENALTY = 1e9;
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
  readonly shows: readonly ShowPick[];
  readonly paBookings: readonly PaBooking[];
  readonly done: ReadonlySet<string>;
  readonly lunchDone: boolean;
  readonly corrections: Readonly<Record<string, WaitCorrection>>;
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

/** `availableFrom`: earliest instant the group may queue (official opening, or Extra Magic Hours). */
type Item = { readonly kind: 'ride'; readonly ride: Attraction; readonly weight: number; readonly availableFrom: number } | { readonly kind: 'anchor'; readonly anchor: Anchor };

interface SimResult {
  readonly steps: PlanStep[];
  readonly score: number;
  readonly weight: number;
  readonly elapsedMin: number;
  readonly feasible: boolean;
  readonly missed: number;
  /** Ride ids in the sequence that could not be done (park closed by arrival). */
  readonly skipped: ReadonlySet<string>;
}

export function heightAllowed(ride: Attraction, profile: GroupProfile): boolean {
  return profile.smallestHeightCm === null || ride.minHeightCm <= profile.smallestHeightCm;
}

export function singleRiderAllowed(profile: GroupProfile): boolean {
  // Never split a group that includes a child.
  return profile.singleRiderOk && profile.smallestHeightCm === null && profile.size > 1;
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
  private readonly srAllowed: boolean;
  private readonly minuteOfDay: (epoch: number) => number;
  private readonly nowMin: number;
  private readonly waitCache = new Map<string, { wait: number; queue: QueueKind }>();
  evaluations = 0;

  constructor(private readonly input: PlanInput) {
    this.walk = createWalkCache({ pace: input.profile.pace, stroller: input.profile.stroller }, input.network);
    this.srAllowed = singleRiderAllowed(input.profile);
    this.minuteOfDay = minuteOfDayFn(input.now);
    this.nowMin = this.minuteOfDay(input.now);
  }

  /** Forecast queue choice and wait, memoised per ride and arrival minute. */
  rideWait(ride: Attraction, arrive: number): { wait: number; queue: QueueKind } {
    const minute = Math.floor(arrive / MINUTE);
    const key = `${ride.id}@${minute}`;
    const cached = this.waitCache.get(key);
    if (cached) return cached;
    const { snapshot, now, corrections } = this.input;
    const live = snapshot.attractions[ride.id];
    const arrMin = this.minuteOfDay(arrive);
    const ahead = (arrive - now) / MINUTE;
    const standby = live?.standby == null ? UNKNOWN_WAIT_MIN : predictWaitAt(live.standby, this.nowMin, arrMin, ahead, corrections[ride.id]);
    let result: { wait: number; queue: QueueKind } = { wait: standby, queue: 'standby' };
    if (this.srAllowed && ride.singleRider && live?.singleRider != null) {
      const single = predictWaitAt(live.singleRider, this.nowMin, arrMin, ahead);
      if (single <= standby - SINGLE_RIDER_MIN_GAIN) result = { wait: single, queue: 'single' };
    }
    this.waitCache.set(key, result);
    return result;
  }

  run(seq: readonly Item[]): SimResult {
    this.evaluations++;
    const { now, snapshot } = this.input;
    let t = now;
    let pos = this.input.position;
    let posKey = this.input.positionKey;
    let weight = 0;
    let missed = 0;
    const steps: PlanStep[] = [];
    const skipped = new Set<string>();

    for (const item of seq) {
      if (item.kind === 'ride') {
        const ride = item.ride;
        const hours = snapshot.hours[ride.park];
        const walk = this.walk(posKey, pos, ride.id, ride);
        let arrive = t + walk * MINUTE;
        if (arrive > hours.close) {
          skipped.add(ride.id);
          continue;
        }
        if (arrive < item.availableFrom) arrive = item.availableFrom;
        const { wait, queue } = this.rideWait(ride, arrive);
        const startAt = arrive + wait * MINUTE;
        const endAt = startAt + (ride.durationMin + EXIT_MARGIN_MIN) * MINUTE;
        steps.push({
          kind: 'ride',
          targetId: ride.id,
          name: ride.name,
          position: ride,
          departAt: t,
          walkMin: walk,
          arriveAt: arrive,
          waitMin: wait,
          queue,
          startAt,
          endAt,
          latestDepartAt: null,
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
      });
      t = Math.max(t, endAt);
      pos = place;
      posKey = place.id;
    }

    const elapsedMin = (t - now) / MINUTE;
    const walkTotal = steps.reduce((s, x) => s + x.walkMin, 0);
    const score = weight * WEIGHT_SCALE - elapsedMin - 0.1 * walkTotal - missed * MISSED_ANCHOR_PENALTY;
    return { steps, score, weight, elapsedMin, feasible: missed === 0, missed, skipped };
  }
}

interface Prepared {
  readonly candidates: Array<{ readonly ride: Attraction; readonly weight: number; readonly availableFrom: number }>;
  readonly anchors: Anchor[];
  readonly unplanned: Array<{ id: string; reason: UnplannedReason }>;
  readonly dropped: Array<{ id: string; name: string }>;
  readonly mustTotal: number;
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

function prepare(input: PlanInput): Prepared {
  const { catalog, snapshot, profile, wishes, done, now } = input;
  const bookedIds = new Set(input.paBookings.map((b) => b.attractionId));
  const candidates: Prepared['candidates'] = [];
  const unplanned: Prepared['unplanned'] = [];
  let mustTotal = 0;

  for (const [id, priority] of wishes) {
    const place = catalog.get(id);
    if (!place || place.kind !== 'ride') continue;
    if (priority === 'must') mustTotal++;
    if (done.has(id) || bookedIds.has(id)) continue;
    const from = availableFrom(place, input);
    if (!heightAllowed(place, profile)) unplanned.push({ id, reason: 'height' });
    else if (from === null) unplanned.push({ id, reason: 'closed' });
    else candidates.push({ ride: place, weight: PRIORITY_WEIGHT[priority], availableFrom: from });
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
    if (!ride || ride.kind !== 'ride' || done.has(ride.id)) continue;
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
  return { candidates, anchors, unplanned, dropped, mustTotal };
}

/** Greedy construction: best weight per minute, with an urgency bonus for waits that will grow. */
function construct(sim: Simulator, input: PlanInput, prep: Prepared, forcedFirst?: Item): Item[] {
  const seq: Item[] = [];
  const remaining = new Map(prep.candidates.map((c) => [c.ride.id, c]));
  if (forcedFirst?.kind === 'ride') remaining.delete(forcedFirst.ride.id);
  if (forcedFirst) seq.push(forcedFirst);

  const anchorItems: Item[] = prep.anchors.map((anchor) => ({ kind: 'anchor', anchor }));
  for (let k = 0; k <= anchorItems.length; k++) {
    // A ride is only taken if every remaining anchor can still be honoured after it.
    const tail = anchorItems.slice(k);
    const baseline = sim.run([...seq, ...tail]).missed;
    for (;;) {
      const base = sim.run(seq);
      let best: { id: string; utility: number } | null = null;
      const lastEnd = base.steps.at(-1)?.endAt ?? input.now;
      for (const [id, c] of remaining) {
        const trial = sim.run([...seq, { kind: 'ride', ...c }, ...tail]);
        if (trial.missed > baseline || trial.skipped.has(id)) continue;
        const step = trial.steps.find((s) => s.kind === 'ride' && s.targetId === id);
        if (!step) continue;
        const cost = Math.max(5, (step.endAt - lastEnd) / MINUTE);
        // Urgency: waits that grow later make "now" relatively cheaper.
        const later = sim.rideWait(c.ride, step.arriveAt + 120 * MINUTE).wait;
        const urgency = Math.max(0, later - step.waitMin) * 0.5;
        const utility = (c.weight * 100) / Math.max(5, cost - urgency);
        if (!best || utility > best.utility) best = { id, utility };
      }
      if (!best) break;
      const chosen = remaining.get(best.id)!;
      seq.push({ kind: 'ride', ...chosen });
      remaining.delete(best.id);
    }
    const next = anchorItems[k];
    if (next) seq.push(next);
  }
  return seq;
}

/** Local search over ride positions; anchors keep their relative order. */
function improve(sim: Simulator, seq: Item[], prep: Prepared, lockFirst: boolean): Item[] {
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

  while (improved && sim.evaluations < MAX_EVALUATIONS) {
    improved = false;
    const inSeq = new Set(current.filter((i) => i.kind === 'ride').map((i) => (i.kind === 'ride' ? i.ride.id : '')));

    // 1. Insert unscheduled candidates.
    for (const c of prep.candidates) {
      if (inSeq.has(c.ride.id)) continue;
      for (let p = minPos; p <= current.length && !improved; p++) {
        improved = tryAccept([...current.slice(0, p), { kind: 'ride', ...c }, ...current.slice(p)]);
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

    // 3. Relocate a ride.
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
        if (sim.evaluations >= MAX_EVALUATIONS) break outer;
      }
    }
    if (improved) continue;

    // 4. Swap two rides.
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
        if (sim.evaluations >= MAX_EVALUATIONS) break outer2;
      }
    }
  }
  return current;
}

function solve(input: PlanInput, prep: Prepared, forcedFirst?: Item): SimResult {
  const sim = new Simulator(input);
  const seq = improve(sim, construct(sim, input, prep, forcedFirst), prep, forcedFirst !== undefined);
  return sim.run(seq);
}

function toPlan(input: PlanInput, prep: Prepared, res: SimResult): Plan {
  const planned = new Set(res.steps.map((s) => s.targetId));
  const unplanned = [...prep.unplanned];
  for (const c of prep.candidates) {
    if (!planned.has(c.ride.id)) unplanned.push({ id: c.ride.id, reason: 'time' });
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
  let mustPlanned = 0;
  for (const s of res.steps) if (s.kind === 'ride' && input.wishes.get(s.targetId) === 'must') mustPlanned++;
  for (const b of input.paBookings) if (input.wishes.get(b.attractionId) === 'must' && planned.has(b.attractionId)) mustPlanned++;
  return {
    computedAt: input.now,
    steps: res.steps,
    unplanned,
    droppedAnchors: dropped,
    totals: {
      waitMin: res.steps.reduce((s, x) => s + (x.kind === 'ride' || x.kind === 'pa' ? x.waitMin : 0), 0),
      walkMin: res.steps.reduce((s, x) => s + x.walkMin, 0),
      mustPlanned,
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
  const byId = new Map(prep.candidates.map((c) => [c.ride.id, c]));
  const seq: Item[] = [];
  for (const id of rideIds) {
    const c = byId.get(id);
    if (c) seq.push({ kind: 'ride', ...c });
  }
  for (const anchor of prep.anchors) seq.push({ kind: 'anchor', anchor });
  return toPlan(input, prep, new Simulator(input).run(seq));
}

/** Computes the day plan from the current state. */
export function computePlan(input: PlanInput): Plan {
  const prep = prepare(input);
  const forced = input.forcedNextId ? prep.candidates.find((c) => c.ride.id === input.forcedNextId) : undefined;
  if (forced) return toPlan(input, prep, solve(input, prep, { kind: 'ride', ...forced }));
  const best = solve(input, prep);

  // Stability: keep the previous next ride unless switching saves enough.
  const prevId = input.previousNextId;
  const first = best.steps[0];
  if (prevId && first && first.targetId !== prevId) {
    const prev = prep.candidates.find((c) => c.ride.id === prevId);
    if (prev) {
      const kept = solve(input, prep, { kind: 'ride', ...prev });
      if (kept.feasible && kept.weight >= best.weight && kept.elapsedMin - best.elapsedMin <= HYSTERESIS_MIN) {
        return toPlan(input, prep, kept);
      }
    }
  }
  return toPlan(input, prep, best);
}
