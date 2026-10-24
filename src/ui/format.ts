import { MINUTE, formatHM } from '../domain/time';
import type { LiveAttraction, ParkId, QueueKind, StepKind, UnplannedReason } from '../domain/types';

export const PARK_SHORT: Readonly<Record<ParkId, string>> = { dlp: 'Disneyland Park', daw: 'Adventure World' };

export const STEP_LABEL: Readonly<Record<StepKind, string>> = {
  ride: 'Attraction',
  show: 'Spectacle',
  pa: 'Premier Access',
  lunch: 'Pause',
};

export const QUEUE_LABEL: Readonly<Record<QueueKind, string>> = {
  standby: 'file standard',
  single: 'file Single Rider',
  premier: 'file Premier Access',
};

export const REASON_LABEL: Readonly<Record<UnplannedReason, string>> = {
  closed: 'Fermée ou en panne',
  height: 'Taille minimale non atteinte',
  time: 'Plus assez de temps',
  done: 'Déjà faite',
};

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
