import { haversineM } from '../domain/geo';
import type { ParkId, Place, Poi, PoiKind } from '../domain/types';
import type { CompactOsm } from '../domain/walkGraph';
import { DLP_DINING, type ResortDining, officialService } from './resort';

/** POIs further than this from every attraction are outside the parks (hotels, village). */
const MAX_DISTANCE_FROM_PARK_M = 450;
/** Picnic areas may sit outside the gates (car park side): look further. */
const MAX_PICNIC_DISTANCE_M = 900;
/** An OpenStreetMap restaurant this close to an official one is the same place. */
const DUPLICATE_M = 35;

const DEFAULT_NAME: Readonly<Record<PoiKind, string>> = { toilets: 'Toilettes', food: 'Restauration', water: "Point d'eau", picnic: 'Aire de pique-nique' };

function nearestPark(p: { lat: number; lon: number }, places: readonly Place[]): { park: ParkId; meters: number } | null {
  let best: { park: ParkId; meters: number } | null = null;
  for (const place of places) {
    const d = haversineM(p, place);
    if (!best || d < best.meters) best = { park: place.park, meters: d };
  }
  return best;
}

/**
 * Official restaurants first (service type from the resort's table-service list), then
 * OpenStreetMap service points near the parks, deduplicated. Picnic areas follow the
 * resort's rule: outside the gates means a security check on the way back.
 */
export function buildPois(
  osm: CompactOsm | null,
  official: ReadonlyArray<{ park: ParkId; id: string; name: string; lat: number; lon: number }>,
  catalog: ReadonlyMap<string, Place>,
  dining: ResortDining = DLP_DINING,
): Poi[] {
  const places = [...catalog.values()];
  const out: Poi[] = official.map((r) => ({
    id: `api-${r.id}`,
    kind: 'food',
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    park: r.park,
    source: 'official',
    service: officialService(r.name, dining),
    url: null,
    outside: false,
  }));
  osm?.pois.forEach(([kind, name, lat, lon, service, url], i) => {
    const near = nearestPark({ lat, lon }, places);
    const limit = kind === 'picnic' ? MAX_PICNIC_DISTANCE_M : MAX_DISTANCE_FROM_PARK_M;
    if (!near || near.meters > limit) return;
    if (kind === 'food' && out.some((o) => o.source === 'official' && haversineM(o, { lat, lon }) < DUPLICATE_M)) return;
    out.push({
      id: `osm-${i}`,
      kind,
      name: name || DEFAULT_NAME[kind],
      lat,
      lon,
      park: near.park,
      source: 'osm',
      service: kind === 'food' ? service || 'quick' : null,
      url: url || null,
      outside: kind === 'picnic' && dining.picnic === 'outside',
    });
  });
  if (dining.picnicFallback && !out.some((p) => p.kind === 'picnic')) {
    const f = dining.picnicFallback;
    out.push({ id: 'resort-picnic', kind: 'picnic', name: f.name, lat: f.lat, lon: f.lon, park: f.park, source: 'resort', service: null, url: null, outside: dining.picnic === 'outside' });
  }
  return out;
}
