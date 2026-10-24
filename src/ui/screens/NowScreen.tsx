import { useState } from 'preact/hooks';
import { MINUTE, formatHM, parkWallTime } from '../../domain/time';
import type { PlanStep } from '../../domain/types';
import { useAppState, useStore } from '../context';
import type { Tab } from '../context';
import { PARK_SHORT, QUEUE_LABEL, STEP_LABEL, euros, inMinutes, minutes } from '../format';

interface Props {
  readonly go: (tab: Tab) => void;
  readonly report: (placeId: string) => void;
}

const OFFICIAL_SITE = 'https://www.disneylandparis.com/';

function doneLabel(step: PlanStep): string {
  switch (step.kind) {
    case 'show':
      return 'Spectacle vu';
    case 'lunch':
      return 'Pause terminée';
    default:
      return 'Attraction faite';
  }
}

function NextSign({ step, now, report, go }: { step: PlanStep; now: number; report: (id: string) => void; go: (tab: Tab) => void }) {
  const store = useStore();
  const state = useAppState();
  const place = step.targetId ? state.catalog.get(step.targetId) : undefined;
  const timed = step.latestDepartAt !== null && step.kind !== 'lunch';
  const late = timed && step.latestDepartAt! < now;

  return (
    <section class={`sign ${step.position.park}`} aria-labelledby="next-title">
      <p class="sign-kind">
        Prochaine étape : {STEP_LABEL[step.kind].toLowerCase()}
        {step.kind !== 'lunch' && step.departAt > now + MINUTE ? `, départ ${inMinutes(step.departAt, now)}` : ''}
      </p>
      <h1 id="next-title" class="sign-title">
        {step.name}
      </h1>
      <p class="sign-where">
        {step.kind === 'lunch' ? 'Où vous voulez, près de votre position' : `${place?.land ?? ''}, ${PARK_SHORT[step.position.park]}`}
      </p>
      <dl class="facts">
        {step.kind === 'lunch' ? (
          <>
            <div>
              <dt>début</dt>
              <dd>{formatHM(step.startAt)}</dd>
            </div>
            <div>
              <dt>durée</dt>
              <dd>{minutes(Math.round((step.endAt - step.startAt) / MINUTE))}</dd>
            </div>
            <div>
              <dt>au plus tard</dt>
              <dd>{formatHM(step.latestDepartAt ?? step.startAt)}</dd>
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
      {step.queue && step.queue !== 'standby' && (
        <p class="queue-note">
          Prenez la {QUEUE_LABEL[step.queue]}
          {step.queue === 'single' ? ' : vous serez séparés, retrouvez-vous à la sortie.' : '.'}
        </p>
      )}
      {late && <p class="queue-note">Départ conseillé dépassé : y aller maintenant reste possible si vous vous pressez.</p>}
      <div class="row">
        <button class="btn btn-primary" type="button" onClick={() => store.completeStep(step)}>
          {doneLabel(step)}
        </button>
        <button class="btn" type="button" onClick={() => store.skip(step.targetId)}>
          Passer
        </button>
        {step.targetId && step.walkMin > 0 && (
          <button class="btn btn-quiet" type="button" onClick={() => go('map')}>
            Voir le trajet
          </button>
        )}
        {step.targetId && (
          <button class="btn btn-quiet" type="button" onClick={() => report(step.targetId)}>
            Signaler
          </button>
        )}
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
      <h3 id="pa-title">Premier Access conseillé : {advice.name}</h3>
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
          <a class="btn btn-quiet btn-small" href={OFFICIAL_SITE} target="_blank" rel="noopener noreferrer">
            Site officiel
          </a>
        </div>
      )}
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
        <h2>Chargement des temps d'attente…</h2>
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

  const [first, ...rest] = plan?.steps ?? [];
  const doneCount = persisted.day.done.length;
  const parkClosed = Object.values(snapshot.hours).every((h) => now >= h.close || now < h.open - 60 * MINUTE);

  return (
    <div>
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

      <PremierAccessAdvice />

      {rest.length > 0 && (
        <section class="panel" aria-labelledby="then-title">
          <h3 id="then-title">Ensuite</h3>
          <ol class="reasons">
            {rest.slice(0, 3).map((s) => (
              <li key={`${s.kind}:${s.targetId}`}>
                <span>{s.name}</span>
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
        <p class="summary">
          <span>
            Incontournables planifiés : <strong class="num">{plan.totals.mustPlanned}/{plan.totals.mustTotal}</strong>
          </span>
          <span>
            Faits aujourd'hui : <strong class="num">{doneCount}</strong>
          </span>
          <span>
            Attente prévue : <strong class="num">{minutes(plan.totals.waitMin)}</strong>
          </span>
        </p>
      )}
    </div>
  );
}
