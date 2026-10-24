import { useState } from 'preact/hooks';
import { formatHM, parkWallTime } from '../../domain/time';
import { EASY_ACCESS_MAX_PARTY, type GroupProfile, type Pace, type ParkId } from '../../domain/types';
import { DEFAULT_PROFILE, parseProfile } from '../../state/storage';
import { useAppState, useStore } from '../context';
import { PARK_SHORT } from '../format';

const PACES: ReadonlyArray<{ value: Pace; label: string }> = [
  { value: 'slow', label: 'Tranquille' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Rapide' },
];

interface Draft {
  size: string;
  hasChild: boolean;
  height: string;
  singleRiderOk: boolean;
  budget: string;
  pace: Pace;
  stroller: boolean;
  lunchEnabled: boolean;
  lunchAt: string;
  lunchDuration: string;
  startPark: ParkId;
  emhAccess: boolean;
  easyAccess: boolean;
}

/** Members beyond the Carte Facilité party (holder + 4), who ride on their own. */
function othersOf(d: Draft): number {
  const size = Number(d.size);
  return d.easyAccess && Number.isInteger(size) ? Math.max(0, size - EASY_ACCESS_MAX_PARTY) : 0;
}

/** Single Rider is offered to the whole group without child, or to the members outside the card party. */
function singleRiderOffered(d: Draft): boolean {
  return !d.hasChild || othersOf(d) > 0;
}

function toDraft(p: GroupProfile): Draft {
  const hh = String(Math.floor(p.lunch.atMin / 60)).padStart(2, '0');
  const mm = String(p.lunch.atMin % 60).padStart(2, '0');
  return {
    size: String(p.size),
    hasChild: p.smallestHeightCm !== null,
    height: p.smallestHeightCm === null ? '' : String(p.smallestHeightCm),
    singleRiderOk: p.singleRiderOk,
    budget: String(p.paBudgetEur),
    pace: p.pace,
    stroller: p.stroller,
    lunchEnabled: p.lunch.enabled,
    lunchAt: `${hh}:${mm}`,
    lunchDuration: String(p.lunch.durationMin),
    startPark: p.startPark,
    emhAccess: p.emhAccess,
    easyAccess: p.easyAccess,
  };
}

function fromDraft(d: Draft): GroupProfile | null {
  const t = /^(\d{2}):(\d{2})$/.exec(d.lunchAt);
  const toNum = (s: string) => (s.trim() === '' ? NaN : Number(s));
  return parseProfile({
    size: toNum(d.size),
    smallestHeightCm: d.hasChild ? toNum(d.height) : null,
    singleRiderOk: singleRiderOffered(d) ? d.singleRiderOk : false,
    paBudgetEur: toNum(d.budget),
    pace: d.pace,
    stroller: d.stroller,
    lunch: { enabled: d.lunchEnabled, atMin: t ? Number(t[1]) * 60 + Number(t[2]) : NaN, durationMin: toNum(d.lunchDuration) },
    startPark: d.startPark,
    emhAccess: d.emhAccess,
    easyAccess: d.easyAccess,
  });
}

function DataSettings() {
  const store = useStore();
  const { persisted, data, now, plan } = useAppState();
  const [time, setTime] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const clock = persisted.settings.demoClock;
  const nextRide = plan?.steps.find((s) => s.kind === 'ride');

  return (
    <>
      <h2>Données</h2>
      <fieldset>
        <legend>Source des temps d'attente</legend>
        <div class="segmented">
          <label>
            <input type="radio" name="source" checked={persisted.settings.source === 'auto'} onChange={() => store.setSource('auto')} />
            <span>En direct si disponible</span>
          </label>
          <label>
            <input type="radio" name="source" checked={persisted.settings.source === 'demo'} onChange={() => store.setSource('demo')} />
            <span>Démonstration</span>
          </label>
        </div>
      </fieldset>

      {data.mode === 'demo' && clock && (
        <section class="panel" aria-labelledby="demo-title">
          <h3 id="demo-title">Journée simulée</h3>
          <p class="hint">Les attentes, pannes et séances sont simulées avec les mêmes règles que le direct. Heure simulée : {formatHM(now)}.</p>
          <form
            class="row"
            onSubmit={(e) => {
              e.preventDefault();
              const m = /^(\d{2}):(\d{2})$/.exec(time);
              if (m && Number(m[1]) < 24 && Number(m[2]) < 60) store.setDemoTime(parkWallTime(now, Number(m[1]) * 60 + Number(m[2])));
            }}
          >
            <label class="visually-hidden" for="demo-time">
              Aller à l'heure
            </label>
            <input id="demo-time" type="time" value={time || formatHM(now)} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
            <button class="btn btn-small" type="submit">
              Aller à cette heure
            </button>
          </form>
          <fieldset>
            <legend>Vitesse de l'horloge</legend>
            <div class="segmented">
              {([1, 10, 60] as const).map((s) => (
                <label key={s}>
                  <input type="radio" name="speed" checked={clock.speed === s} onChange={() => store.setDemoSpeed(s)} />
                  <span>{s === 1 ? 'Temps réel' : `× ${s}`}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button class="btn btn-small" type="button" disabled={!nextRide} onClick={() => nextRide && store.simulateBreakdown(nextRide.targetId)}>
            {nextRide ? `Simuler une panne de ${nextRide.name}` : 'Simuler une panne (aucune attraction prévue)'}
          </button>
        </section>
      )}

      <h2>Position</h2>
      <label class="toggle">
        <input type="checkbox" checked={persisted.settings.useGps} onChange={(e) => store.setUseGps((e.target as HTMLInputElement).checked)} />
        <span>Utiliser la position du téléphone dans les parcs</span>
      </label>
      <p class="hint">Traitée uniquement sur cet appareil. Sans elle, la position est celle de la dernière étape terminée. Position utilisée : {store.currentPosition().key === 'gps' ? 'celle du téléphone' : 'dernière étape terminée ou entrée du parc'}.</p>

      <h2>Journée</h2>
      {confirmReset ? (
        <div class="row">
          <button
            class="btn btn-small"
            type="button"
            onClick={() => {
              store.resetDay();
              setConfirmReset(false);
            }}
          >
            Confirmer : tout recommencer
          </button>
          <button class="btn btn-quiet btn-small" type="button" onClick={() => setConfirmReset(false)}>
            Annuler
          </button>
        </div>
      ) : (
        <button class="btn btn-small" type="button" onClick={() => setConfirmReset(true)}>
          Recommencer la journée
        </button>
      )}
      <p class="hint">Efface les étapes faites, les séances et Premier Access enregistrés. Votre liste et votre groupe sont conservés.</p>
    </>
  );
}

export function ProfileScreen({ onboarding, onDone }: { onboarding: boolean; onDone: () => void }) {
  const store = useStore();
  const { persisted } = useAppState();
  const [draft, setDraft] = useState<Draft>(() => toDraft(persisted.profile ?? DEFAULT_PROFILE));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const submit = (e: Event) => {
    e.preventDefault();
    const profile = fromDraft(draft);
    if (!profile) {
      setError('Vérifiez les valeurs : groupe de 1 à 20 personnes, taille entre 60 et 220 cm, budget entre 0 et 1000 €, déjeuner entre 10:00 et 16:00.');
      return;
    }
    setError(null);
    store.saveProfile(profile);
    setSaved(true);
    onDone();
  };

  return (
    <div>
      <h1>{onboarding ? 'Votre groupe' : 'Groupe et réglages'}</h1>
      {onboarding && <p class="muted">Quelques réglages pour calculer un itinéraire adapté à votre groupe. Tout reste sur ce téléphone.</p>}
      <form onSubmit={submit} noValidate>
        <div class="field">
          <label for="size">Nombre de personnes</label>
          <input id="size" type="number" inputMode="numeric" min={1} max={20} value={draft.size} onInput={(e) => set('size', (e.target as HTMLInputElement).value)} />
        </div>

        <label class="toggle">
          <input type="checkbox" checked={draft.hasChild} onChange={(e) => set('hasChild', (e.target as HTMLInputElement).checked)} />
          <span>Il y a un enfant dans le groupe</span>
        </label>
        {draft.hasChild && (
          <div class="field">
            <label for="height">Taille du plus petit (cm)</label>
            <input id="height" type="number" inputMode="numeric" min={60} max={220} value={draft.height} onInput={(e) => set('height', (e.target as HTMLInputElement).value)} />
            <span class="hint">Sert à écarter les attractions interdites sous une certaine taille.</span>
          </div>
        )}

        <label class="toggle">
          <input type="checkbox" checked={draft.easyAccess} onChange={(e) => set('easyAccess', (e.target as HTMLInputElement).checked)} />
          <span>Une personne a la Carte Facilité (ALD)</span>
        </label>
        {draft.easyAccess && (
          <p class="hint">
            Le titulaire s'inscrit à l'entrée Premier Access d'une attraction et reçoit une heure de retour égale à l'attente ; une seule inscription à la fois. Le plan
            occupe ce délai avec d'autres attractions en file normale. Le titulaire passe avec 4 accompagnateurs au plus, enfants compris.
            {othersOf(draft) > 0 &&
              ` Les ${othersOf(draft)} autres personnes font chaque attraction de leur côté et vous retrouvent à la sortie.`}
          </p>
        )}

        <label class="toggle">
          <input
            type="checkbox"
            checked={draft.singleRiderOk && singleRiderOffered(draft)}
            disabled={!singleRiderOffered(draft)}
            onChange={(e) => set('singleRiderOk', (e.target as HTMLInputElement).checked)}
          />
          <span>
            {draft.hasChild && othersOf(draft) > 0
              ? `Les ${othersOf(draft)} personnes hors carte acceptent la file Single Rider`
              : "Accepter d'être séparés (file Single Rider)"}
          </span>
        </label>
        {!singleRiderOffered(draft) && <p class="hint">Jamais proposé quand un enfant est dans le groupe, sauf pour les personnes hors Carte Facilité.</p>}

        <div class="field">
          <label for="budget">Budget Premier Access par personne (€)</label>
          <input id="budget" type="number" inputMode="decimal" min={0} max={1000} value={draft.budget} onInput={(e) => set('budget', (e.target as HTMLInputElement).value)} />
          <span class="hint">0 : aucun conseil d'achat.</span>
        </div>

        <fieldset>
          <legend>Rythme de marche</legend>
          <div class="segmented">
            {PACES.map((p) => (
              <label key={p.value}>
                <input type="radio" name="pace" checked={draft.pace === p.value} onChange={() => set('pace', p.value)} />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label class="toggle">
          <input type="checkbox" checked={draft.stroller} onChange={(e) => set('stroller', (e.target as HTMLInputElement).checked)} />
          <span>Avec une poussette</span>
        </label>

        <label class="toggle">
          <input type="checkbox" checked={draft.lunchEnabled} onChange={(e) => set('lunchEnabled', (e.target as HTMLInputElement).checked)} />
          <span>Prévoir une pause déjeuner</span>
        </label>
        {draft.lunchEnabled && (
          <div class="row">
            <div class="field">
              <label for="lunch-at">Vers</label>
              <input id="lunch-at" type="time" min="10:00" max="16:00" value={draft.lunchAt} onInput={(e) => set('lunchAt', (e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="lunch-duration">Durée</label>
              <select id="lunch-duration" value={draft.lunchDuration} onChange={(e) => set('lunchDuration', (e.target as HTMLSelectElement).value)}>
                {['30', '45', '60', '90'].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <fieldset>
          <legend>Parc de départ</legend>
          <div class="segmented">
            {(['dlp', 'daw'] as const).map((p) => (
              <label key={p}>
                <input type="radio" name="start-park" checked={draft.startPark === p} onChange={() => set('startPark', p)} />
                <span>{PARK_SHORT[p]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label class="toggle">
          <input type="checkbox" checked={draft.emhAccess} onChange={(e) => set('emhAccess', (e.target as HTMLInputElement).checked)} />
          <span>Accès aux Heures de Magie en Plus</span>
        </label>
        <p class="hint">Hôtels Disney et certains pass annuels : accès à quelques attractions avant l'ouverture officielle, selon les horaires publiés du jour.</p>

        {error && (
          <p role="alert" class="banner">
            {error}
          </p>
        )}
        <div class="row">
          <button class="btn btn-primary" type="submit">
            {onboarding ? 'Commencer la visite' : 'Enregistrer'}
          </button>
          <span role="status" class="hint">
            {saved && !onboarding ? 'Enregistré, plan recalculé.' : ''}
          </span>
        </div>
      </form>

      {!onboarding && <DataSettings />}

      <p class="footer-note">
        Temps d'attente en direct fournis par <a href="https://themeparks.wiki/" target="_blank" rel="noopener noreferrer">ThemeParks.wiki</a>. Application indépendante, non affiliée à Disney ni à Disneyland Paris. Tailles minimales, durées et positions sont indicatives : vérifiez-les sur place ou dans l'application officielle.
      </p>
    </div>
  );
}
