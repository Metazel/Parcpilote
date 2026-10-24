import { normalizeName } from './catalog';
import type { FoodService, ParkId } from '../domain/types';

/**
 * Dining rules and references for the resort.
 * Sources: official restaurant pages (disneylandparis.com) and visitor guides, checked in
 * October 2026. Table-service names are matched loosely (accents, case, punctuation).
 */
export interface ResortDining {
  /**
   * Where a packed lunch may be eaten: in the parks, only outside the gates, or unknown
   * (`auto`: a picnic area far from every attraction is taken as outside the gates).
   */
  readonly picnic: 'inside' | 'outside' | 'auto';
  /** Leaving the parks and coming back through security, in minutes (picnic outside). */
  readonly reentryMin: number;
  readonly picnicNote: string;
  /** Used when OpenStreetMap lists no picnic area: approximate position, said so in its name. */
  readonly picnicFallback: { readonly name: string; readonly lat: number; readonly lon: number; readonly park: ParkId } | null;
  /** Seated restaurants (table service or buffet) inside the parks. */
  readonly tableService: readonly string[];
  /** Official list of restaurants with their menus. */
  readonly restaurantsUrl: string;
}

export const DLP_DINING: ResortDining = {
  picnic: 'outside',
  reentryMin: 15,
  picnicNote: "Pique-nique autorisé sans glacière ni table pliante ; l'aire de pique-nique est hors des parcs, entre le parking et l'entrée.",
  picnicFallback: { name: 'Aire de pique-nique (hors des parcs, côté parking, position approximative)', lat: 48.8693, lon: 2.7812, park: 'dlp' },
  tableService: [
    'Auberge de Cendrillon',
    "Captain Jack's",
    'Silver Spur Steakhouse',
    'Lucky Nugget Saloon',
    "Victoria's Homestyle Restaurant",
    "Walt's",
    'Plaza Gardens',
    'Agrabah Café',
    'Bistrot Chez Rémy',
    'Regal View Restaurant',
  ],
  restaurantsUrl: 'https://www.disneylandparis.com/fr-fr/restaurants/',
};

const TABLE_KEYS = DLP_DINING.tableService.map(normalizeName);

/** Table service when the name matches a known seated restaurant, else counter / kiosk. */
export function officialService(name: string, dining: ResortDining = DLP_DINING): FoodService {
  const key = normalizeName(name);
  const keys = dining === DLP_DINING ? TABLE_KEYS : dining.tableService.map(normalizeName);
  return keys.some((k) => key.includes(k)) ? 'table' : 'quick';
}
