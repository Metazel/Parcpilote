import { describe, expect, it } from 'vitest';
import { advisePremierAccess, remainingBudgetCents } from '../src/domain/premierAccess';
import type { PaAdviceInput } from '../src/domain/premierAccess';
import type { Priority } from '../src/domain/types';
import { at, catalog, profile, snapshot } from './helpers';

const pa = (priceCents: number, from = at(11)) => ({ state: 'AVAILABLE' as const, priceCents, returnStart: from, returnEnd: from + 3_600_000 });

function adviceInput(p: Partial<PaAdviceInput> & { wishList?: Array<[string, Priority]> } = {}): PaAdviceInput {
  const { wishList, ...rest } = p;
  return {
    now: at(10),
    catalog,
    snapshot: snapshot({
      'dlp-big-thunder': { standby: 70, pa: pa(1500) },
      'dlp-peter-pan': { standby: 60, pa: pa(800) },
      'dlp-buzz': { standby: 20, pa: pa(500) },
    }),
    profile: profile({ paBudgetEur: 20, size: 3 }),
    wishes: new Map(wishList ?? [['dlp-big-thunder', 'must'], ['dlp-peter-pan', 'nice'], ['dlp-buzz', 'must']]),
    done: new Set(),
    paBookings: [],
    shows: [],
    corrections: {},
    plan: null,
    ...rest,
  };
}

describe('Premier Access advice', () => {
  it('recommends the best value purchase within budget', () => {
    const advice = advisePremierAccess(adviceInput());
    expect(advice).not.toBeNull();
    // Must-do weighting: Big Thunder (must) beats Peter Pan (nice) despite the price.
    expect(advice!.attractionId).toBe('dlp-big-thunder');
    expect(advice!.gainMin).toBeGreaterThanOrEqual(20);
    expect(advice!.groupPriceCents).toBe(4500);
  });

  it('ignores short waits', () => {
    const advice = advisePremierAccess(adviceInput({ wishList: [['dlp-buzz', 'must']] }));
    expect(advice).toBeNull();
  });

  it('respects the remaining budget', () => {
    expect(advisePremierAccess(adviceInput({ profile: profile({ paBudgetEur: 0 }) }))).toBeNull();
    const advice = advisePremierAccess(adviceInput({ profile: profile({ paBudgetEur: 10 }) }));
    expect(advice?.attractionId).toBe('dlp-peter-pan');
    const bookings = [{ attractionId: 'dlp-peter-pan', returnStart: at(11), returnEnd: at(12), priceCents: 800 }];
    expect(remainingBudgetCents(profile({ paBudgetEur: 10 }), bookings)).toBe(200);
  });

  it('skips rides already booked or done', () => {
    const bookings = [{ attractionId: 'dlp-big-thunder', returnStart: at(11), returnEnd: at(12), priceCents: 1500 }];
    expect(advisePremierAccess(adviceInput({ paBookings: bookings, profile: profile({ paBudgetEur: 40 }) }))?.attractionId).toBe('dlp-peter-pan');
    expect(advisePremierAccess(adviceInput({ done: new Set(['dlp-big-thunder']) }))?.attractionId).toBe('dlp-peter-pan');
  });

  it('skips a return window entirely covered by a chosen show', () => {
    // Show at 11:30 (30 min, up to 40 min arrival margin) keeps the group busy 10:50–12:00.
    const shows = [{ showId: 'daw-show-mickey-magician', start: at(11, 30) }];
    const snap = snapshot({ 'dlp-big-thunder': { standby: 70, pa: pa(1500, at(11)) } });
    const wishList: Array<[string, Priority]> = [['dlp-big-thunder', 'must']];
    expect(advisePremierAccess(adviceInput({ snapshot: snap, shows, wishList }))).toBeNull();
    expect(advisePremierAccess(adviceInput({ snapshot: snap, wishList }))?.attractionId).toBe('dlp-big-thunder');
  });

  it('needs an available offer with a known price', () => {
    const snap = snapshot({ 'dlp-big-thunder': { standby: 70, pa: { state: 'FINISHED', priceCents: 1500, returnStart: null, returnEnd: null } } });
    expect(advisePremierAccess(adviceInput({ snapshot: snap, wishList: [['dlp-big-thunder', 'must']] }))).toBeNull();
  });
});
