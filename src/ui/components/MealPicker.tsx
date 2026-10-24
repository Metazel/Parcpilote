import { useState } from 'preact/hooks';
import { haversineM } from '../../domain/geo';
import { mealCandidates } from '../../domain/planner';
import { formatHM, parkWallTime } from '../../domain/time';
import type { MealSlot } from '../../domain/types';
import { useAppState, useStore } from '../context';
import { MEAL_MODE_LABEL, MEAL_SLOT_LABEL, parkShort } from '../format';
import { ExternalLink } from './ExternalLink';

const AUTO = '';

/** Choice of place (and table reservation) for one meal of the day. */
export function MealPicker({ slot }: { slot: MealSlot }) {
  const store = useStore();
  const { persisted, pois, now, resort } = useAppState();
  const dining = resort.def.dining;
  const pref = persisted.profile?.[slot];
  const pick = persisted.day.meals[slot] ?? { placeId: null, reservationAt: null };
  const [time, setTime] = useState('');
  const [message, setMessage] = useState('');
  if (!pref?.enabled || pref.mode === 'free') return null;

  const here = store.currentPosition();
  const places = mealCandidates(pois, pref.mode).sort((a, b) => haversineM(here, a) - haversineM(here, b));
  const chosen = places.find((p) => p.id === pick.placeId) ?? null;
  const id = `meal-${slot}`;
  const done = slot === 'lunch' ? persisted.day.lunchDone : persisted.day.dinnerDone;

  const saveReservation = (e: Event) => {
    e.preventDefault();
    const m = /^(\d{2}):(\d{2})$/.exec(time || (pick.reservationAt ? formatHM(pick.reservationAt) : ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      setMessage('Indiquez l’heure de la réservation.');
      return;
    }
    const at = parkWallTime(now, Number(m[1]) * 60 + Number(m[2]));
    setMessage(store.setMealPick(slot, pick.placeId, at) ? `Réservation à ${formatHM(at)} enregistrée : le plan s’y cale.` : 'Heure de réservation invalide.');
  };

  return (
    <fieldset class="item meal-item">
      <legend>
        {MEAL_SLOT_LABEL[slot]} vers {formatHM(parkWallTime(now, pref.atMin))}, {MEAL_MODE_LABEL[pref.mode].toLowerCase()}
      </legend>
      {done ? (
        <p class="hint">Fait aujourd'hui.</p>
      ) : places.length === 0 ? (
        <p class="hint">Aucun lieu de ce type connu pour le moment (allées et restaurants en cours de chargement, ou indisponibles hors-ligne) : le plan prévoit une pause sur place.</p>
      ) : (
        <>
          <div class="field">
            <label for={id}>{slot === 'lunch' ? 'Où déjeuner' : 'Où dîner'}</label>
            <select
              id={id}
              value={pick.placeId ?? AUTO}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                store.setMealPick(slot, v === AUTO ? null : v, pick.reservationAt);
              }}
            >
              <option value={AUTO}>Le plus pratique sur le parcours</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {[resort.parks.length > 1 ? parkShort(resort.parks, p.park) : '', p.outside ? 'hors du parc' : ''].filter(Boolean).join(', ').replace(/^(.+)$/, ' ($1)')}
                </option>
              ))}
            </select>
          </div>
          {pref.mode === 'table' && (
            <form class="row reservation" onSubmit={saveReservation} noValidate>
              <div class="field">
                <label for={`${id}-resa`}>Réservation du {MEAL_SLOT_LABEL[slot].toLowerCase()}</label>
                <input id={`${id}-resa`} type="time" value={time || (pick.reservationAt ? formatHM(pick.reservationAt) : '')} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
              </div>
              <button class="btn btn-small" type="submit">
                Enregistrer
              </button>
              {pick.reservationAt !== null && (
                <button
                  class="btn btn-quiet btn-small"
                  type="button"
                  onClick={() => {
                    store.setMealPick(slot, pick.placeId, null);
                    setTime('');
                    setMessage('Réservation retirée.');
                  }}
                >
                  Retirer
                </button>
              )}
            </form>
          )}
          <p role="status" class="hint">
            {message}
          </p>
          {pref.mode === 'picnic' ? (
            <p class="hint">{dining.picnicNote}</p>
          ) : (
            <p class="hint">
              <ExternalLink href={chosen?.url ?? dining.restaurantsUrl}>{chosen?.url ? `Menu de ${chosen.name}` : 'Restaurants et menus sur le site officiel'}</ExternalLink>
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
