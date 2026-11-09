import type { GeoPoint, ParkId } from '../domain/types';
import { DLP_DINING, type ResortDining } from './resort';

/**
 * Parks the app knows. Live data comes from ThemeParks.wiki when the destination is listed
 * there (matched by slug or name); otherwise the park runs in manual mode (estimated waits,
 * show times entered by the visitor). Park structure (sub-parks, positions) is read from the
 * live data at run time; only Disneyland Paris has a curated referential.
 */

export type DestinationId =
  | 'dlp'
  | 'asterix'
  | 'europapark'
  | 'puydufou'
  | 'futuroscope'
  | 'nigloland'
  | 'spirou'
  | 'walibi-ra'
  | 'walibi-be'
  | 'walibi-nl'
  | 'gardaland'
  | 'mirabilandia'
  | 'portaventura';

export interface ParkDef {
  readonly id: ParkId;
  readonly name: string;
  readonly short: string;
  readonly entrance: GeoPoint;
  /** Matches the live park name (normalised). */
  readonly match: RegExp;
  /** Usual opening hours (minutes after midnight) when the day's schedule is unknown. */
  readonly hours: readonly [number, number];
}

export interface DestinationDef {
  readonly id: DestinationId;
  readonly name: string;
  readonly place: string;
  readonly country: 'France' | 'Allemagne' | 'Belgique' | 'Pays-Bas' | 'Italie' | 'Espagne';
  /** ThemeParks.wiki destination (slug or name fragments, normalised), or null: manual mode. */
  readonly live: readonly string[] | null;
  /** Known parks (Disneyland Paris, manual parks); others are discovered from live data. */
  readonly parks: readonly ParkDef[];
  /** Map centre before live data arrives, and fallback entrance when the feed gives no position. */
  readonly center: GeoPoint | null;
  /**
   * Live destinations that bundle other parks (water park, Halloween event, extra-ticket park):
   * only API parks whose normalised name matches are kept. Null keeps them all.
   */
  readonly onlyParks: RegExp | null;
  /** OpenStreetMap area around the centre (metres). */
  readonly radiusM: number;
  readonly hours: readonly [number, number];
  readonly dining: ResortDining;
  readonly features: {
    /** Extra Magic Hours ("Heures de Magie en Plus"). */
    readonly emh: boolean;
    /** Carte Facilité registration model. */
    readonly easyAccess: boolean;
    /** Simulated demo day (needs a curated referential). */
    readonly demo: boolean;
  };
  /** Manual mode: what most places of the park are. */
  readonly mainlyShows: boolean;
  readonly site: string;
  /** Official page with the day's programme or opening calendar, when there is one. */
  readonly programmeUrl: string | null;
}

const H = (h: number, m = 0) => h * 60 + m;

function dining(site: string): ResortDining {
  return {
    picnic: 'auto',
    reentryMin: 15,
    picnicNote: 'Aires de pique-nique issues d’OpenStreetMap ; vérifiez le règlement du parc avant d’apporter votre repas.',
    picnicFallback: null,
    tableService: [],
    restaurantsUrl: site,
  };
}

function park(id: string, name: string, lat: number, lon: number, hours: readonly [number, number]): ParkDef {
  return { id, name, short: name, entrance: { lat, lon }, match: /.*/, hours };
}

function liveDest(
  id: DestinationId,
  name: string,
  place: string,
  country: DestinationDef['country'],
  live: readonly string[],
  site: string,
  center: GeoPoint,
  opts: { hours?: readonly [number, number]; radiusM?: number; onlyParks?: RegExp } = {},
): DestinationDef {
  const { hours = [H(10), H(18)], radiusM = 1300, onlyParks = null } = opts;
  return { id, name, place, country, live, parks: [], center, onlyParks, radiusM, hours, dining: dining(site), features: { emh: false, easyAccess: false, demo: false }, mainlyShows: false, site, programmeUrl: null };
}

export const DESTINATIONS: readonly DestinationDef[] = [
  {
    id: 'dlp',
    name: 'Disneyland Paris',
    place: 'Marne-la-Vallée',
    country: 'France',
    live: ['disneyland paris', 'disneylandparis'],
    parks: [
      { id: 'dlp', name: 'Disneyland Park', short: 'Disneyland Park', entrance: { lat: 48.8703, lon: 2.7797 }, match: /disneyland park|parc disneyland/, hours: [H(9, 30), H(22)] },
      { id: 'daw', name: 'Disney Adventure World', short: 'Adventure World', entrance: { lat: 48.8681, lon: 2.7797 }, match: /adventure world|studios/, hours: [H(9, 30), H(21)] },
    ],
    center: { lat: 48.87, lon: 2.777 },
    onlyParks: null,
    radiusM: 1000,
    hours: [H(9, 30), H(22)],
    dining: DLP_DINING,
    features: { emh: true, easyAccess: true, demo: true },
    mainlyShows: false,
    site: 'https://www.disneylandparis.com/fr-fr/',
    programmeUrl: null,
  },
  // Centres: median position of each park's attractions in the live feed (OpenStreetMap for
  // Nigloland, whose feed has no positions), measured on 09/11/2026.
  liveDest('asterix', 'Parc Astérix', 'Plailly', 'France', ['parc asterix', 'parcasterix'], 'https://www.parcasterix.fr/', { lat: 49.134, lon: 2.571 }),
  liveDest('europapark', 'Europa-Park', 'Rust', 'Allemagne', ['europa park', 'europapark'], 'https://www.europapark.de/', { lat: 48.2652, lon: 7.722 }, { hours: [H(9), H(18)], radiusM: 1600, onlyParks: /^europa park$/ }),
  liveDest('futuroscope', 'Futuroscope', 'Chasseneuil-du-Poitou', 'France', ['futuroscope'], 'https://www.futuroscope.com/', { lat: 46.668, lon: 0.3676 }),
  liveDest('nigloland', 'Nigloland', 'Dolancourt', 'France', ['nigloland'], 'https://www.nigloland.fr/', { lat: 48.2629, lon: 4.6145 }),
  liveDest('walibi-ra', 'Walibi Rhône-Alpes', 'Les Avenières', 'France', ['walibi rhone', 'walibirhonealpes'], 'https://www.walibi.fr/', { lat: 45.6216, lon: 5.57 }),
  liveDest('walibi-be', 'Walibi Belgium', 'Wavre', 'Belgique', ['walibi belgium', 'walibibelgium'], 'https://www.walibi.be/', { lat: 50.6988, lon: 4.5902 }),
  liveDest('walibi-nl', 'Walibi Holland', 'Biddinghuizen', 'Pays-Bas', ['walibi holland', 'walibiholland'], 'https://www.walibi.nl/', { lat: 52.4414, lon: 5.7642 }),
  liveDest('gardaland', 'Gardaland', 'Castelnuovo del Garda', 'Italie', ['gardaland'], 'https://www.gardaland.it/', { lat: 45.4566, lon: 10.7125 }),
  liveDest('mirabilandia', 'Mirabilandia', 'Ravenne', 'Italie', ['mirabilandia'], 'https://www.mirabilandia.it/', { lat: 44.3374, lon: 12.2635 }),
  liveDest('portaventura', 'PortAventura World', 'Salou', 'Espagne', ['portaventura'], 'https://www.portaventuraworld.com/', { lat: 41.0873, lon: 1.1586 }, { hours: [H(10), H(19)], radiusM: 1800, onlyParks: /^portaventura park$/ }),
  {
    id: 'puydufou',
    name: 'Puy du Fou',
    place: 'Les Epesses',
    country: 'France',
    live: null,
    parks: [park('puydufou', 'Puy du Fou', 46.8932, -0.9309, [H(9, 30), H(19)])],
    center: { lat: 46.8932, lon: -0.9309 },
    onlyParks: null,
    radiusM: 1400,
    hours: [H(9, 30), H(19)],
    dining: dining('https://www.puydufou.com/france/fr'),
    features: { emh: false, easyAccess: false, demo: false },
    mainlyShows: true,
    site: 'https://www.puydufou.com/france/fr',
    programmeUrl: 'https://www.puydufou.com/france/fr/program-day/download-today',
  },
  {
    id: 'spirou',
    name: 'Parc Spirou Provence',
    place: 'Monteux',
    country: 'France',
    live: null,
    parks: [park('spirou', 'Parc Spirou', 44.0206, 4.9702, [H(10), H(18)])],
    center: { lat: 44.0206, lon: 4.9702 },
    onlyParks: null,
    radiusM: 800,
    hours: [H(10), H(18)],
    dining: dining('https://www.parc-spirou.com/'),
    features: { emh: false, easyAccess: false, demo: false },
    mainlyShows: false,
    site: 'https://www.parc-spirou.com/',
    programmeUrl: 'https://www.parc-spirou.com/calendrier/',
  },
];

export const DEFAULT_DESTINATION: DestinationId = 'dlp';

export function destination(id: string): DestinationDef {
  return DESTINATIONS.find((d) => d.id === id) ?? DESTINATIONS[0]!;
}

export const DESTINATION_IDS = DESTINATIONS.map((d) => d.id);
