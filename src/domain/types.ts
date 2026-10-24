/** Domain model shared by the planner, the data adapters and the UI. All instants are epoch ms. */

export type ParkId = 'dlp' | 'daw';

export const PARK_NAMES: Readonly<Record<ParkId, string>> = {
  dlp: 'Disneyland Park',
  daw: 'Disney Adventure World',
};

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface Position extends GeoPoint {
  readonly park: ParkId;
}

interface PlaceBase extends Position {
  readonly id: string;
  readonly name: string;
  readonly land: string;
}

export interface Attraction extends PlaceBase {
  readonly kind: 'ride';
  /** Ride duration, boarding to exit, in minutes. */
  readonly durationMin: number;
  /** Minimum height in cm, 0 when none. */
  readonly minHeightCm: number;
  readonly singleRider: boolean;
  readonly premierAccess: boolean;
  /** 1 = calme, 2 = modérée, 3 = sensations. */
  readonly intensity: 1 | 2 | 3;
}

export type CrowdLevel = 'low' | 'mid' | 'high';

export interface Show extends PlaceBase {
  readonly kind: 'show';
  readonly durationMin: number;
  /** Advised arrival margin before start, per crowd level (minutes). */
  readonly arriveBeforeMin: Readonly<Record<CrowdLevel, number>>;
}

export type Place = Attraction | Show;

export type PoiKind = 'toilets' | 'food' | 'water';

/** Service point (restroom, food, drinking water) from OpenStreetMap or the official feed. */
export interface Poi extends GeoPoint {
  readonly id: string;
  readonly kind: PoiKind;
  readonly name: string;
  readonly park: ParkId;
  readonly source: 'osm' | 'official';
}

export type RideStatus = 'OPERATING' | 'DOWN' | 'CLOSED' | 'REFURBISHMENT';

export type PaState = 'AVAILABLE' | 'TEMP_FULL' | 'FINISHED';

export interface PremierAccessOffer {
  readonly state: PaState;
  /** Price per person in euro cents, when known. */
  readonly priceCents: number | null;
  readonly returnStart: number | null;
  readonly returnEnd: number | null;
}

export interface LiveAttraction {
  readonly status: RideStatus;
  readonly standby: number | null;
  readonly singleRider: number | null;
  readonly pa: PremierAccessOffer | null;
}

export interface TimeWindow {
  readonly open: number;
  readonly close: number;
}

export interface ParkHours extends TimeWindow {
  /** Extra Magic Hours ("Heures de Magie en Plus") for eligible guests, when announced. */
  readonly emh: TimeWindow | null;
}

export interface LiveSnapshot {
  readonly source: 'live' | 'demo';
  readonly fetchedAt: number;
  readonly attractions: Readonly<Record<string, LiveAttraction>>;
  /** Show id -> start instants of today's sessions, sorted. */
  readonly showtimes: Readonly<Record<string, readonly number[]>>;
  readonly hours: Readonly<Record<ParkId, ParkHours>>;
}

export type Pace = 'slow' | 'normal' | 'fast';

export interface GroupProfile {
  readonly size: number;
  /** Height of the smallest member in cm; null when the group is adults only. */
  readonly smallestHeightCm: number | null;
  readonly singleRiderOk: boolean;
  /** Premier Access budget per person for the day, in euros. */
  readonly paBudgetEur: number;
  readonly pace: Pace;
  readonly stroller: boolean;
  readonly lunch: { readonly enabled: boolean; readonly atMin: number; readonly durationMin: number };
  readonly startPark: ParkId;
  /** Eligible to Extra Magic Hours (Disney hotel guests, some annual passes). */
  readonly emhAccess: boolean;
}

export type Priority = 'must' | 'nice';

export interface ShowPick {
  readonly showId: string;
  readonly start: number;
}

export interface PaBooking {
  readonly attractionId: string;
  readonly returnStart: number;
  readonly returnEnd: number;
  readonly priceCents: number;
}

/** Local correction learned from the user's own "actual wait" reports. */
export interface WaitCorrection {
  readonly ratio: number;
  readonly samples: number;
}

export type QueueKind = 'standby' | 'single' | 'premier';

export type StepKind = 'ride' | 'show' | 'lunch' | 'pa';

export interface PlanStep {
  readonly kind: StepKind;
  /** Place id; empty string for the lunch break. */
  readonly targetId: string;
  readonly name: string;
  readonly position: Position;
  readonly departAt: number;
  readonly walkMin: number;
  readonly arriveAt: number;
  readonly waitMin: number;
  readonly queue: QueueKind | null;
  readonly startAt: number;
  readonly endAt: number;
  /** For time-bound steps (show, Premier Access, lunch): latest departure that still makes it. */
  readonly latestDepartAt: number | null;
}

export type UnplannedReason = 'closed' | 'height' | 'time' | 'done';

export interface Plan {
  readonly computedAt: number;
  readonly steps: readonly PlanStep[];
  readonly unplanned: ReadonlyArray<{ readonly id: string; readonly reason: UnplannedReason }>;
  readonly droppedAnchors: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly totals: { readonly waitMin: number; readonly walkMin: number; readonly mustPlanned: number; readonly mustTotal: number };
}
