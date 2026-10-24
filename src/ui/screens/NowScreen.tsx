import { useState } from 'preact/hooks';
import { MINUTE, formatHM, parkWallTime } from '../../domain/time';
import type { PlanStep } from '../../domain/types';
import { useAppState, useStore } from '../context';
import type { Tab } from '../context';
import { MEAL_MODE_LABEL, MEAL_SLOT_LABEL, PARK_SHORT, QUEUE_LABEL, STEP_LABEL, euros, inMinutes, minutes, stepTitle } from '../format';
import { DLP_DINING } from '../../data/resort';
import { ExternalLink } from '../components/ExternalLink';

interface Props {
  readonly go: (tab: Tab) => void;
  readonly report: (placeId: string) => void;
}

const OFFICIAL_SITE = 'https://www.disneylandparis.com/';

function doneLabel(step: PlanStep): string {
  switch (step.kind) {
    case 'show':
      return 'Spectacle vu';
    case 'meal':
      return 'Repas terminé';
    default:
      return 'Attraction faite';
  }
}

/** What the members outside the Carte Facilité party do. */
function OthersNote({ step }: { step: PlanStep }) {
  const o = step.others;
  if (!o) return null;
  const who = o.count === 1 ? 'La personne hors carte' : `Les ${o.count} personnes hors carte`;
  return (
    <p class="party-note">
      {o.rides
        ? `${who} : ${QUEUE_LABEL[o.queue]}, environ ${minutes(o.waitMin)} d'attente. Retrouvailles à la sortie vers ${formatHM(step.endAt)}.`
        : `${who} : pas de file assez rapide ici. Pause ou attraction voisine, retrouvailles à la sortie vers ${formatHM(step.endAt)}.`}
    </p>
  );
}

/** Practical notes for a meal stop: way out for a picnic, booking, menu. */
function MealNotes({ step }: { step: PlanStep }) {
  const meal = step.meal!;
  return (
    <>
      {meal.reentryMin > 0 && (
        <p class="queue-note">Sortie du parc, puis nouveau contrôle de sécurité au retour : {minutes(meal.reentryMin)} comptées dans la durée.</p>
      )}
      {meal.mode === 'table' && meal.reservationAt === null && (
        <p class="queue-note">Réservation conseillée : indiquez votre créneau dans Ma liste, rubrique Repas, pour caler le plan dessus.</p>
      )}
      {meal.mode === 'free' && <p class="queue-note">Pause où vous voulez, sans détour.</p>}
      {(meal.mode === 'quick' || meal.mode === 'table') && step.targetId && (
        <p class="queue-note">
          <ExternalLink href={meal.url ?? DLP_DINING.restaurantsUrl}>{meal.url ? 'Voir le menu' : 'Menus sur le site officiel'}</ExternalLink>
        </p>
      )}
    </>
  );
}

/** Registration step: the holder gets a return time; the user records the one actually given. */
function EasyAccessForm({ step }: { step: PlanStep }) {
  const store = useStore();
  const { now } = useAppState();
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    const m = /^(\d{2}):(\d{2})$/.exec(time || formatHM(step.returnAt ?? now));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      setError('Indiquez l’heure de retour donnée par le Cast Member.');
      return;
    }
    if (!store.registerEasyAccess(step.targetId, parkWallTime(now, Number(m[1]) * 60 + Number(m[2])))) {
      setError('Heure de retour invalide : elle doit être dans les prochaines heures.');
      return;
    }
    setError(null);
  };
  return (
    <form onSubmit={submit} noValidate>
      <div class="field">
        <label for="easy-return">Heure de retour donnée</label>
        <input id="easy-return" type="time" value={time || formatHM(step.returnAt ?? now)} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
      </div>
      {error && (
        <p role="alert" class="queue-note">
          {error}
        </p>
      )}
      <button class="btn btn-primary btn-block" type="submit">
        Inscription faite
      </button>
    </form>
  );
}

function NextSign({ step, now, report, go }: { step: PlanStep; now: number; report: (id: string) => void; go: (tab: Tab) => void }) {
  const store = useStore();
  const state = useAppState();
  const place = step.targetId ? state.catalog.get(step.targetId) : undefined;
  const meal = step.kind === 'meal' ? step.meal : null;
  const timed = step.latestDepartAt !== null && step.kind !== 'meal';
  const late = timed && step.latestDepartAt! < now;
  const booking = step.kind === 'easy-book';
  const held = state.persisted.day.easyAccess;

  return (
    <section class={`sign ticket ${meal ? 'meal' : step.position.park}`} aria-labelledby="next-title">
      <div class="ticket-band">
        <p class="sign-kind">
          Prochaine étape : {meal ? `${MEAL_SLOT_LABEL[meal.slot].toLowerCase()}, ${MEAL_MODE_LABEL[meal.mode].toLowerCase()}` : STEP_LABEL[step.kind].toLowerCase()}
          {step.departAt > now + MINUTE ? `, départ ${inMinutes(step.departAt, now)}` : ''}
        </p>
      </div>
      <div class="ticket-main">
        <h1 id="next-title" class="sign-title">
          {meal ? (step.targetId ? step.name : MEAL_SLOT_LABEL[meal.slot]) : stepTitle(step)}
        </h1>
        <p class="sign-where">
          {meal
            ? step.targetId
              ? `${PARK_SHORT[step.position.park]}${meal.reentryMin > 0 ? ', hors des parcs' : ''}`
              : 'Où vous voulez, près de votre position'
            : `${place?.land ?? ''}, ${PARK_SHORT[step.position.park]}`}
        </p>
      </div>
      <div class="ticket-perf" aria-hidden="true" />
      <div class="ticket-stub">
      <dl class="facts">
        {meal ? (
          <>
            <div>
              <dt>{step.targetId ? 'de marche' : 'au plus tard'}</dt>
              <dd>{step.targetId ? minutes(step.walkMin) : formatHM(step.latestDepartAt ?? step.startAt)}</dd>
            </div>
            <div>
              <dt>{meal.reservationAt !== null ? 'réservation' : 'début'}</dt>
              <dd>{formatHM(meal.reservationAt ?? step.startAt)}</dd>
            </div>
            <div>
              <dt>durée</dt>
              <dd>{minutes(Math.round((step.endAt - step.startAt) / MINUTE))}</dd>
            </div>
          </>
        ) : booking ? (
          <>
            <div>
              <dt>de marche</dt>
              <dd>{minutes(step.walkMin)}</dd>
            </div>
            <div>
              <dt>retour prévu</dt>
              <dd>{formatHM(step.returnAt ?? step.endAt)}</dd>
            </div>
            <div>
              <dt>arrivée</dt>
              <dd>{formatHM(step.arriveAt)}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>de marche</dt>
              <dd>{minutes(step.walkMin)}</dd>
            </div>
            <div>
              <dt>{step.kind === 'show' ? 'avant le début' : "d'attente"}</dt>
              <dd>{minutes(step.waitMin)}</dd>
            </div>
            <div>
              <dt>{timed ? 'partir avant' : 'arrivée'}</dt>
              <dd>{formatHM(timed ? step.latestDepartAt! : step.arriveAt)}</dd>
            </div>
          </>
        )}
      </dl>
      {booking && (
        <p class="queue-note">
          Présentez la Carte Facilité à l'entrée Premier Access pour obtenir l'heure de retour. En attendant, le plan enchaîne d'autres attractions en file normale.
        </p>
      )}
      {step.queue === 'easy' && (
        <p class="queue-note">
          Passez par l'{QUEUE_LABEL.easy}
          {held && held.rideId === step.targetId ? `, à partir de ${formatHM(held.returnAt)}.` : '.'}
        </p>
      )}
      {step.queue && step.queue !== 'standby' && step.queue !== 'easy' && (
        <p class="queue-note">
          Prenez la {QUEUE_LABEL[step.queue]}
          {step.queue === 'single' ? ' : vous serez séparés, retrouvez-vous à la sortie.' : '.'}
        </p>
      )}
      <OthersNote step={step} />
      {meal && <MealNotes step={step} />}
      {late && <p class="queue-note">Départ conseillé dépassé : y aller maintenant reste possible si vous vous pressez.</p>}
      {booking && <EasyAccessForm step={step} />}
      {!booking && (
        <button class="btn btn-primary btn-block" type="button" onClick={() => store.completeStep(step)}>
          {doneLabel(step)}
        </button>
      )}
      <div class="ticket-actions">
        <button class="btn btn-quiet" type="button" onClick={() => store.skipStep(step)}>
          Passer
        </button>
        {step.targetId && step.walkMin > 0 && (
          <button class="btn btn-quiet" type="button" onClick={() => go('map')}>
            Voir le trajet
          </button>
        )}
        {step.targetId && !meal && (
          <button class="btn btn-quiet" type="button" onClick={() => report(step.targetId)}>
            Signaler
          </button>
        )}
      </div>
      </div>
    </section>
  );
}

function PremierAccessAdvice() {
  const store = useStore();
  const { advice, now } = useAppState();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!advice) return null;

  const confirm = (e: Event) => {
    e.preventDefault();
    const m = /^(\d{2}):(\d{2})$/.exec(time || formatHM(advice.returnStart));
    if (!m) {
      setError('Indiquez l’heure de début du créneau acheté.');
      return;
    }
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) {
      setError('Heure invalide.');
      return;
    }
    const start = parkWallTime(advice.returnStart, hh * 60 + mm);
    if (start + 60 * MINUTE < now) {
      setError('Ce créneau est déjà passé.');
      return;
    }
    if (!store.bookPremierAccess(advice.attractionId, start, advice.priceCents)) {
      setError('Achat non enregistré : budget Premier Access dépassé.');
      return;
    }
    setOpen(false);
    setError(null);
  };

  return (
    <section class="panel" aria-labelledby="pa-title">
      <h2 id="pa-title">Premier Access conseillé{'\u00a0'}: {advice.name}</h2>
      <p>
        Environ {advice.gainMin} min gagnées sur {advice.standbyMin} min d'attente prévue, pour {euros(advice.priceCents)} par personne (
        {euros(advice.groupPriceCents)} pour le groupe). Créneau proposé : {formatHM(advice.returnStart)}–{formatHM(advice.returnEnd)}.
      </p>
      <p class="hint">L'achat se fait dans l'application officielle Disneyland Paris. Enregistrez ensuite le créneau ici pour l'intégrer au plan.</p>
      {open ? (
        <form onSubmit={confirm} noValidate>
          <div class="field">
            <label for="pa-start">Début du créneau acheté</label>
            <input id="pa-start" type="time" value={time || formatHM(advice.returnStart)} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
          </div>
          {error && (
            <p role="alert" class="hint">
              {error}
            </p>
          )}
          <div class="row">
            <button class="btn btn-primary btn-small" type="submit">
              Enregistrer le créneau
            </button>
            <button class="btn btn-quiet btn-small" type="button" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <div class="row">
          <button class="btn btn-small" type="button" onClick={() => setOpen(true)}>
            J'ai acheté
          </button>
          <ExternalLink class="btn btn-quiet btn-small" href={OFFICIAL_SITE}>
            Site officiel
          </ExternalLink>
        </div>
      )}
    </section>
  );
}

/** The registration currently held, with a way to drop it. */
function EasyAccessHeld() {
  const store = useStore();
  const { persisted, catalog, now } = useAppState();
  const held = persisted.day.easyAccess;
  if (!held || !persisted.profile?.easyAccess) return null;
  const name = catalog.get(held.rideId)?.name ?? held.rideId;
  return (
    <section class="panel" aria-labelledby="easy-title">
      <h2 id="easy-title">Carte Facilité{'\u00a0'}: {name}</h2>
      <p>
        {held.returnAt > now ? `Retour à partir de ${formatHM(held.returnAt)} (${inMinutes(held.returnAt, now)}).` : `Accessible depuis ${formatHM(held.returnAt)}.`} Pas d'autre inscription
        possible d'ici là.
      </p>
      <button class="btn btn-quiet btn-small" type="button" onClick={() => store.cancelEasyAccess()}>
        Annuler l'inscription
      </button>
    </section>
  );
}

export function NowScreen({ go, report }: Props) {
  const store = useStore();
  const state = useAppState();
  const { plan, now, persisted, snapshot } = state;

  if (!snapshot) {
    return (
      <div class="empty" role="status">
        <h1>Chargement des temps d'attente…</h1>
      </div>
    );
  }

  if (persisted.wishes.length === 0 && persisted.day.shows.length === 0) {
    return (
      <div class="empty">
        <h1>Que voulez-vous faire aujourd'hui ?</h1>
        <p class="muted">Choisissez vos attractions incontournables et vos spectacles : l'itinéraire se calcule tout seul, puis s'adapte aux attentes et aux pannes.</p>
        <button class="btn btn-primary" type="button" onClick={() => go('list')}>
          Choisir les attractions
        </button>
      </div>
    );
  }

  if (!plan && state.planPending) {
    return (
      <div class="empty" role="status">
        <h1>Calcul de l'itinéraire…</h1>
      </div>
    );
  }

  const [first, ...rest] = plan?.steps ?? [];
  const doneCount = persisted.day.done.length;
  const parkClosed = Object.values(snapshot.hours).every((h) => now >= h.close || now < h.open - 60 * MINUTE);

  return (
    <div class="now-layout">
      <div class="now-main">
      {first ? (
        <NextSign step={first} now={now} report={report} go={go} />
      ) : (
        <div class="empty">
          <h1>{parkClosed ? 'Les parcs sont fermés' : 'Rien d’autre de faisable'}</h1>
          <p class="muted">
            {parkClosed
              ? state.data.mode === 'demo'
                ? 'Changez l’heure simulée dans Groupe pour rejouer la journée.'
                : 'Le plan en direct reprendra à l’ouverture. Vous pouvez préparer votre visite sur une journée simulée.'
              : 'Tout ce qui reste dans votre liste est fait, fermé ou hors de portée avant la fermeture. Ajoutez des attractions pour continuer.'}
          </p>
          <div class="row">
            {parkClosed && state.data.mode !== 'demo' && (
              <button class="btn btn-primary" type="button" onClick={() => store.setSource('demo')}>
                Préparer sur une journée simulée
              </button>
            )}
            <button class="btn" type="button" onClick={() => go('list')}>
              Modifier ma liste
            </button>
          </div>
        </div>
      )}
      </div>

      <div class="now-side">
      <EasyAccessHeld />

      <PremierAccessAdvice />

      {rest.length > 0 && (
        <section class="panel" aria-labelledby="then-title">
          <h2 id="then-title">Ensuite</h2>
          <ol class="reasons">
            {rest.slice(0, 4).map((s, i) => (
              <li key={`${s.kind}:${s.targetId}:${i}`}>
                <span>{s.kind === 'easy-book' ? `Inscription Carte Facilité : ${s.name}` : stepTitle(s)}</span>
                <span class="num muted">{formatHM(s.kind === 'ride' || s.kind === 'pa' ? s.arriveAt : s.startAt)}</span>
              </li>
            ))}
          </ol>
          <button class="btn btn-quiet btn-small" type="button" onClick={() => go('plan')}>
            Voir tout le plan
          </button>
        </section>
      )}

      {plan && (
        <dl class="summary">
          <div>
            <dt>Incontournables planifiés</dt>
            <dd class="num">
              {plan.totals.mustPlanned}/{plan.totals.mustTotal}
            </dd>
          </div>
          <div>
            <dt>Faits aujourd'hui</dt>
            <dd class="num">{doneCount}</dd>
          </div>
          <div>
            <dt>Attente prévue</dt>
            <dd class="num">{minutes(plan.totals.waitMin)}</dd>
          </div>
        </dl>
      )}
      </div>
    </div>
  );
}
