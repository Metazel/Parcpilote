import { MINUTE, formatHM } from '../domain/time';
import type { FoodService, LiveAttraction, MealMode, MealSlot, ParkId, ParkInfo, PlanStep, PoiKind, QueueKind, StepKind, UnplannedReason } from '../domain/types';

/** Short name of a park of the destination. */
export function parkShort(parks: readonly ParkInfo[], id: ParkId): string {
  return parks.find((p) => p.id === id)?.short ?? '';
}

/** Full name of a park of the destination. */
export function parkName(parks: readonly ParkInfo[], id: ParkId): string {
  return parks.find((p) => p.id === id)?.name ?? '';
}

/** CSS class carrying the park's line colour. */
export function parkClass(parks: readonly ParkInfo[], id: ParkId): string {
  return `park-${(parks.find((p) => p.id === id)?.color ?? 0) % 4}`;
}

/** "Land, Park", without repeating the park when the land is the park itself. */
export function whereLabel(land: string, parks: readonly ParkInfo[], id: ParkId): string {
  const park = parkShort(parks, id);
  if (!park || land === park || land === parkName(parks, id)) return land || park;
  return parks.length > 1 ? `${land}, ${park}` : land;
}

export const STEP_LABEL: Readonly<Record<StepKind, string>> = {
  ride: 'Attraction',
  show: 'Spectacle',
  pa: 'Premier Access',
  meal: 'Repas',
  'easy-book': 'Inscription Carte Facilité',
};

export const QUEUE_LABEL: Readonly<Record<QueueKind, string>> = {
  standby: 'file standard',
  single: 'file Single Rider',
  premier: 'file Premier Access',
  easy: 'entrée Premier Access avec la Carte Facilité',
};

export const REASON_LABEL: Readonly<Record<UnplannedReason, string>> = {
  closed: 'Fermée ou en panne',
  height: 'Taille minimale non atteinte',
  time: 'Plus assez de temps',
  done: 'Déjà faite',
  repeat: 'Pas le temps de la refaire autant de fois',
};

/** "2e fois" label for repeated rides; empty for a first ride. */
export function repLabel(rep: number): string {
  return rep >= 2 ? `${rep}e fois` : '';
}

export const MEAL_SLOT_LABEL: Readonly<Record<MealSlot, string>> = { lunch: 'Déjeuner', dinner: 'Dîner' };

export const MEAL_MODE_LABEL: Readonly<Record<MealMode, string>> = {
  free: 'Là où vous êtes',
  picnic: 'Pique-nique',
  quick: 'Sur le pouce',
  table: 'À table',
};

export const SERVICE_LABEL: Readonly<Record<FoodService, string>> = { quick: 'sur le pouce', table: 'à table' };

export const POI_LABEL: Readonly<Record<PoiKind, string>> = { toilets: 'Toilettes', food: 'Restauration', water: "Point d'eau", picnic: 'Aire de pique-nique' };

/** Title of a step, with "2e fois" for repeated rides and the meal for meal stops. */
export function stepTitle(step: PlanStep): string {
  if (step.kind === 'meal' && step.meal) {
    const slot = MEAL_SLOT_LABEL[step.meal.slot];
    return step.targetId ? `${slot} : ${step.name}` : slot;
  }
  const rep = repLabel(step.rep);
  return rep ? `${step.name} (${rep})` : step.name;
}

export function minutes(n: number): string {
  return `${n} min`;
}

export function euros(cents: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

export function inMinutes(target: number, now: number): string {
  const m = Math.round((target - now) / MINUTE);
  if (m <= 0) return 'maintenant';
  if (m < 60) return `dans ${m} min`;
  return `à ${formatHM(target)}`;
}

export type WaitBand = 'ok' | 'mid' | 'high' | 'closed';

export function waitBand(live: LiveAttraction | undefined): WaitBand {
  if (!live || live.status !== 'OPERATING' || live.standby === null) return 'closed';
  if (live.standby <= 15) return 'ok';
  if (live.standby <= 35) return 'mid';
  return 'high';
}

export function liveLabel(live: LiveAttraction | undefined): string {
  if (!live) return 'Pas de donnée';
  switch (live.status) {
    case 'DOWN':
      return 'En panne';
    case 'CLOSED':
      return 'Fermée';
    case 'REFURBISHMENT':
      return 'En rénovation';
    case 'OPERATING':
      return live.standby === null ? 'Ouverte' : `${live.standby} min`;
  }
}

export { formatHM };
