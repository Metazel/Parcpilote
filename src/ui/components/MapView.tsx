import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GeoPoint } from '../../domain/types';

/**
 * Interactive base map (Leaflet + OpenStreetMap tiles). Everything drawn is styled through CSS
 * classes (theme tokens) and never through HTML strings built from data.
 */

export interface MapMarker extends GeoPoint {
  readonly id: string;
  /** CSS classes, e.g. "mk mk-ride mk-ok". */
  readonly className: string;
  readonly radius: number;
}

export interface MapLine {
  readonly points: readonly GeoPoint[];
  readonly className: string;
}

export interface MapStop extends GeoPoint {
  readonly n: number;
  readonly id: string;
}

interface Props {
  readonly markers: readonly MapMarker[];
  readonly lines: readonly MapLine[];
  readonly stops: readonly MapStop[];
  readonly me: (GeoPoint & { readonly accuracyM: number | null; readonly live: boolean }) | null;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** Footway segments drawn underneath when tiles cannot load (offline, blocked). */
  readonly fallbackNetwork: (() => ReadonlyArray<readonly [GeoPoint, GeoPoint]>) | null;
  /** Points to frame; changes of `fitKey` re-frame the view. */
  readonly fit: readonly GeoPoint[];
  readonly fitKey: string;
}

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ll = (p: GeoPoint): L.LatLngTuple => [p.lat, p.lon];

export function MapView({ markers, lines, stops, me, selectedId, onSelect, fallbackNetwork, fit, fitKey }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<Record<'network' | 'lines' | 'markers' | 'stops' | 'me', L.LayerGroup> | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [tilesFailed, setTilesFailed] = useState(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const m = L.map(el.current, {
      zoomControl: true,
      attributionControl: true,
      minZoom: 14,
      maxZoom: 19,
      zoomSnap: 0.5,
      fadeAnimation: false,
      zoomAnimation: !reduceMotion,
      markerZoomAnimation: !reduceMotion,
    });
    m.attributionControl.setPrefix(false);
    let loaded = 0;
    let failed = 0;
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap<span class="visually-hidden"> (nouvelle fenêtre)</span></a>',
      referrerPolicy: 'strict-origin-when-cross-origin',
    })
      .on('tileload', () => {
        loaded++;
        setTilesFailed(false);
      })
      .on('tileerror', () => {
        failed++;
        if (failed >= 3 && loaded === 0) setTilesFailed(true);
      })
      .addTo(m);
    layers.current = {
      network: L.layerGroup().addTo(m),
      lines: L.layerGroup().addTo(m),
      markers: L.layerGroup().addTo(m),
      stops: L.layerGroup().addTo(m),
      me: L.layerGroup().addTo(m),
    };
    m.setView([48.8705, 2.777], 16);
    // Exposed for tests and assistive tooling: current zoom and centre.
    const expose = () => {
      const c = m.getCenter();
      el.current?.setAttribute('data-view', `${m.getZoom()}|${c.lat.toFixed(5)}|${c.lng.toFixed(5)}`);
    };
    m.on('moveend zoomend', expose);
    expose();
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layers.current = null;
    };
  }, []);

  useEffect(() => {
    const g = layers.current?.network;
    if (!g) return;
    g.clearLayers();
    if (!tilesFailed || !fallbackNetwork) return;
    for (const [a, b] of fallbackNetwork()) L.polyline([ll(a), ll(b)], { className: 'map-footway', interactive: false }).addTo(g);
  }, [tilesFailed, fallbackNetwork]);

  useEffect(() => {
    const g = layers.current?.lines;
    if (!g) return;
    g.clearLayers();
    for (const line of lines) {
      if (line.points.length < 2) continue;
      L.polyline(line.points.map(ll), { className: line.className, interactive: false }).addTo(g);
    }
  }, [lines]);

  useEffect(() => {
    const g = layers.current?.markers;
    if (!g) return;
    g.clearLayers();
    for (const mk of markers) {
      const selected = mk.id === selectedId;
      L.circleMarker(ll(mk), { radius: selected ? mk.radius + 3 : mk.radius, className: `${mk.className}${selected ? ' mk-selected' : ''}`, bubblingMouseEvents: false })
        .on('click', () => select.current(mk.id))
        .addTo(g);
    }
  }, [markers, selectedId]);

  useEffect(() => {
    const g = layers.current?.stops;
    if (!g) return;
    g.clearLayers();
    for (const stop of stops) {
      const badge = document.createElement('span');
      badge.textContent = String(stop.n);
      L.marker(ll(stop), { icon: L.divIcon({ html: badge, className: 'stop-badge', iconSize: [26, 26] }), keyboard: false, zIndexOffset: 500 })
        .on('click', () => select.current(stop.id))
        .addTo(g);
    }
  }, [stops]);

  useEffect(() => {
    const g = layers.current?.me;
    if (!g) return;
    g.clearLayers();
    if (!me) return;
    if (me.live && me.accuracyM) L.circle(ll(me), { radius: me.accuracyM, className: 'me-accuracy', interactive: false }).addTo(g);
    L.circleMarker(ll(me), { radius: 8, className: me.live ? 'me-dot' : 'me-dot me-estimated', interactive: false }).addTo(g);
  }, [me]);

  useEffect(() => {
    const m = map.current;
    if (!m || fit.length === 0) return;
    // Programmatic framing is instant: predictable, and kind to reduced-motion users.
    if (fit.length === 1) m.setView(ll(fit[0]!), Math.max(m.getZoom(), 17), { animate: false });
    else m.fitBounds(L.latLngBounds(fit.map(ll)), { padding: [28, 28], maxZoom: 18, animate: false });
    // fitKey drives re-framing; the points themselves change on every tick.
  }, [fitKey]);

  return (
    <div class="map-wrap">
      <div ref={el} class="map-canvas" role="region" aria-label="Carte interactive des parcs (les mêmes informations sont listées sous la carte)" />
      {tilesFailed && <p class="map-note">Fond de carte indisponible (hors-ligne ou bloqué) : allées, positions et trajets restent affichés.</p>}
    </div>
  );
}
