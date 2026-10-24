import { describe, expect, it } from 'vitest';
import { EASY_ACCESS_RESIDUAL_WAIT_MIN, EXIT_MARGIN_MIN, OTHERS_REGROUP_TOLERANCE_MIN, computePlan } from '../src/domain/planner';
import type { Plan, PlanStep } from '../src/domain/types';
import { MINUTE, at, catalog, input, profile, snapshot } from './helpers';

/** One Carte Facilité registration at a time: every registration is used before the next one. */
function assertOneRegistrationAtATime(plan: Plan, initiallyHeld: string | null = null): void {
  let held = initiallyHeld;
  for (const s of plan.steps) {
    if (s.kind === 'easy-book') {
      expect(held, `registration for ${s.targetId} while ${held} is held`).toBeNull();
      held = s.targetId;
    } else if (s.kind === 'ride' && s.queue === 'easy') {
      expect(s.targetId).toBe(held);
      held = null;
    }
  }
}

const rides = (plan: Plan, id: string): PlanStep[] => plan.steps.filter((s) => s.kind === 'ride' && s.targetId === id);
const end = (plan: Plan) => plan.steps.at(-1)!.endAt;

// Fantasyland: one long wait, several short rides nearby.
const FANTASY = snapshot({
  'dlp-peter-pan': { standby: 60 },
  'dlp-dumbo': { standby: 10 },
  'dlp-lancelot': { standby: 5 },
  'dlp-casey-jr': { standby: 10 },
  'dlp-blanche-neige': { standby: 10 },
});
const FANTASY_WISHES: Array<[string, 'must' | 'nice']> = [
  ['dlp-peter-pan', 'must'],
  ['dlp-dumbo', 'nice'],
  ['dlp-lancelot', 'nice'],
  ['dlp-casey-jr', 'nice'],
  ['dlp-blanche-neige', 'nice'],
];

describe('Carte Facilité', () => {
  it('registers for the long ride and fills the wait with short ones', () => {
    const card = computePlan(input({ snapshot: FANTASY, wishList: FANTASY_WISHES, profile: profile({ easyAccess: true }) }));
    const book = card.steps.findIndex((s) => s.kind === 'easy-book' && s.targetId === 'dlp-peter-pan');
    const ride = card.steps.findIndex((s) => s.kind === 'ride' && s.targetId === 'dlp-peter-pan');
    expect(book).toBeGreaterThanOrEqual(0);
    expect(ride).toBeGreaterThan(book + 1);
    const pp = card.steps[ride]!;
    expect(pp.queue).toBe('easy');
    expect(pp.startAt).toBeGreaterThanOrEqual(card.steps[book]!.returnAt! + EASY_ACCESS_RESIDUAL_WAIT_MIN * MINUTE);
    // Short rides fill the wait: between registration and return, rides in the regular queues.
    const between = card.steps.slice(book + 1, ride);
    expect(between.every((s) => s.kind === 'ride' && s.queue === 'standby')).toBe(true);
    assertOneRegistrationAtATime(card);

    const plain = computePlan(input({ snapshot: FANTASY, wishList: FANTASY_WISHES }));
    expect(plain.steps.some((s) => s.kind === 'easy-book' || s.queue === 'easy')).toBe(false);
    expect(end(card)).toBeLessThan(end(plain) - 20 * MINUTE);
  });

  it('never holds two registrations, over a whole day of long waits', () => {
    const snap = snapshot({ 'dlp-peter-pan': { standby: 60 }, 'dlp-big-thunder': { standby: 70 }, 'dlp-hyperspace': { standby: 50 }, 'dlp-buzz': { standby: 45 } });
    const plan = computePlan(
      input({
        snapshot: snap,
        profile: profile({ easyAccess: true }),
        wishList: [['dlp-peter-pan', 'must'], ['dlp-big-thunder', 'must'], ['dlp-hyperspace', 'must'], ['dlp-buzz', 'must'], ['dlp-dumbo', 'nice'], ['dlp-orbitron', 'nice'], ['dlp-autopia', 'nice']],
      }),
    );
    expect(plan.steps.filter((s) => s.kind === 'easy-book').length).toBeGreaterThanOrEqual(2);
    assertOneRegistrationAtATime(plan);
  });

  it('honours a registration already held: no other registration before it is used', () => {
    const returnAt = at(10, 40);
    const plan = computePlan(
      input({ snapshot: FANTASY, wishList: FANTASY_WISHES, profile: profile({ easyAccess: true }), easyAccessReservation: { rideId: 'dlp-peter-pan', returnAt } }),
    );
    expect(plan.steps.some((s) => s.kind === 'easy-book' && s.targetId === 'dlp-peter-pan')).toBe(false);
    const pp = rides(plan, 'dlp-peter-pan')[0]!;
    expect(pp.queue).toBe('easy');
    expect(pp.startAt).toBeGreaterThanOrEqual(returnAt + EASY_ACCESS_RESIDUAL_WAIT_MIN * MINUTE);
    assertOneRegistrationAtATime(plan, 'dlp-peter-pan');
  });

  it('ignores the card when the group does not hold one', () => {
    const plan = computePlan(input({ snapshot: FANTASY, wishList: FANTASY_WISHES, easyAccessReservation: { rideId: 'dlp-peter-pan', returnAt: at(10, 40) } }));
    expect(plan.steps.some((s) => s.kind === 'easy-book' || s.queue === 'easy')).toBe(false);
  });
});

describe('split group (card party + members on their own)', () => {
  const MARVEL = snapshot({ 'daw-spider-man': { standby: 60, singleRider: 10 }, 'daw-cars-road-trip': { standby: 10 }, 'daw-tangled-spin': { standby: 10 }, 'daw-cars-rallye': { standby: 10 } });
  const wishList: Array<[string, 'must' | 'nice']> = [['daw-spider-man', 'must'], ['daw-cars-road-trip', 'nice'], ['daw-tangled-spin', 'nice'], ['daw-cars-rallye', 'nice']];
  const base = { snapshot: MARVEL, wishList, position: { lat: 48.8668, lon: 2.7805, park: 'daw' as const }, positionKey: 'test-daw' };

  it('sends the 2 members beyond the card party to Single Rider and regroups them at the exit', () => {
    const plan = computePlan(input({ ...base, profile: profile({ size: 7, smallestHeightCm: 110, easyAccess: true, singleRiderOk: true }) }));
    const spidey = rides(plan, 'daw-spider-man')[0]!;
    expect(spidey.queue).toBe('easy');
    expect(spidey.others).toMatchObject({ count: 2, rides: true, queue: 'single' });
    // The others never delay the card party by more than the regroup tolerance.
    for (const s of plan.steps) {
      if (s.kind !== 'ride') continue;
      expect(s.others?.count).toBe(2);
      const ride = catalog.get(s.targetId)!;
      const partyEnd = s.startAt + (ride.kind === 'ride' ? ride.durationMin + EXIT_MARGIN_MIN : 0) * MINUTE;
      expect(s.endAt).toBeLessThanOrEqual(partyEnd + OTHERS_REGROUP_TOLERANCE_MIN * MINUTE);
    }
    assertOneRegistrationAtATime(plan);
  });

  it('lets the others wait at the exit when no queue is fast enough for them', () => {
    const plan = computePlan(input({ ...base, profile: profile({ size: 7, smallestHeightCm: 110, easyAccess: true, singleRiderOk: false }) }));
    const spidey = rides(plan, 'daw-spider-man')[0]!;
    expect(spidey.queue).toBe('easy');
    expect(spidey.others).toMatchObject({ count: 2, rides: false, queue: 'standby' });
    // The card party is not held back by the others' 60-minute queue.
    expect(spidey.endAt - spidey.startAt).toBeLessThan(15 * MINUTE);
  });

  it('keeps everyone together when the whole group fits on the card', () => {
    const plan = computePlan(input({ ...base, profile: profile({ size: 5, smallestHeightCm: 110, easyAccess: true, singleRiderOk: true }) }));
    expect(plan.steps.every((s) => s.others === null)).toBe(true);
    // Never Single Rider with a child in the card party.
    expect(plan.steps.some((s) => s.queue === 'single')).toBe(false);
  });
});

describe('repeated rides', () => {
  it('plans an attraction as many times as wished, numbered in order', () => {
    const plan = computePlan(input({ wishList: [['dlp-buzz', 'must'], ['dlp-orbitron', 'nice']], repeats: new Map([['dlp-buzz', 3]]) }));
    expect(rides(plan, 'dlp-buzz').map((s) => s.rep)).toEqual([1, 2, 3]);
    expect(rides(plan, 'dlp-orbitron').map((s) => s.rep)).toEqual([1]);
    expect(plan.totals.mustPlanned).toBe(1);
  });

  it('counts the rides already done today', () => {
    const plan = computePlan(input({ wishList: [['dlp-buzz', 'must']], repeats: new Map([['dlp-buzz', 3]]), doneCounts: new Map([['dlp-buzz', 1]]) }));
    expect(rides(plan, 'dlp-buzz').map((s) => s.rep)).toEqual([2, 3]);
  });

  it('discovers every wish before repeating one when time runs short', () => {
    const plan = computePlan(
      input({
        now: at(21, 15),
        snapshot: snapshot({ 'dlp-buzz': { standby: 10 }, 'dlp-orbitron': { standby: 10 } }, at(21, 15)),
        wishList: [['dlp-buzz', 'nice'], ['dlp-orbitron', 'nice']],
        repeats: new Map([['dlp-buzz', 4]]),
      }),
    );
    expect(rides(plan, 'dlp-orbitron')).toHaveLength(1);
    expect(plan.unplanned).toContainEqual({ id: 'dlp-buzz', reason: 'repeat' });
  });

  it('uses a Premier Access slot as one of the rides, once', () => {
    const booking = { attractionId: 'dlp-buzz', returnStart: at(11), returnEnd: at(12), priceCents: 1000 };
    const wishes = { wishList: [['dlp-buzz', 'must']] as Array<[string, 'must']>, repeats: new Map([['dlp-buzz', 2]]) };
    const before = computePlan(input({ ...wishes, paBookings: [booking] }));
    expect(before.steps.filter((s) => s.targetId === 'dlp-buzz').map((s) => s.kind).sort()).toEqual(['pa', 'ride']);
    const after = computePlan(input({ ...wishes, paBookings: [{ ...booking, used: true }], doneCounts: new Map([['dlp-buzz', 1]]) }));
    expect(after.steps.filter((s) => s.targetId === 'dlp-buzz').map((s) => `${s.kind}${s.rep}`)).toEqual(['ride2']);
  });
});
