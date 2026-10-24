import { PA_RESIDUAL_WAIT_MIN } from './planner';
import { MINUTE } from './time';
import type { Attraction, GroupProfile, LiveSnapshot, PaBooking, Place, Plan, Priority, ShowPick, WaitCorrection } from './types';
import { predictWait } from './waits';

/** Recommend only when the standby forecast reaches this (minutes). */
export const PA_MIN_STANDBY = 30;
/** …and the purchase saves at least this (minutes). */
export const PA_MIN_GAIN = 20;

export interface PaAdvice {
  readonly attractionId: string;
  readonly name: string;
  readonly standbyMin: number;
  readonly gainMin: number;
  readonly priceCents: number;
  readonly groupPriceCents: number;
  readonly returnStart: number;
  readonly returnEnd: number;
}

export interface PaAdviceInput {
  readonly now: number;
  readonly catalog: ReadonlyMap<string, Place>;
  readonly snapshot: LiveSnapshot;
  readonly profile: GroupProfile;
  readonly wishes: ReadonlyMap<string, Priority>;
  readonly done: ReadonlySet<string>;
  readonly paBookings: readonly PaBooking[];
  readonly shows: readonly ShowPick[];
  readonly corrections: Readonly<Record<string, WaitCorrection>>;
  readonly plan: Plan | null;
}

/** Remaining Premier Access budget per person, in cents. */
export function remainingBudgetCents(profile: GroupProfile, bookings: readonly PaBooking[]): number {
  const spent = bookings.reduce((s, b) => s + b.priceCents, 0);
  return Math.max(0, Math.round(profile.paBudgetEur * 100) - spent);
}

function windowBlockedByShows(start: number, end: number, input: PaAdviceInput): boolean {
  // Blocked only if the whole return window falls inside a show slot (arrival margin included).
  return input.shows.some((pick) => {
    const show = input.catalog.get(pick.showId);
    if (!show || show.kind !== 'show') return false;
    const busyFrom = pick.start - show.arriveBeforeMin.high * MINUTE;
    const busyTo = pick.start + show.durationMin * MINUTE;
    return start >= busyFrom && end <= busyTo;
  });
}

/**
 * Best Premier Access purchase right now, or null. Advice only: buying happens in the
 * official app; the user then records the slot so the planner can schedule it.
 */
export function advisePremierAccess(input: PaAdviceInput): PaAdvice | null {
  const budget = remainingBudgetCents(input.profile, input.paBookings);
  if (budget <= 0) return null;
  const booked = new Set(input.paBookings.map((b) => b.attractionId));
  let best: (PaAdvice & { value: number }) | null = null;

  for (const [id, priority] of input.wishes) {
    if (input.done.has(id) || booked.has(id)) continue;
    const place = input.catalog.get(id);
    if (!place || place.kind !== 'ride' || !place.premierAccess) continue;
    const live = input.snapshot.attractions[id];
    const pa = live?.pa;
    if (!live || live.status !== 'OPERATING' || live.standby == null || !pa || pa.state !== 'AVAILABLE') continue;
    if (pa.priceCents == null || pa.returnStart == null || pa.returnEnd == null) continue;
    if (pa.priceCents > budget || pa.returnEnd <= input.now) continue;
    if (windowBlockedByShows(pa.returnStart, pa.returnEnd, input)) continue;

    const planned = input.plan?.steps.find((s) => s.kind === 'ride' && s.targetId === id);
    // Already covered by the Carte Facilité: paying would save nothing.
    if (planned?.queue === 'easy') continue;
    const standby =
      planned && planned.queue === 'standby'
        ? planned.waitMin
        : predictWait(live.standby, input.now, Math.max(input.now, pa.returnStart), input.corrections[id]);
    const gain = standby - PA_RESIDUAL_WAIT_MIN;
    if (standby < PA_MIN_STANDBY || gain < PA_MIN_GAIN) continue;

    // Must-do rides first, then minutes saved per euro.
    const value = (gain / (pa.priceCents / 100)) * (priority === 'must' ? 2 : 1);
    if (!best || value > best.value) {
      best = {
        attractionId: id,
        name: (place as Attraction).name,
        standbyMin: standby,
        gainMin: gain,
        priceCents: pa.priceCents,
        groupPriceCents: pa.priceCents * input.profile.size,
        returnStart: pa.returnStart,
        returnEnd: pa.returnEnd,
        value,
      };
    }
  }
  if (!best) return null;
  const { attractionId, name, standbyMin, gainMin, priceCents, groupPriceCents, returnStart, returnEnd } = best;
  return { attractionId, name, standbyMin, gainMin, priceCents, groupPriceCents, returnStart, returnEnd };
}
