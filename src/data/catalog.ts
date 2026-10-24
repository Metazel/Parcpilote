import type { Attraction, CrowdLevel, ParkId, Place, Show } from '../domain/types';

/**
 * Seed referential for Disneyland Paris (v0.1).
 * Durations, height limits, positions and line options are INDICATIVE editorial values,
 * to be checked against the official app. In live mode, ThemeParks.wiki positions,
 * statuses and queue types override them.
 */

type RideSeed = [id: string, name: string, land: string, lat: number, lon: number, durationMin: number, minHeightCm: number, singleRider: boolean, premierAccess: boolean, intensity: 1 | 2 | 3];
type ShowSeed = [id: string, name: string, land: string, lat: number, lon: number, durationMin: number, low: number, mid: number, high: number];

const DLP_RIDES: RideSeed[] = [
  ['dlp-big-thunder', 'Big Thunder Mountain', 'Frontierland', 48.8738, 2.7713, 4, 102, false, true, 3],
  ['dlp-phantom-manor', 'Phantom Manor', 'Frontierland', 48.8728, 2.7722, 6, 0, false, true, 2],
  ['dlp-riverboat', 'Thunder Mesa Riverboat Landing', 'Frontierland', 48.8735, 2.7735, 15, 0, false, false, 1],
  ['dlp-pirates', 'Pirates of the Caribbean', 'Adventureland', 48.8712, 2.7742, 13, 0, false, false, 2],
  ['dlp-indiana-jones', 'Indiana Jones and the Temple of Peril', 'Adventureland', 48.8703, 2.7722, 2, 140, true, true, 3],
  ['dlp-robinson', 'La Cabane des Robinson', 'Adventureland', 48.8716, 2.7727, 15, 0, false, false, 1],
  ['dlp-aladdin', "Le Passage Enchanté d'Aladdin", 'Adventureland', 48.8717, 2.7752, 5, 0, false, false, 1],
  ['dlp-peter-pan', "Peter Pan's Flight", 'Fantasyland', 48.8742, 2.7757, 3, 0, false, true, 1],
  ['dlp-blanche-neige', 'Blanche-Neige et les Sept Nains', 'Fantasyland', 48.874, 2.7766, 3, 0, false, false, 1],
  ['dlp-pinocchio', 'Les Voyages de Pinocchio', 'Fantasyland', 48.8742, 2.7769, 3, 0, false, false, 1],
  ['dlp-lancelot', 'Le Carrousel de Lancelot', 'Fantasyland', 48.8744, 2.7762, 2, 0, false, false, 1],
  ['dlp-dumbo', 'Dumbo the Flying Elephant', 'Fantasyland', 48.8749, 2.7757, 2, 0, false, true, 1],
  ['dlp-alice', "Alice's Curious Labyrinth", 'Fantasyland', 48.8752, 2.7748, 15, 0, false, false, 1],
  ['dlp-tea-cups', "Mad Hatter's Tea Cups", 'Fantasyland', 48.8753, 2.7756, 2, 0, false, false, 2],
  ['dlp-small-world', '"it\'s a small world"', 'Fantasyland', 48.8758, 2.7768, 11, 0, false, true, 1],
  ['dlp-casey-jr', 'Casey Jr. – le Petit Train du Cirque', 'Fantasyland', 48.8752, 2.7774, 3, 0, false, false, 1],
  ['dlp-contes-de-fees', 'Le Pays des Contes de Fées', 'Fantasyland', 48.8755, 2.7778, 6, 0, false, false, 1],
  ['dlp-hyperspace', 'Star Wars Hyperspace Mountain', 'Discoveryland', 48.8738, 2.779, 3, 120, true, true, 3],
  ['dlp-star-tours', 'Star Tours: The Adventures Continue', 'Discoveryland', 48.8745, 2.7784, 5, 102, false, true, 2],
  ['dlp-buzz', 'Buzz Lightyear Laser Blast', 'Discoveryland', 48.8727, 2.779, 5, 0, false, true, 1],
  ['dlp-orbitron', 'Orbitron', 'Discoveryland', 48.8735, 2.7783, 2, 0, false, true, 2],
  ['dlp-autopia', 'Autopia', 'Discoveryland', 48.8749, 2.7792, 5, 81, false, true, 1],
  ['dlp-nautilus', 'Les Mystères du Nautilus', 'Discoveryland', 48.874, 2.7798, 10, 0, false, false, 1],
  ['dlp-philharmagic', "Mickey's PhilharMagic", 'Discoveryland', 48.8731, 2.7798, 12, 0, false, false, 1],
];

const DAW_RIDES: RideSeed[] = [
  ['daw-flight-force', 'Avengers Assemble: Flight Force', 'Marvel Avengers Campus', 48.8662, 2.7815, 2, 120, true, true, 3],
  ['daw-spider-man', 'Spider-Man W.E.B. Adventure', 'Marvel Avengers Campus', 48.8668, 2.7811, 5, 0, true, true, 1],
  ['daw-tower-of-terror', 'The Twilight Zone Tower of Terror', 'Adventure Way', 48.8659, 2.7787, 4, 102, false, true, 3],
  ['daw-ratatouille', 'Ratatouille : L’Aventure Totalement Toquée de Rémy', 'Worlds of Pixar', 48.8668, 2.7764, 5, 0, true, true, 1],
  ['daw-crush', "Crush's Coaster", 'Worlds of Pixar', 48.867, 2.7775, 3, 107, false, true, 3],
  ['daw-cars-rallye', 'Cars Quatre Roues Rallye', 'Worlds of Pixar', 48.8666, 2.7777, 2, 0, false, false, 1],
  ['daw-parachute-drop', 'Toy Soldiers Parachute Drop', 'Worlds of Pixar', 48.8656, 2.777, 2, 81, false, true, 2],
  ['daw-slinky-dog', 'Slinky Dog Zigzag Spin', 'Worlds of Pixar', 48.8654, 2.7775, 2, 0, false, false, 1],
  ['daw-rc-racer', 'RC Racer', 'Worlds of Pixar', 48.8652, 2.7768, 2, 120, false, true, 3],
  ['daw-cars-road-trip', 'Cars Road Trip', 'Worlds of Pixar', 48.8661, 2.7795, 10, 0, false, true, 1],
  ['daw-frozen-ever-after', 'Frozen Ever After', 'World of Frozen', 48.8642, 2.7752, 6, 0, false, true, 1],
  ['daw-tangled-spin', 'Rapunzel Tangled Spin', 'Adventure Way', 48.8662, 2.7782, 3, 0, false, false, 1],
];

const SHOWS: Array<[ParkId, ShowSeed]> = [
  ['dlp', ['dlp-show-castle-night', 'Spectacle nocturne du Château', 'Main Street U.S.A.', 48.8727, 2.7768, 20, 30, 45, 60]],
  ['dlp', ['dlp-show-parade', "Parade de l'après-midi", 'Main Street U.S.A.', 48.8716, 2.778, 25, 15, 30, 45]],
  ['daw', ['daw-show-mickey-magician', 'Mickey and the Magician', 'World Premiere', 48.8673, 2.7786, 30, 15, 25, 40]],
  ['daw', ['daw-show-together', 'TOGETHER: a Pixar Musical Adventure', 'World Premiere', 48.8676, 2.779, 25, 15, 25, 40]],
  ['daw', ['daw-show-arendelle', 'Célébration à Arendelle', 'World of Frozen', 48.8645, 2.7757, 15, 10, 15, 25]],
  ['daw', ['daw-show-frozen-invitation', 'Frozen: A Musical Invitation', 'World Premiere', 48.8672, 2.78, 30, 10, 20, 30]],
];

function ride(park: ParkId, s: RideSeed): Attraction {
  const [id, name, land, lat, lon, durationMin, minHeightCm, singleRider, premierAccess, intensity] = s;
  return { kind: 'ride', id, name, park, land, lat, lon, durationMin, minHeightCm, singleRider, premierAccess, intensity };
}

function show(park: ParkId, s: ShowSeed): Show {
  const [id, name, land, lat, lon, durationMin, low, mid, high] = s;
  const arriveBeforeMin: Record<CrowdLevel, number> = { low, mid, high };
  return { kind: 'show', id, name, park, land, lat, lon, durationMin, arriveBeforeMin };
}

export const SEED_PLACES: readonly Place[] = [
  ...DLP_RIDES.map((s) => ride('dlp', s)),
  ...DAW_RIDES.map((s) => ride('daw', s)),
  ...SHOWS.map(([park, s]) => show(park, s)),
];

export function seedCatalog(): Map<string, Place> {
  return new Map(SEED_PLACES.map((p) => [p.id, p]));
}

/** Lowercase, accent-free, punctuation-free key used to match API names to the seed. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[®™©]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|le|la|les|l|presented by avis|disney s)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
