import { formatHM } from '../../domain/time';
import { useAppState, useStore } from '../context';
import type { Tab } from '../context';
import { MEAL_MODE_LABEL, QUEUE_LABEL, REASON_LABEL, STEP_LABEL, minutes, parkClass, stepTitle } from '../format';

export function PlanScreen({ go }: { go: (tab: Tab) => void }) {
  const store = useStore();
  const { plan, planPending, catalog, persisted, now, snapshot, resort } = useAppState();

  if (!plan && planPending) {
    return (
      <div class="empty" role="status">
        <h1>Calcul de l'itinéraire…</h1>
      </div>
    );
  }

  if (!plan || (plan.steps.length === 0 && plan.unplanned.length === 0 && persisted.day.done.length === 0)) {
    return (
      <div class="empty">
        <h1>Pas encore de plan</h1>
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

  return (
    <div>
      <h1>Plan du jour</h1>
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
        <ol class="route" aria-label="Étapes dans l'ordre">
          {plan.steps.map((s, i) => (
            <li key={`${s.kind}:${s.targetId}:${i}`} class={`stop ${s.kind} ${parkClass(resort.parks, s.position.park)}${i === 0 ? ' stop-next' : ''}`}>
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
                {s.kind === 'ride' && (
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
