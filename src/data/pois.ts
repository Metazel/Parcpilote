import { haversineM } from '../domain/geo';
import type { ParkId, Place, Poi, PoiKind } from '../domain/types';
import type { CompactOsm } from '../domain/walkGraph';

/** POIs further than this from every attraction are outside the parks (hotels, village). */
const MAX_DISTANCE_FROM_PARK_M = 450;
/** An OpenStreetMap restaurant this close to an official one is the same place. */
const DUPLICATE_M = 35;

const DEFAULT_NAME: Readonly<Record<PoiKind, string>> = { toilets: 'Toilettes', food: 'Restauration', water: "Point d'eau" };

function nearestPark(p: { lat: number; lon: number }, places: readonly Place[]): { park: ParkId; meters: number } | null {
  let best: { park: ParkId; meters: number } | null = null;
  for (const place of places) {
    const d = haversineM(p, place);
    if (!best || d < best.meters) best = { park: place.park, meters: d };
  }
  return best;
}

/** Official restaurants first, then OpenStreetMap service points inside the parks, deduplicated. */
export function buildPois(
  osm: CompactOsm | null,
  official: ReadonlyArray<{ park: ParkId; id: string; name: string; lat: number; lon: number }>,
  catalog: ReadonlyMap<string, Place>,
): Poi[] {
  const places = [...catalog.values()];
  const out: Poi[] = official.map((r) => ({ id: `api-${r.id}`, kind: 'food', name: r.name, lat: r.lat, lon: r.lon, park: r.park, source: 'official' }));
  osm?.pois.forEach(([kind, name, lat, lon], i) => {
    const near = nearestPark({ lat, lon }, places);
    if (!near || near.meters > MAX_DISTANCE_FROM_PARK_M) return;
    if (kind === 'food' && out.some((o) => o.source === 'official' && haversineM(o, { lat, lon }) < DUPLICATE_M)) return;
    out.push({ id: `osm-${i}`, kind, name: name || DEFAULT_NAME[kind], lat, lon, park: near.park, source: 'osm' });
  });
  return out;
}
