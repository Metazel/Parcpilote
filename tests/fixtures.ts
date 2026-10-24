/**
 * Synthetic Overpass response: a regular footway grid over the resort (rows and columns),
 * one backstage private road, one detached fragment, and a few service points.
 */
export function overpassGrid(): { elements: unknown[] } {
  const elements: unknown[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  for (let la = 48.862; la <= 48.878; la += 0.0005) lats.push(Math.round(la * 1e6) / 1e6);
  for (let lo = 2.769; lo <= 2.785; lo += 0.0007) lons.push(Math.round(lo * 1e6) / 1e6);
  const id = (r: number, c: number) => 1_000_000 + r * 1000 + c;
  lats.forEach((la, r) => {
    elements.push({
      type: 'way',
      id: 10 + r,
      tags: { highway: 'footway', ...(r === 20 ? { name: 'Allée centrale' } : {}) },
      nodes: lons.map((_, c) => id(r, c)),
      geometry: lons.map((lo) => ({ lat: la, lon: lo })),
    });
  });
  lons.forEach((lo, c) => {
    elements.push({
      type: 'way',
      id: 500 + c,
      tags: { highway: c % 2 ? 'path' : 'pedestrian', ...(c === 10 ? { name: 'Promenade Est' } : {}) },
      nodes: lats.map((_, r) => id(r, c)),
      geometry: lats.map((la) => ({ lat: la, lon: lo })),
    });
  });
  // Backstage road (must be ignored) and a detached fragment (dropped by component filter).
  elements.push({ type: 'way', id: 9001, tags: { highway: 'service', access: 'private' }, nodes: [5, 6], geometry: [{ lat: 48.87, lon: 2.77 }, { lat: 48.871, lon: 2.771 }] });
  elements.push({ type: 'way', id: 9002, tags: { highway: 'footway' }, nodes: [7, 8], geometry: [{ lat: 48.8616, lon: 2.7681 }, { lat: 48.8617, lon: 2.7682 }] });
  // Service points: two named, one unnamed, one far outside (ignored by the POI filter), one invalid.
  elements.push({ type: 'node', id: 1, lat: 48.8735, lon: 2.776, tags: { amenity: 'toilets' } });
  elements.push({ type: 'node', id: 2, lat: 48.8668, lon: 2.778, tags: { amenity: 'toilets', name: 'Toilettes Worlds of Pixar' } });
  elements.push({ type: 'node', id: 3, lat: 48.8745, lon: 2.7755, tags: { amenity: 'fast_food', name: '<b>Pizzeria</b>' } });
  elements.push({ type: 'node', id: 4, lat: 48.8624, lon: 2.7838, tags: { amenity: 'restaurant', name: 'Hôtel lointain' } });
  elements.push({ type: 'node', id: 9, lat: 'x', lon: 2.77, tags: { amenity: 'cafe' } });
  elements.push({
    type: 'way',
    id: 9100,
    tags: { amenity: 'restaurant', building: 'yes', name: 'Bistrot' },
    nodes: [11, 12, 13, 11],
    geometry: [
      { lat: 48.8725, lon: 2.7745 },
      { lat: 48.8727, lon: 2.7745 },
      { lat: 48.8727, lon: 2.7748 },
      { lat: 48.8725, lon: 2.7745 },
    ],
  });
  return { elements };
}
