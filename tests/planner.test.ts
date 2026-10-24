import { describe, expect, it } from 'vitest';
import { EXIT_MARGIN_MIN, PA_RESIDUAL_WAIT_MIN, computePlan, evaluateOrder } from '../src/domain/planner';
import type { Plan, PlanStep, Priority } from '../src/domain/types';
import { MINUTE, at, catalog, input, profile, snapshot } from './helpers';

const rides = (ids: string[], p: Priority = 'must'): Array<[string, Priority]> => ids.map((id) => [id, p]);
const ids = (plan: Plan) => plan.steps.map((s) => s.targetId);

function assertConsistentTimeline(plan: Plan, now: number) {
  let t = now;
  const seen = new Set<string>();
  for (const s of plan.steps) {
    expect(s.departAt).toBeGreaterThanOrEqual(t);
    expect(s.arriveAt).toBeGreaterThanOrEqual(s.departAt + s.walkMin * MINUTE - 1);
    expect(s.startAt).toBeGreaterThanOrEqual(s.arriveAt);
    expect(s.endAt).toBeGreaterThan(s.startAt);
    if (s.targetId) {
      expect(seen.has(s.targetId)).toBe(false);
      seen.add(s.targetId);
    }
    t = s.endAt;
  }
}

describe('planner — constraints', () => {
  it('excludes rides above the smallest member height, with a reason', () => {
    const plan = computePlan(input({ wishList: rides(['dlp-indiana-jones', 'dlp-peter-pan']), profile: profile({ smallestHeightCm: 110 }) }));
    expect(ids(plan)).toEqual(['dlp-peter-pan']);
    expect(plan.unplanned).toContainEqual({ id: 'dlp-indiana-jones', reason: 'height' });
  });

  it('excludes rides that are down or closed', () => {
    const snap = snapshot({ 'dlp-big-thunder': { status: 'DOWN', standby: null }, 'dlp-pirates': { status: 'REFURBISHMENT', standby: null } });
    const plan = computePlan(input({ snapshot: snap, wishList: rides(['dlp-big-thunder', 'dlp-pirates', 'dlp-buzz']) }));
    expect(ids(plan)).toEqual(['dlp-buzz']);
    expect(plan.unplanned.filter((u) => u.reason === 'closed').map((u) => u.id).sort()).toEqual(['dlp-big-thunder', 'dlp-pirates']);
  });

  it('never queues after the park closes', () => {
    const plan = computePlan(input({ now: at(21, 50), wishList: rides(['daw-crush', 'dlp-buzz']) }));
    expect(ids(plan)).toEqual(['dlp-buzz']);
    expect(plan.unplanned).toContainEqual({ id: 'daw-crush', reason: 'time' });
  });

  it('favours must-do rides when time is short', () => {
    const snap = snapshot({ 'dlp-dumbo': { standby: 40 }, 'dlp-peter-pan': { standby: 40 } });
    const plan = computePlan(
      input({
        now: at(21, 5),
        snapshot: snap,
        wishList: [
          ['dlp-dumbo', 'nice'],
          ['dlp-peter-pan', 'must'],
        ],
      }),
    );
    expect(ids(plan)[0]).toBe('dlp-peter-pan');
  });

  it('gets to a chosen show on time, margin included', () => {
    const start = at(11, 30);
    const show = catalog.get('daw-show-mickey-magician');
    if (show?.kind !== 'show') throw new Error('seed');
    const plan = computePlan(
      input({
        snapshot: snapshot({}, at(10), { 'daw-show-mickey-magician': [start] }),
        shows: [{ showId: show.id, start }],
        wishList: rides(['dlp-big-thunder', 'dlp-peter-pan', 'dlp-buzz', 'dlp-pirates', 'daw-crush', 'daw-ratatouille']),
      }),
    );
    const step = plan.steps.find((s) => s.kind === 'show');
    expect(step).toBeDefined();
    expect(step!.arriveAt).toBeLessThanOrEqual(start - show.arriveBeforeMin.mid * MINUTE);
    expect(step!.startAt).toBe(start);
    expect(plan.droppedAnchors).toEqual([]);
    assertConsistentTimeline(plan, at(10));
  });

  it('reports a show that can no longer be reached', () => {
    const start = at(10, 10);
    const plan = computePlan(input({ shows: [{ showId: 'daw-show-arendelle', start }] }));
    expect(plan.droppedAnchors.map((d) => d.id)).toContain('daw-show-arendelle');
  });

  it('schedules a purchased Premier Access inside its return window', () => {
    const booking = { attractionId: 'dlp-hyperspace', returnStart: at(11), returnEnd: at(12), priceCents: 1500 };
    const plan = computePlan(input({ paBookings: [booking], wishList: rides(['dlp-hyperspace', 'dlp-peter-pan', 'dlp-buzz']) }));
    const step = plan.steps.find((s) => s.targetId === 'dlp-hyperspace');
    expect(step?.kind).toBe('pa');
    expect(step?.queue).toBe('premier');
    expect(step!.arriveAt).toBeLessThanOrEqual(booking.returnEnd);
    expect(step!.startAt).toBeGreaterThanOrEqual(booking.returnStart + PA_RESIDUAL_WAIT_MIN * MINUTE);
    expect(plan.steps.filter((s) => s.targetId === 'dlp-hyperspace')).toHaveLength(1);
  });

  it('inserts the lunch break at or after the preferred time', () => {
    const plan = computePlan(
      input({
        profile: profile({ lunch: { enabled: true, atMin: 12 * 60 + 30, durationMin: 45 } }),
        wishList: rides(['dlp-big-thunder', 'dlp-peter-pan', 'dlp-buzz', 'dlp-pirates', 'dlp-phantom-manor', 'dlp-star-tours']),
      }),
    );
    const lunch = plan.steps.find((s) => s.kind === 'lunch');
    expect(lunch).toBeDefined();
    expect(lunch!.startAt).toBeGreaterThanOrEqual(at(12, 30));
    expect(lunch!.startAt).toBeLessThanOrEqual(at(13, 30));
    expect(lunch!.endAt - lunch!.startAt).toBe(45 * MINUTE);
  });
});

describe('planner — queues', () => {
  const srSnap = snapshot({ 'dlp-hyperspace': { standby: 60, singleRider: 15 } });

  it('uses Single Rider when allowed and worth it', () => {
    const plan = computePlan(input({ snapshot: srSnap, wishList: rides(['dlp-hyperspace']), profile: profile({ singleRiderOk: true, size: 2 }) }));
    expect(plan.steps[0]?.queue).toBe('single');
  });

  it('never splits a group with a child', () => {
    const plan = computePlan(input({ snapshot: srSnap, wishList: rides(['dlp-hyperspace']), profile: profile({ singleRiderOk: true, smallestHeightCm: 125 }) }));
    expect(plan.steps[0]?.queue).toBe('standby');
  });

  it('ignores Single Rider when the gain is small', () => {
    const snap = snapshot({ 'dlp-hyperspace': { standby: 20, singleRider: 10 } });
    const plan = computePlan(input({ snapshot: snap, wishList: rides(['dlp-hyperspace']), profile: profile({ singleRiderOk: true }) }));
    expect(plan.steps[0]?.queue).toBe('standby');
  });
});

describe('planner — behaviour', () => {
  const wishList = rides(['dlp-big-thunder', 'dlp-peter-pan', 'dlp-buzz', 'dlp-pirates', 'dlp-hyperspace', 'dlp-phantom-manor', 'dlp-small-world', 'dlp-star-tours']);

  it('produces a consistent timeline', () => {
    const plan = computePlan(input({ wishList }));
    expect(plan.steps.length).toBe(wishList.length);
    assertConsistentTimeline(plan, at(10));
    expect(plan.totals.mustPlanned).toBe(wishList.length);
    const step = plan.steps[0] as PlanStep;
    const rideDef = catalog.get(step.targetId);
    if (rideDef?.kind === 'ride') expect(step.endAt - step.startAt).toBe((rideDef.durationMin + EXIT_MARGIN_MIN) * MINUTE);
  });

  it('beats the naive wish-list order', () => {
    const optimised = computePlan(input({ wishList })).steps.at(-1)!.endAt;
    const naive = evaluateOrder(input({ wishList }), wishList.map(([id]) => id));
    expect(naive.steps).toHaveLength(wishList.length);
    expect(optimised).toBeLessThanOrEqual(naive.steps.at(-1)!.endAt);
  });

  it('is deterministic', () => {
    expect(ids(computePlan(input({ wishList })))).toEqual(ids(computePlan(input({ wishList }))));
  });

  it('honours "do it now"', () => {
    const plan = computePlan(input({ wishList, forcedNextId: 'dlp-small-world' }));
    expect(plan.steps[0]?.targetId).toBe('dlp-small-world');
  });

  it('keeps the previous recommendation when switching gains little (hysteresis)', () => {
    const base = computePlan(input({ wishList }));
    const second = base.steps[1]!.targetId;
    const kept = computePlan(input({ wishList, previousNextId: second }));
    expect(kept.steps[0]?.targetId).toBe(second);
  });

  it('drops the previous recommendation when it breaks down', () => {
    const base = computePlan(input({ wishList }));
    const first = base.steps[0]!.targetId;
    const snap = snapshot({ [first]: { status: 'DOWN', standby: null } });
    const replanned = computePlan(input({ wishList, snapshot: snap, previousNextId: first }));
    expect(ids(replanned)).not.toContain(first);
  });

  it('stays fast on a full wish list with shows', () => {
    const all = [...catalog.values()].filter((p) => p.kind === 'ride').map((p): [string, Priority] => [p.id, 'nice']);
    const startShow = at(14);
    const t0 = performance.now();
    const plan = computePlan(
      input({
        wishList: all,
        snapshot: snapshot({}, at(10), { 'daw-show-together': [startShow], 'dlp-show-parade': [at(17, 30)] }),
        shows: [
          { showId: 'daw-show-together', start: startShow },
          { showId: 'dlp-show-parade', start: at(17, 30) },
        ],
        profile: profile({ lunch: { enabled: true, atMin: 12 * 60 + 30, durationMin: 45 } }),
      }),
    );
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(plan.droppedAnchors).toEqual([]);
    expect(plan.steps.length).toBeGreaterThan(15);
    assertConsistentTimeline(plan, at(10));
  });
});
