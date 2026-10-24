import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GeoPoint, Place, Poi, PoiKind, Position } from '../../domain/types';
import type { DrawnRoute } from '../../state/store';
import { MapView, type MapLine, type MapMarker, type MapStop } from '../components/MapView';
import { useAppState, useStore } from '../context';
import { PARK_SHORT, liveLabel, minutes, stepTitle, waitBand } from '../format';
import { ExternalLink } from '../components/ExternalLink';

type Layer = 'rides' | 'shows' | PoiKind;
type NearbyKind = 'ride' | PoiKind;

const LAYERS: ReadonlyArray<{ id: Layer; label: string }> = [
  { id: 'rides', label: 'Attractions' },
  { id: 'shows', label: 'Spectacles' },
  { id: 'food', label: 'Restauration' },
  { id: 'toilets', label: 'Toilettes' },
  { id: 'water', label: "Points d'eau" },
];

const NEARBY: ReadonlyArray<{ id: NearbyKind; label: string }> = [
  { id: 'toilets', label: 'Toilettes' },
  { id: 'food', label: 'Restauration' },
  { id: 'ride', label: 'Attractions' },
  { id: 'water', label: "Points d'eau" },
];

const POI_LABEL: Readonly<Record<PoiKind, string>> = { toilets: 'Toilettes', food: 'Restauration', water: "Point d'eau" };

function meters(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function describe(route: DrawnRoute, walkMin: number): string {
  const base = `${minutes(walkMin)}, ${route.onNetwork ? '' : 'environ '}${meters(route.meters)}`;
  if (!route.onNetwork) return `${base} (estimation à vol d'oiseau, allées non chargées)`;
  return route.via.length > 0 ? `${base}, par ${route.via.slice(0, 3).join(', ')}` : base;
}

interface Leg {
  readonly n: number;
  readonly targetId: string;
  readonly name: string;
  readonly to: Position;
  readonly walkMin: number;
  readonly route: DrawnRoute;
}

export function MapScreen({ report }: { report: (id: string) => void }) {
  const store = useStore();
  const state = useAppState();
  const { catalog, snapshot, plan, persisted, pois, graph, gps, gpsAccuracyM, osm } = state;
  const [layersOn, setLayersOn] = useState<ReadonlySet<Layer>>(new Set<Layer>(['rides', 'shows', 'food', 'toilets']));
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nearKind, setNearKind] = useState<NearbyKind>('toilets');
  const [fitKey, setFitKeyState] = useState('initial');
  const fitSeq = useRef(0);
  /** Each framing request gets a unique key, so repeating the same action re-frames. */
  const setFitKey = (kind: string) => setFitKeyState(`${kind}-${++fitSeq.current}`);
  const [locating, setLocating] = useState(false);
  const here = store.currentPosition();
  const wishes = new Map(persisted.wishes);

  const places = useMemo(() => [...catalog.values()], [catalog]);
  const poiById = useMemo(() => new Map(pois.map((p) => [p.id, p])), [pois]);
  const findPoint = (id: string): (Place | Poi) | undefined => catalog.get(id) ?? poiById.get(id);

  // Today's circuit: current position, then every step that moves the group.
  const legs: Leg[] = useMemo(() => {
    const out: Leg[] = [];
    let from: GeoPoint = here;
    for (const step of plan?.steps ?? []) {
      if (step.kind === 'lunch' || !step.targetId) continue;
      out.push({ n: out.length + 1, targetId: step.targetId, name: step.kind === 'easy-book' ? `Inscription Carte Facilité : ${step.name}` : stepTitle(step), to: step.position, walkMin: step.walkMin, route: store.route(from, step.position) });
      from = step.position;
    }
    return out;
    // here.key/lat/lon and graph identify the inputs; store.route reads the graph.
  }, [plan, graph, here.key, here.lat, here.lon, store]);

  const focus = focusId ? findPoint(focusId) : undefined;
  const focusRoute = useMemo(() => (focus ? store.route(here, focus) : null), [focus, graph, here.key, here.lat, here.lon, store]);
  const focusMin = focus ? store.walkMinutesTo(focus) : 0;

  const lines: MapLine[] = useMemo(() => {
    const out: MapLine[] = legs.map((l, i) => ({ points: l.route.points, className: `route ${i === 0 && !focusRoute ? 'route-next' : 'route-later'}${l.route.onNetwork ? '' : ' route-estimated'}` }));
    if (focusRoute) out.push({ points: focusRoute.points, className: `route route-focus${focusRoute.onNetwork ? '' : ' route-estimated'}` });
    return out;
  }, [legs, focusRoute]);

  const stops: MapStop[] = useMemo(() => legs.map((l) => ({ n: l.n, id: l.targetId, lat: l.to.lat, lon: l.to.lon })), [legs]);

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = [];
    for (const p of places) {
      if (p.kind === 'ride' && layersOn.has('rides')) {
        out.push({ id: p.id, lat: p.lat, lon: p.lon, radius: 7, className: `mk mk-ride mk-${waitBand(snapshot?.attractions[p.id])}${wishes.has(p.id) ? ' mk-wish' : ''}` });
      } else if (p.kind === 'show' && layersOn.has('shows')) {
        out.push({ id: p.id, lat: p.lat, lon: p.lon, radius: 6, className: 'mk mk-show' });
      }
    }
    for (const poi of pois) if (layersOn.has(poi.kind)) out.push({ id: poi.id, lat: poi.lat, lon: poi.lon, radius: 5, className: `mk mk-${poi.kind}` });
    return out;
  }, [places, pois, layersOn, snapshot, persisted.wishes]);

  const fallbackNetwork = useCallback(() => graph?.segments() ?? [], [graph]);

  const fit: GeoPoint[] = fitKey.startsWith('focus') && focusRoute
    ? [...focusRoute.points]
    : fitKey.startsWith('leg-')
      ? [...(legs[Number(fitKey.split('-')[1])]?.route.points ?? [])]
      : fitKey.startsWith('circuit')
        ? [here, ...legs.flatMap((l) => l.route.points)]
        : fitKey.startsWith('me')
          ? [here]
          : places;

  const nearby = useMemo(() => {
    const candidates: Array<{ id: string; name: string; to: Position; extra: string | null }> =
      nearKind === 'ride'
        ? places.filter((p) => p.kind === 'ride').map((p) => ({ id: p.id, name: p.name, to: p, extra: liveLabel(snapshot?.attractions[p.id]) }))
        : pois.filter((p) => p.kind === nearKind).map((p) => ({ id: p.id, name: p.name, to: p, extra: p.source === 'official' ? 'Officiel' : null }));
    return candidates
      .map((c) => ({ ...c, min: store.walkMinutesTo(c.to) }))
      .sort((a, b) => a.min - b.min)
      .slice(0, 5);
  }, [nearKind, places, pois, snapshot, here.key, here.lat, here.lon, graph, store]);

  const sel = selected ? findPoint(selected) : undefined;
  const showRoute = (id: string) => {
    setFocusId(id);
    setSelected(id);
    setFitKey(`focus-${id}`);
  };

  const locate = () => {
    if (!persisted.settings.useGps) store.setUseGps(true);
    if (gps) setFitKey('me');
    else setLocating(true);
  };

  // Frame the user once the first position arrives after "Me localiser".
  useEffect(() => {
    if (locating && gps) {
      setLocating(false);
      setFitKey('me');
    }
  }, [locating, gps]);

  return (
    <div>
      <h1>Carte</h1>
      <div class="row map-tools">
        <button class="btn btn-small" type="button" onClick={locate}>
          {gps ? 'Recentrer sur moi' : locating ? 'Localisation…' : 'Me localiser'}
        </button>
        <button class="btn btn-small" type="button" disabled={legs.length === 0} onClick={() => setFitKey('circuit')}>
          Voir le circuit
        </button>
        {focusRoute && (
          <button class="btn btn-quiet btn-small" type="button" onClick={() => setFocusId(null)}>
            Effacer l'itinéraire
          </button>
        )}
      </div>

      <MapView
        markers={markers}
        lines={lines}
        stops={stops}
        me={{ lat: here.lat, lon: here.lon, accuracyM: gpsAccuracyM, live: gps !== null }}
        selectedId={selected}
        onSelect={(id) => setSelected(id)}
        fallbackNetwork={graph ? fallbackNetwork : null}
        fit={fit}
        fitKey={fitKey}
      />

      <fieldset class="layers">
        <legend class="visually-hidden">Afficher sur la carte</legend>
        {LAYERS.map((l) => (
          <label key={l.id} class={`toggle layer-${l.id}`}>
            <input
              type="checkbox"
              checked={layersOn.has(l.id)}
              onChange={(e) => {
                const next = new Set(layersOn);
                if ((e.target as HTMLInputElement).checked) next.add(l.id);
                else next.delete(l.id);
                setLayersOn(next);
              }}
            />
            <span class="swatch" aria-hidden="true" />
            <span>{l.label}</span>
          </label>
        ))}
      </fieldset>
      <p class="hint">
        {gps ? `Position du téléphone${gpsAccuracyM ? `, précision ${gpsAccuracyM} m` : ''}.` : 'Position estimée : dernière étape terminée ou entrée du parc.'}{' '}
        {osm.status === 'ok' ? 'Trajets calculés sur les allées OpenStreetMap.' : osm.status === 'loading' ? 'Chargement des allées…' : 'Allées non disponibles : trajets estimés à vol d’oiseau.'}
      </p>

      {sel && (
        <section class="panel" aria-live="polite" aria-labelledby="sel-title">
          <h2 id="sel-title">{sel.name}</h2>
          <p class="muted">
            {'kind' in sel && (sel.kind === 'ride' || sel.kind === 'show')
              ? `${sel.land}, ${PARK_SHORT[sel.park]}${sel.kind === 'ride' ? ` : ${liveLabel(snapshot?.attractions[sel.id])}` : ''}`
              : `${POI_LABEL[(sel as Poi).kind]}, ${PARK_SHORT[(sel as Poi).park]}${(sel as Poi).source === 'official' ? ', liste officielle' : ', OpenStreetMap'}`}
          </p>
          {focusId === sel.id && focusRoute && <p>À pied depuis votre position : {describe(focusRoute, focusMin)}.</p>}
          <div class="row">
            <button class="btn btn-small" type="button" onClick={() => showRoute(sel.id)}>
              Itinéraire depuis ma position
            </button>
            {'kind' in sel && sel.kind === 'ride' && (
              <button class="btn btn-quiet btn-small" type="button" onClick={() => store.setWish(sel.id, wishes.has(sel.id) ? null : 'nice')}>
                {wishes.has(sel.id) ? 'Retirer de ma liste' : 'Ajouter à ma liste'}
              </button>
            )}
            {'kind' in sel && (sel.kind === 'ride' || sel.kind === 'show') && (
              <button class="btn btn-quiet btn-small" type="button" onClick={() => report(sel.id)}>
                Signaler
              </button>
            )}
          </div>
        </section>
      )}

      <h2>À proximité</h2>
      <div class="segmented" role="radiogroup" aria-label="Type de lieu à proximité">
        {NEARBY.map((k) => (
          <label key={k.id}>
            <input type="radio" name="nearby" checked={nearKind === k.id} onChange={() => setNearKind(k.id)} />
            <span>{k.label}</span>
          </label>
        ))}
      </div>
      {nearby.length === 0 ? (
        <p class="muted nearby-empty">
          {nearKind === 'ride' ? 'Aucune attraction.' : 'Aucun lieu de ce type : les données OpenStreetMap ne sont pas chargées (réseau requis une première fois).'}
        </p>
      ) : (
        <ul class="waits nearby">
          {nearby.map((n) => (
            <li key={n.id}>
              <span>
                <span class="nearby-name">{n.name}</span>
                <span class="muted num"> {minutes(n.min)} à pied{n.extra ? `, ${n.extra}` : ''}</span>
              </span>
              <button class="btn btn-small" type="button" onClick={() => showRoute(n.id)} aria-label={`Itinéraire vers ${n.name}`}>
                Itinéraire
              </button>
            </li>
          ))}
        </ul>
      )}

      {legs.length > 0 && (
        <>
          <h2>Circuit du jour</h2>
          <ol class="legs">
            {legs.map((l, i) => (
              <li key={`${l.targetId}-${l.n}`}>
                <span class="leg-n" aria-hidden="true">
                  {l.n}
                </span>
                <span class="leg-text">
                  <strong>{l.name}</strong>
                  <span class="muted"> {describe(l.route, l.walkMin)}</span>
                </span>
                <button class="btn btn-quiet btn-small" type="button" onClick={() => setFitKey(`leg-${i}`)} aria-label={`Voir le trajet vers ${l.name} sur la carte`}>
                  Voir
                </button>
              </li>
            ))}
          </ol>
        </>
      )}

      <h2>Attentes en ce moment</h2>
      <ul class="waits">
        {places
          .filter((p) => p.kind === 'ride')
          .map((p) => ({ p, live: snapshot?.attractions[p.id] }))
          .sort((a, b) => (a.live?.standby ?? 999) - (b.live?.standby ?? 999))
          .map(({ p, live }) => (
            <li key={p.id}>
              <button type="button" class="link-like" onClick={() => setSelected(p.id)}>
                {p.name}
              </button>
              <span class={`num wait-${waitBand(live)}`}>{liveLabel(live)}</span>
            </li>
          ))}
      </ul>
      <p class="footer-note">
        Fond de carte, allées, toilettes et points de restauration : © contributeurs <ExternalLink href="https://www.openstreetmap.org/copyright">OpenStreetMap</ExternalLink> (ODbL). Le serveur de tuiles voit la zone de carte affichée, jamais votre position.
      </p>
    </div>
  );
}
