import { MINUTE, parkDateKey, parkMinutesOfDay, parkWallTime } from '../domain/time';
import type { LiveAttraction, LiveSnapshot, ParkHours, ParkId, ParkInfo, Place } from '../domain/types';
import { destination } from './destinations';
import { crowdFactor } from '../domain/waits';
import { DEFAULT_HOURS } from './themeparks';

/**
 * Deterministic demo data source: same rules as live data, seeded by the park-local date,
 * so a whole day can be replayed (simulated clock) and tested.
 */

/** Typical peak standby (minutes) used by the simulation only. */
const PEAK_WAIT: Readonly<Record<string, number>> = {
  'dlp-big-thunder': 60,
  'dlp-phantom-manor': 30,
  'dlp-riverboat': 15,
  'dlp-pirates': 30,
  'dlp-indiana-jones': 35,
  'dlp-robinson': 5,
  'dlp-aladdin': 5,
  'dlp-peter-pan': 65,
  'dlp-blanche-neige': 25,
  'dlp-pinocchio': 25,
  'dlp-lancelot': 15,
  'dlp-dumbo': 35,
  'dlp-alice': 10,
  'dlp-tea-cups': 20,
  'dlp-small-world': 30,
  'dlp-casey-jr': 20,
  'dlp-contes-de-fees': 15,
  'dlp-hyperspace': 50,
  'dlp-star-tours': 30,
  'dlp-buzz': 45,
  'dlp-orbitron': 45,
  'dlp-autopia': 45,
  'dlp-nautilus': 10,
  'dlp-philharmagic': 20,
  'daw-flight-force': 55,
  'daw-spider-man': 45,
  'daw-tower-of-terror': 45,
  'daw-ratatouille': 50,
  'daw-crush': 80,
  'daw-cars-rallye': 25,
  'daw-parachute-drop': 40,
  'daw-slinky-dog': 30,
  'daw-rc-racer': 35,
  'daw-cars-road-trip': 20,
  'daw-frozen-ever-after': 90,
  'daw-tangled-spin': 45,
};

/** Show sessions as park-local "HH:MM". */
const SHOW_TIMES: Readonly<Record<string, readonly string[]>> = {
  'dlp-show-castle-night': ['21:35'],
  'dlp-show-parade': ['17:30'],
  'daw-show-mickey-magician': ['11:30', '13:30', '15:30', '17:15'],
  'daw-show-together': ['12:15', '14:45', '16:45'],
  'daw-show-arendelle': ['11:00', '12:30', '14:00', '15:30', '17:00', '18:30'],
  'daw-show-frozen-invitation': ['10:45', '13:00', '16:00'],
};

const REFURB_POOL = ['dlp-casey-jr', 'dlp-contes-de-fees', 'daw-cars-rallye'];
const BREAKDOWN_POOL = ['dlp-big-thunder', 'dlp-hyperspace', 'dlp-buzz', 'dlp-star-tours', 'daw-crush', 'daw-tower-of-terror', 'daw-ratatouille', 'daw-spider-man'];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic value in [0, 1) for a key. */
function unit(key: string): number {
  let t = hashString(key) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const round5 = (v: number) => Math.max(0, Math.round(v / 5) * 5);

function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface DemoOverrides {
  /** Ride id → epoch until which the ride is forced DOWN (demo "simulate a breakdown"). */
  readonly forcedDown: Readonly<Record<string, number>>;
}

/** Demo Extra Magic Hours: one hour before opening at Disneyland Park, these lands only. */
const EMH_LANDS = new Set(['Fantasyland', 'Discoveryland']);

/** The two Disneyland Paris parks, as the demo day presents them. */
export function curatedParks(id = 'dlp'): ParkInfo[] {
  return destination(id).parks.map((k, i) => ({ id: k.id, name: k.name, short: k.short, entrance: k.entrance, color: i }));
}

export function demoHours(now: number): Record<ParkId, ParkHours> {
  const dlpOpen = parkWallTime(now, DEFAULT_HOURS.dlp[0]);
  return {
    dlp: { open: dlpOpen, close: parkWallTime(now, DEFAULT_HOURS.dlp[1]), emh: { open: dlpOpen - 60 * MINUTE, close: dlpOpen } },
    daw: { open: parkWallTime(now, DEFAULT_HOURS.daw[0]), close: parkWallTime(now, DEFAULT_HOURS.daw[1]), emh: null },
  };
}

export function demoSnapshot(now: number, catalog: ReadonlyMap<string, Place>, overrides: DemoOverrides = { forcedDown: {} }): LiveSnapshot {
  const day = parkDateKey(now);
  const hours = demoHours(now);
  const dayFactor = 0.8 + 0.4 * unit(`${day}:crowd`);
  const refurb = REFURB_POOL[Math.floor(unit(`${day}:refurb`) * REFURB_POOL.length)];
  const breakdowns = [0, 1].map((i) => {
    const id = BREAKDOWN_POOL[Math.floor(unit(`${day}:bd${i}`) * BREAKDOWN_POOL.length)]!;
    const from = parkWallTime(now, 11 * 60 + Math.floor(unit(`${day}:bdt${i}`) * 7 * 60));
    return { id, from, to: from + (45 + Math.floor(unit(`${day}:bdd${i}`) * 45)) * MINUTE };
  });
  const bucket = Math.floor(parkMinutesOfDay(now) / 15);
  const factor = crowdFactor(parkMinutesOfDay(now));

  const attractions: Record<string, LiveAttraction> = {};
  const showtimes: Record<string, number[]> = {};
  for (const place of catalog.values()) {
    if (place.kind === 'show') {
      showtimes[place.id] = (SHOW_TIMES[place.id] ?? []).map((s) => parkWallTime(now, hhmm(s)));
      continue;
    }
    const h = hours[place.park];
    if (!h) continue;
    const forced = overrides.forcedDown[place.id];
    let status: LiveAttraction['status'] = 'OPERATING';
    const inEmh = h.emh !== null && now >= h.emh.open && now < h.emh.close && EMH_LANDS.has(place.land);
    if ((now < h.open && !inEmh) || now >= h.close) status = 'CLOSED';
    else if (place.id === refurb) status = 'REFURBISHMENT';
    else if ((forced !== undefined && now < forced) || breakdowns.some((b) => b.id === place.id && now >= b.from && now < b.to)) status = 'DOWN';

    if (status !== 'OPERATING') {
      attractions[place.id] = { status, standby: null, singleRider: null, pa: null };
      continue;
    }
    const peak = PEAK_WAIT[place.id] ?? 20;
    const noise = 0.85 + 0.3 * unit(`${day}:${place.id}:${bucket}`);
    const standby = Math.max(5, round5(peak * factor * dayFactor * noise));
    const returnStart = Math.ceil((now + (15 + peak / 2) * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
    attractions[place.id] = {
      status,
      standby,
      singleRider: place.singleRider ? Math.max(5, round5(standby * 0.45)) : null,
      pa: place.premierAccess
        ? {
            state: returnStart < h.close - 60 * MINUTE ? 'AVAILABLE' : 'FINISHED',
            priceCents: Math.min(2100, Math.round((500 + peak * 15) / 100) * 100),
            returnStart,
            returnEnd: returnStart + 60 * MINUTE,
          }
        : null,
    };
  }
  return { source: 'demo', fetchedAt: now, parks: curatedParks(), attractions, showtimes, hours };
}
