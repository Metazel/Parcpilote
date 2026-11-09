import { useEffect, useState } from 'preact/hooks';
import { formatHM } from '../../domain/time';
import type { ParkInfo, PlanStep } from '../../domain/types';
import type { Forecast, PrepDay } from '../../state/store';
import { useAppState, useStore } from '../context';
import type { Tab } from '../context';
import { MEAL_MODE_LABEL, QUEUE_LABEL, REASON_LABEL, STEP_LABEL, minutes, parkClass, stepTitle } from '../format';

const DAY = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const dayLabel = (dateKey: string) => DAY.format(new Date(`${dateKey}T12:00:00Z`));

/** Steps of a plan, in order (actions only for today's live plan). */
function RouteList({ steps, parks, interactive }: { steps: readonly PlanStep[]; parks: readonly ParkInfo[]; interactive: boolean }) {
  const store = useStore();
  return (
    <ol class="route" aria-label="Étapes dans l'ordre">
      {steps.map((s, i) => (
        <li key={`${s.kind}:${s.targetId}:${i}`} class={`stop ${s.kind} ${parkClass(parks, s.position.park)}${i === 0 ? ' stop-next' : ''}`}>
          <span class="stop-time">{formatHM(s.kind === 'ride' ? s.arriveAt : s.startAt)}</span>
          <span class="stop-rail" aria-hidden="true">
            <span class="stop-dot" />
          </span>
          <div class="stop-body">
            {s.walkMin > 0 && <p class="walk-leg">{minutes(s.walkMin)} de marche</p>}
            <p class="stop-name">
              {s.kind === 'easy-book' ? `Inscription Carte Facilité : ${s.name}` : stepTitle(s)}
              <span class="visually-hidden">, {STEP_LABEL[s.kind]}</span>
            </p>
            <p class="stop-meta">
              {s.kind === 'meal' && s.meal
                ? `${MEAL_MODE_LABEL[s.meal.mode]}${s.meal.reservationAt !== null ? `, réservation ${formatHM(s.meal.reservationAt)}` : `, de ${formatHM(s.startAt)}`} à ${formatHM(s.endAt)}${s.meal.reentryMin > 0 ? `, sortie et retour au contrôle compris` : ''}`
                : s.kind === 'easy-book'
                  ? `Retour prévu vers ${formatHM(s.returnAt ?? s.endAt)} ; en attendant, les étapes suivantes`
                  : s.kind === 'show'
                    ? `Arrivée ${formatHM(s.arriveAt)}, début ${formatHM(s.startAt)}`
                    : `Attente ${minutes(s.waitMin)}${s.queue && s.queue !== 'standby' ? ` en ${QUEUE_LABEL[s.queue]}` : ''}, embarquement ${formatHM(s.startAt)}, sortie ${formatHM(s.endAt)}`}
            </p>
            {s.others && (
              <p class="stop-meta">
                {s.others.rides
                  ? `Hors carte (${s.others.count}) : ${QUEUE_LABEL[s.others.queue]}, ${minutes(s.others.waitMin)}`
                  : `Hors carte (${s.others.count}) : attendent à la sortie`}
              </p>
            )}
            {interactive && s.kind === 'ride' && (
              <div class="row stop-actions">
                {i > 0 && (
                  <button class="btn btn-small" type="button" onClick={() => store.doNow(s.targetId)}>
                    Faire maintenant
                  </button>
                )}
                <button class="btn btn-quiet btn-small" type="button" onClick={() => store.skip(s.targetId)}>
                  Retirer
                </button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Today's plan, as it goes. */
function TodayPlan({ go }: { go: (tab: Tab) => void }) {
  const store = useStore();
  const { plan, planPending, catalog, persisted, now, snapshot, resort } = useAppState();

  if (!plan && planPending) {
    return (
      <div class="empty" role="status">
        <h2>Calcul de l'itinéraire…</h2>
      </div>
    );
  }

  if (!plan || (plan.steps.length === 0 && plan.unplanned.length === 0 && persisted.day.done.length === 0)) {
    return (
      <div class="empty">
        <h2>Pas encore de plan</h2>
        <p class="muted">Ajoutez des attractions ou un spectacle à votre liste pour obtenir un itinéraire.</p>
        <button class="btn btn-primary" type="button" onClick={() => go('list')}>
          Choisir les attractions
        </button>
      </div>
    );
  }

  const nameOf = (id: string) => catalog.get(id)?.name ?? id;
  const wishSet = new Set(persisted.wishes.map(([id]) => id));
  const doneCounts = new Map<string, number>();
  for (const id of persisted.day.done) doneCounts.set(id, (doneCounts.get(id) ?? 0) + 1);
  const doneIds = [...doneCounts.keys()];
  const skipped = persisted.day.skipped.filter((id) => !doneCounts.has(id));
  const later = Object.entries(persisted.day.later).filter(([, until]) => until > now);

  return (
    <div>
      <dl class="summary">
        <div>
          <dt>Fin prévue</dt>
          <dd class="num">{plan.steps.length > 0 ? formatHM(plan.steps.at(-1)!.endAt) : '—'}</dd>
        </div>
        <div>
          <dt>Attente</dt>
          <dd class="num">{minutes(plan.totals.waitMin)}</dd>
        </div>
        <div>
          <dt>Marche</dt>
          <dd class="num">{minutes(plan.totals.walkMin)}</dd>
        </div>
      </dl>

      {snapshot &&
        resort.def.features.emh &&
        snapshot.parks.map(({ id: park, name }) => {
          const h = snapshot.hours[park];
          if (!h?.emh || now >= h.emh.close) return null;
          return (
            <p key={park} class="emh">
              Heures de Magie en Plus à {name} de {formatHM(h.emh.open)} à {formatHM(h.emh.close)} (ouverture officielle {formatHM(h.open)}).{' '}
              {persisted.profile?.emhAccess ? 'Votre plan en profite.' : 'Réservées aux clients des hôtels Disney et pass éligibles : activez-les dans Groupe si c’est votre cas.'}
            </p>
          );
        })}

      <div class="plan-layout">
      <div class="plan-route">
      {plan.steps.length > 0 ? (
        <>
        <p class="hint">Heure d'arrivée à chaque attraction, heure de début pour les spectacles et la pause.</p>
        <RouteList steps={plan.steps} parks={resort.parks} interactive />
        </>
      ) : (
        <p class="muted">Aucune étape faisable pour le moment.</p>
      )}
      </div>
      <div class="plan-side">

      {plan.droppedAnchors.length > 0 && (
        <section class="panel">
          <h2>Horaires impossibles à tenir</h2>
          <ul class="reasons">
            {plan.droppedAnchors.map((d) => (
              <li key={d.id}>{d.name}</li>
            ))}
          </ul>
        </section>
      )}

      {plan.unplanned.length > 0 && (
        <>
          <h2>Hors du plan</h2>
          <ul class="reasons">
            {plan.unplanned.map((u) => (
              <li key={u.id}>
                <span>{nameOf(u.id)}</span>
                <span class="muted">{REASON_LABEL[u.reason]}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {later.length > 0 && (
        <>
          <h2>Pour plus tard</h2>
          <ul class="reasons">
            {later.map(([id, until]) => (
              <li key={id}>
                <span>
                  {nameOf(id)} <span class="muted">(revient vers {formatHM(until)})</span>
                </span>
                <button class="btn btn-quiet btn-small" type="button" onClick={() => store.restore(id)}>
                  Remettre maintenant
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {(doneIds.length > 0 || skipped.length > 0) && (
        <>
          <h2>Déjà fait ou retiré</h2>
          <ul class="reasons">
            {[...doneIds.map((id) => ({ id, done: true })), ...skipped.map((id) => ({ id, done: false }))].map(({ id, done }) => (
              <li key={id}>
                <span>
                  {nameOf(id)} <span class="muted">({done ? ((doneCounts.get(id) ?? 1) > 1 ? `fait ${doneCounts.get(id)} fois` : 'fait') : 'retiré'})</span>
                </span>
                {wishSet.has(id) && (
                  <button class="btn btn-quiet btn-small" type="button" onClick={() => store.restore(id)}>
                    Remettre dans le plan
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      </div>
      </div>
      <p class="hint footer-note">Calculé à {formatHM(plan.computedAt)}, recalculé à chaque mise à jour des attentes. Heure actuelle {formatHM(now)}.</p>
    </div>
  );
}

/** When to be at the gates and the first steps of the day. */
export function StartCard({ forecast, parks }: { forecast: Forecast; parks: readonly ParkInfo[] }) {
  const { persisted } = useAppState();
  const first = forecast.plan.steps.filter((s) => s.kind !== 'meal').slice(0, 3);
  const gatePark = parks.find((p) => p.id === persisted.profile?.startPark) ?? forecast.snapshot.parks[0];
  return (
    <section class="panel start-card" aria-labelledby="start-title">
      <h2 id="start-title">Par où commencer</h2>
      {forecast.arriveBy !== null && (
        <p>
          Soyez à l’entrée{gatePark && parks.length > 1 ? ` de ${gatePark.name}` : ''} vers <strong>{formatHM(forecast.arriveBy)}</strong> : contrôle de sécurité et billets passés, vous serez prêts à l’ouverture.
        </p>
      )}
      {first.length > 0 ? (
        <ol class="reasons">
          {first.map((s, i) => (
            <li key={`${s.targetId}:${i}`}>
              <span>
                {stepTitle(s)}
                {s.kind === 'ride' ? <span class="muted"> · attente estimée {minutes(s.waitMin)}</span> : null}
              </span>
              <span class="num muted">{formatHM(s.kind === 'ride' ? s.arriveAt : s.startAt)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">Ajoutez vos incontournables dans Ma liste pour savoir par où commencer.</p>
      )}
      {first[0]?.kind === 'ride' && <p class="hint">Les attentes sont au plus bas à l’ouverture : commencez par ce qui sera le plus demandé ensuite.</p>}
    </section>
  );
}

/** Plan of a day to come, from the opening, with typical waits. */
function ForecastView({ day, go }: { day: PrepDay; go: (tab: Tab) => void }) {
  const store = useStore();
  const { persisted, catalog, resort, pois } = useAppState();
  const [forecast, setForecast] = useState<Forecast | null | 'loading'>('loading');
  const [offline, setOffline] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setForecast('loading');
    void store.forecast(day.dateKey).then((f) => {
      if (current) setForecast(f);
    });
    return () => {
      current = false;
    };
  }, [store, day.dateKey, persisted.wishes, persisted.repeats, persisted.profile, catalog, resort.parks, pois]);

  const prepareOffline = async () => {
    setOffline('Téléchargement en cours…');
    const r = await store.prepareOffline();
    setOffline(
      r.paths && r.list
        ? 'Prêt pour le hors-ligne : liste du parc, allées et services sont sur ce téléphone. Le fond de carte, lui, demande le réseau.'
        : r.list
          ? 'Liste du parc prête. Les allées n’ont pas pu être téléchargées : les marches seront estimées à vol d’oiseau. Réessayez avec une meilleure connexion.'
          : 'Téléchargement impossible pour le moment : réessayez avec une connexion.',
    );
  };

  if (persisted.wishes.length === 0) {
    return (
      <div class="empty">
        <h2>Que voulez-vous faire ce jour-là ?</h2>
        <p class="muted">Choisissez vos incontournables : le plan de la journée se calcule tout seul.</p>
        <button class="btn btn-primary" type="button" onClick={() => go('list')}>
          Choisir les attractions
        </button>
      </div>
    );
  }
  if (forecast === 'loading') {
    return (
      <p class="hint" role="status">
        Calcul du plan prévisionnel…
      </p>
    );
  }
  if (!forecast) {
    return <p class="muted">Plan prévisionnel indisponible : la liste du parc n’est pas encore chargée. Ouvrez l’application une fois avec une connexion.</p>;
  }

  const { plan, snapshot } = forecast;
  const nameOf = (id: string) => catalog.get(id)?.name ?? id;
  const opens = Object.values(snapshot.hours);
  const wishedShows = persisted.wishes.some(([id]) => catalog.get(id)?.kind === 'show');
  return (
    <div>
      <p class="banner forecast-note">
        {opens.length > 0
          ? `Ouvert de ${formatHM(Math.min(...opens.map((h) => h.open)))} à ${formatHM(Math.max(...opens.map((h) => h.close)))}, ${forecast.published ? 'horaires officiels publiés' : 'horaires habituels, à vérifier sur le site officiel'}. `
          : 'Le parc n’ouvre pas ce jour-là. '}
        Attentes estimées d’après une journée type : le jour J, le plan suivra les attentes en direct.
      </p>
      <div class="plan-layout">
        <div class="plan-route">
          <StartCard forecast={forecast} parks={resort.parks} />
          {plan.steps.length > 0 && (
            <>
              <h2>Déroulé prévu</h2>
              <RouteList steps={plan.steps} parks={resort.parks} interactive={false} />
            </>
          )}
        </div>
        <div class="plan-side">
          <dl class="summary">
            <div>
              <dt>Incontournables</dt>
              <dd class="num">
                {plan.totals.mustPlanned}/{plan.totals.mustTotal}
              </dd>
            </div>
            <div>
              <dt>Fin prévue</dt>
              <dd class="num">{plan.steps.length > 0 ? formatHM(plan.steps.at(-1)!.endAt) : '—'}</dd>
            </div>
            <div>
              <dt>Attente estimée</dt>
              <dd class="num">{minutes(plan.totals.waitMin)}</dd>
            </div>
          </dl>
          {plan.unplanned.length > 0 && (
            <section class="panel">
              <h2>Ne tient pas dans la journée</h2>
              <ul class="reasons">
                {plan.unplanned.map((u) => (
                  <li key={u.id}>
                    <span>{nameOf(u.id)}</span>
                    <span class="muted">{REASON_LABEL[u.reason]}</span>
                  </li>
                ))}
              </ul>
              <p class="hint">Gardez en « Si possible » ce qui peut sauter, ou passez une attraction en « Incontournable » pour la garantir.</p>
            </section>
          )}
          {wishedShows && !resort.def.features.demo && <p class="hint">Spectacles : les séances ne sont connues que le jour même. Choisissez-les depuis Ma liste une fois sur place.</p>}
          <section class="panel" aria-labelledby="ready-title">
            <h2 id="ready-title">Avant de partir</h2>
            <div class="row">
              <button class="btn" type="button" onClick={() => go('list')}>
                Modifier ma liste
              </button>
              <button class="btn" type="button" onClick={() => go('profile')}>
                Groupe et repas
              </button>
              <button class="btn" type="button" onClick={() => void prepareOffline()}>
                Préparer le hors-ligne
              </button>
            </div>
            <p class="hint" role="status">
              {offline ?? ''}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

export function PlanScreen({ go }: { go: (tab: Tab) => void }) {
  const store = useStore();
  const { prepDate } = useAppState();
  const days = store.prepDays();
  const day = prepDate ? (days.find((d) => d.dateKey === prepDate) ?? { dateKey: prepDate, published: false }) : null;
  return (
    <div>
      <h1>{day ? `Plan prévisionnel : ${dayLabel(day.dateKey)}` : 'Plan du jour'}</h1>
      <div class="field day-picker">
        <label for="plan-day">Jour</label>
        <select id="plan-day" aria-describedby="plan-day-hint" value={prepDate ?? ''} onChange={(e) => store.setPrepDate((e.target as HTMLSelectElement).value || null)}>
          <option value="">Aujourd’hui, en direct</option>
          {[...days, ...(day && !days.some((d) => d.dateKey === day.dateKey) ? [day] : [])].map((d) => (
            <option key={d.dateKey} value={d.dateKey}>
              {dayLabel(d.dateKey)}
              {d.published ? '' : ' (horaires habituels)'}
            </option>
          ))}
        </select>
        <span class="hint" id="plan-day-hint">Préparez une visite à venir : le plan part de l’ouverture, sans toucher à la journée en cours.</span>
      </div>
      {day ? <ForecastView day={day} go={go} /> : <TodayPlan go={go} />}
    </div>
  );
}
