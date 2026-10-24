import { useMemo, useState } from 'preact/hooks';
import { normalizeName } from '../../data/catalog';
import { heightAllowed } from '../../domain/planner';
import { MINUTE, formatHM } from '../../domain/time';
import type { Attraction, ParkId, Priority, Show } from '../../domain/types';
import { useAppState, useStore } from '../context';
import { PARK_SHORT, liveLabel, waitBand } from '../format';

type ParkFilter = 'all' | ParkId;

const PRIORITY_OPTIONS: ReadonlyArray<{ value: Priority | 'none'; label: string }> = [
  { value: 'none', label: 'Non' },
  { value: 'nice', label: 'Si possible' },
  { value: 'must', label: 'Incontournable' },
];

function RideItem({ ride }: { ride: Attraction }) {
  const store = useStore();
  const { persisted, snapshot } = useAppState();
  const profile = persisted.profile;
  const current = persisted.wishes.find(([id]) => id === ride.id)?.[1] ?? 'none';
  const live = snapshot?.attractions[ride.id];
  const allowed = !profile || heightAllowed(ride, profile);
  const band = waitBand(live);
  const name = `prio-${ride.id}`;

  return (
    <fieldset class="item">
      <legend>{ride.name}</legend>
      <div class="item-meta">
        <span class={`wait-${band}`}>{liveLabel(live)}</span>
        {ride.minHeightCm > 0 && <span class="tag">{ride.minHeightCm} cm min.</span>}
        {ride.singleRider && <span class="tag">Single Rider</span>}
        {ride.premierAccess && <span class="tag">Premier Access</span>}
      </div>
      {allowed ? (
        <div class="segmented" role="radiogroup" aria-label={`Priorité pour ${ride.name}`}>
          {PRIORITY_OPTIONS.map((o) => (
            <label key={o.value}>
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={current === o.value}
                onChange={() => store.setWish(ride.id, o.value === 'none' ? null : o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      ) : (
        <p class="hint">Réservée aux personnes d'au moins {ride.minHeightCm} cm : retirée selon le profil du groupe.</p>
      )}
    </fieldset>
  );
}

function ShowItem({ show }: { show: Show }) {
  const store = useStore();
  const { persisted, snapshot, now } = useAppState();
  const sessions = snapshot?.showtimes[show.id] ?? [];
  const picked = persisted.day.shows.find((s) => s.showId === show.id)?.start ?? null;
  const name = `show-${show.id}`;

  return (
    <fieldset class="item">
      <legend>{show.name}</legend>
      <div class="item-meta">
        <span>{show.durationMin} min</span>
        <span>Arriver {show.arriveBeforeMin.low} à {show.arriveBeforeMin.high} min avant selon l'affluence</span>
      </div>
      {sessions.length === 0 ? (
        <p class="hint">Pas de séance annoncée aujourd'hui.</p>
      ) : (
        <div class="segmented" role="radiogroup" aria-label={`Séance de ${show.name}`}>
          <label>
            <input type="radio" name={name} checked={picked === null} onChange={() => store.pickShow(show.id, null)} />
            <span>Aucune</span>
          </label>
          {sessions.map((t) => (
            <label key={t}>
              <input
                type="radio"
                name={name}
                checked={picked === t}
                disabled={t - show.arriveBeforeMin.low * MINUTE < now}
                onChange={() => store.pickShow(show.id, t)}
              />
              <span class="num">{formatHM(t)}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function ListScreen() {
  const { catalog, persisted } = useAppState();
  const [park, setPark] = useState<ParkFilter>('all');
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = normalizeName(query);
    const byLand = new Map<string, { park: ParkId; rides: Attraction[]; shows: Show[] }>();
    for (const p of catalog.values()) {
      if (park !== 'all' && p.park !== park) continue;
      if (q && !normalizeName(p.name).includes(q)) continue;
      const key = `${p.park}|${p.land}`;
      let g = byLand.get(key);
      if (!g) byLand.set(key, (g = { park: p.park, rides: [], shows: [] }));
      if (p.kind === 'ride') g.rides.push(p);
      else g.shows.push(p);
    }
    return [...byLand.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr'));
  }, [catalog, park, query]);

  const mustCount = persisted.wishes.filter(([, p]) => p === 'must').length;

  return (
    <div>
      <h1>Ma liste</h1>
      <p class="muted">
        {persisted.wishes.length === 0
          ? 'Marquez ce que vous voulez faire. Les incontournables passent en priorité.'
          : `${persisted.wishes.length} attractions choisies, dont ${mustCount} incontournables.`}
      </p>
      <div class="filters">
        <div class="segmented" role="radiogroup" aria-label="Parc">
          {(['all', 'dlp', 'daw'] as const).map((p) => (
            <label key={p}>
              <input type="radio" name="park-filter" checked={park === p} onChange={() => setPark(p)} />
              <span>{p === 'all' ? 'Les deux parcs' : PARK_SHORT[p]}</span>
            </label>
          ))}
        </div>
        <label class="visually-hidden" for="search">
          Rechercher une attraction
        </label>
        <input id="search" type="search" placeholder="Rechercher une attraction ou un spectacle" maxLength={60} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>

      {groups.length === 0 && <p class="muted">Aucun résultat pour cette recherche.</p>}
      {groups.map(([key, g]) => (
        <section key={key} aria-label={key.split('|')[1]}>
          <h2 class={`land ${g.park}`}>
            {key.split('|')[1]} <span class="muted">({PARK_SHORT[g.park]})</span>
          </h2>
          {g.rides.map((r) => (
            <RideItem key={r.id} ride={r} />
          ))}
          {g.shows.map((s) => (
            <ShowItem key={s.id} show={s} />
          ))}
        </section>
      ))}
    </div>
  );
}
