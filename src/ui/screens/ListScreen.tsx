import { useMemo, useState } from 'preact/hooks';
import { normalizeName } from '../../data/catalog';
import { MAX_REPEATS, heightAllowed } from '../../domain/planner';
import { MINUTE, formatHM, parkWallTime } from '../../domain/time';
import type { Attraction, ParkId, ParkInfo, Priority, Show } from '../../domain/types';
import { useAppState, useStore } from '../context';
import { MealPicker } from '../components/MealPicker';
import { liveLabel, parkClass, whereLabel, waitBand } from '../format';

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
  const times = persisted.repeats[ride.id] ?? 1;
  const doneTimes = persisted.day.done.filter((id) => id === ride.id).length;

  return (
    <fieldset class="item">
      <legend>{ride.name}</legend>
      <div class="item-meta">
        <span class={`wait-pill wait-${band}`}>{liveLabel(live)}</span>
        {ride.minHeightCm > 0 && <span class="tag">{ride.minHeightCm} cm min.</span>}
        {ride.singleRider && <span class="tag">Single Rider</span>}
        {ride.premierAccess && <span class="tag">Premier Access</span>}
        {doneTimes > 0 && <span class="tag">Faite{doneTimes > 1 ? ` ${doneTimes} fois` : ''}</span>}
      </div>
      <RemoveCustom id={ride.id} name={ride.name} />
      {allowed ? (
        <>
        <div class="segmented joined" role="radiogroup" aria-label={`Priorité pour ${ride.name}`}>
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
        {current !== 'none' && (
          <div class="field field-inline">
            <label for={`times-${ride.id}`}>Nombre de fois aujourd'hui</label>
            <select id={`times-${ride.id}`} value={String(times)} onChange={(e) => store.setRepeat(ride.id, Number((e.target as HTMLSelectElement).value))}>
              {Array.from({ length: MAX_REPEATS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {n === 1 ? '1 fois' : `${n} fois`}
                </option>
              ))}
            </select>
          </div>
        )}
        </>
      ) : (
        <p class="hint">Réservée aux personnes d'au moins {ride.minHeightCm} cm : retirée selon le profil du groupe.</p>
      )}
    </fieldset>
  );
}

/** Removes a place the visitor added themselves. */
function RemoveCustom({ id, name }: { id: string; name: string }) {
  const store = useStore();
  if (!id.startsWith('custom-')) return null;
  return (
    <button type="button" class="btn btn-quiet btn-small" onClick={() => store.removeCustomPlace(id)}>
      Retirer <span class="visually-hidden">{name}</span> de la liste
    </button>
  );
}

/** "14:30" → minutes after midnight, or null. */
function parseClock(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Manual mode: the visitor copies the sessions from the day's programme. */
function ManualSessions({ show }: { show: Show }) {
  const store = useStore();
  const { persisted, now } = useAppState();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = persisted.day.manualShowtimes[show.id] ?? [];
  const inputId = `session-${show.id}`;
  const errId = `${inputId}-err`;

  const add = (e: Event) => {
    e.preventDefault();
    const min = parseClock(value);
    if (min === null || !store.addManualShowtime(show.id, parkWallTime(now, min))) {
      setError('Heure non valide : saisissez une heure de séance d’aujourd’hui, par exemple 14:30.');
      return;
    }
    setError(null);
    setValue('');
  };

  return (
    <form class="manual-sessions" onSubmit={add} noValidate>
      <div class="field field-inline">
        <label for={inputId}>Séance du programme</label>
        <input
          id={inputId}
          type="time"
          value={value}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errId : undefined}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn btn-small">
          Ajouter la séance
        </button>
      </div>
      {error && (
        <p class="field-error" id={errId} role="alert">
          {error}
        </p>
      )}
      {list.length > 0 && (
        <ul class="chips" aria-label={`Séances saisies pour ${show.name}`}>
          {list.map((t) => (
            <li key={t}>
              <span class="num">{formatHM(t)}</span>
              <button type="button" class="chip-remove" onClick={() => store.removeManualShowtime(show.id, t)}>
                <span aria-hidden="true">×</span>
                <span class="visually-hidden">Retirer la séance de {formatHM(t)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function ShowItem({ show }: { show: Show }) {
  const store = useStore();
  const { persisted, snapshot, now, data } = useAppState();
  const sessions = snapshot?.showtimes[show.id] ?? [];
  const picked = persisted.day.shows.find((s) => s.showId === show.id)?.start ?? null;
  const name = `show-${show.id}`;
  const manual = data.mode === 'manual';

  return (
    <fieldset class="item">
      <legend>{show.name}</legend>
      <div class="item-meta">
        <span>{show.durationMin} min</span>
        <span>Arriver {show.arriveBeforeMin.low} à {show.arriveBeforeMin.high} min avant selon l'affluence</span>
      </div>
      <RemoveCustom id={show.id} name={show.name} />
      {sessions.length === 0 ? (
        <p class="hint">{manual ? 'Ajoutez les séances lues sur le programme du jour pour que le plan en tienne compte.' : 'Pas de séance annoncée aujourd\'hui.'}</p>
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
      {manual && <ManualSessions show={show} />}
    </fieldset>
  );
}

/** Adds a ride or show the feed does not list (always available, opened in manual mode). */
function AddPlace({ open }: { open: boolean }) {
  const store = useStore();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'ride' | 'show'>('show');
  const [duration, setDuration] = useState('30');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = (e: Event) => {
    e.preventDefault();
    const id = store.addCustomPlace(name, kind, Number(duration));
    if (!id) {
      setMessage({ ok: false, text: 'Indiquez un nom (2 à 80 caractères) et une durée entre 1 et 180 minutes.' });
      return;
    }
    setMessage({ ok: true, text: `« ${name.trim()} » ajouté à la liste.` });
    setName('');
  };

  return (
    <details class="add-place" open={open}>
      <summary>Ajouter une attraction ou un spectacle</summary>
      <form onSubmit={submit} noValidate>
        <div class="field">
          <label for="add-name">Nom</label>
          <input id="add-name" type="text" maxLength={80} autoComplete="off" value={name} aria-describedby={message ? 'add-msg' : undefined} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <fieldset class="field">
          <legend>Type</legend>
          <div class="segmented joined">
            {(['show', 'ride'] as const).map((k) => (
              <label key={k}>
                <input type="radio" name="add-kind" checked={kind === k} onChange={() => setKind(k)} />
                <span>{k === 'show' ? 'Spectacle' : 'Attraction'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div class="field">
          <label for="add-duration">Durée (minutes)</label>
          <input id="add-duration" type="number" inputMode="numeric" min={1} max={180} value={duration} onInput={(e) => setDuration((e.target as HTMLInputElement).value)} />
        </div>
        <button type="submit" class="btn btn-primary">
          Ajouter
        </button>
        <p id="add-msg" class={message?.ok === false ? 'field-error' : 'hint'} role="status">
          {message?.text ?? ''}
        </p>
      </form>
    </details>
  );
}

export function ListScreen() {
  const { catalog, persisted, resort, data } = useAppState();
  const parks = resort.parks;
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
          : `${persisted.wishes.length} ${persisted.wishes.length > 1 ? 'attractions choisies' : 'attraction choisie'}, dont ${mustCount} ${mustCount > 1 ? 'incontournables' : 'incontournable'}.`}
      </p>
      {(['lunch', 'dinner'] as const).some((m) => persisted.profile?.[m].enabled && persisted.profile[m].mode !== 'free') && (
        <section class="land-group meals" aria-labelledby="meals-title">
          <h2 class="land meal" id="meals-title">
            Repas
          </h2>
          <div class="items items-single">
            <MealPicker slot="lunch" />
            <MealPicker slot="dinner" />
          </div>
        </section>
      )}

      <div class="filters">
        {parks.length > 1 && (
          <div class="segmented joined" role="radiogroup" aria-label="Parc">
            {(['all', ...parks.map((p) => p.id)] as const).map((p) => (
              <label key={p}>
                <input type="radio" name="park-filter" checked={park === p} onChange={() => setPark(p)} />
                <span>{p === 'all' ? (parks.length === 2 ? 'Les deux parcs' : 'Tous les parcs') : (parks.find((x) => x.id === p)?.short ?? p)}</span>
              </label>
            ))}
          </div>
        )}
        <label class="visually-hidden" for="search">
          Rechercher une attraction
        </label>
        <input id="search" type="search" placeholder="Rechercher une attraction ou un spectacle" maxLength={60} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>

      {groups.length === 0 && <p class="muted">{catalog.size === 0 ? 'La liste du parc se charge ; si elle reste vide, ajoutez vous-même ce que vous voulez faire.' : 'Aucun résultat pour cette recherche.'}</p>}
      {groups.map(([key, g]) => (
        <section key={key} class="land-group" aria-labelledby={`land-${key.replace(/[^a-z0-9]/gi, '-')}`}>
          <h2 class={`land ${parkClass(parks, g.park)}`} id={`land-${key.replace(/[^a-z0-9]/gi, '-')}`}>
            {landTitle(key.split('|')[1] ?? '', parks, g.park)}
          </h2>
          <div class="items">
            {g.rides.map((r) => (
              <RideItem key={r.id} ride={r} />
            ))}
            {g.shows.map((s) => (
              <ShowItem key={s.id} show={s} />
            ))}
          </div>
        </section>
      ))}
      <AddPlace open={data.mode === 'manual' && catalog.size === 0} />
    </div>
  );
}

function landTitle(land: string, parks: readonly ParkInfo[], park: ParkId) {
  const label = whereLabel(land, parks, park);
  const extra = label.startsWith(`${land}, `) ? label.slice(land.length + 2) : null;
  return (
    <>
      {land || label}
      {extra && <span class="muted"> ({extra})</span>}
    </>
  );
}
