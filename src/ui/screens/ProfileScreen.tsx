import { useState } from 'preact/hooks';
import { formatHM, parkWallTime } from '../../domain/time';
import { EASY_ACCESS_MAX_PARTY, type GroupProfile, type MealMode, type MealPref, type MealSlot, type Pace, type ParkId } from '../../domain/types';
import { DEFAULT_PROFILE, MEAL_WINDOWS, parseProfile } from '../../state/storage';
import { useAppState, useStore } from '../context';
import { DESTINATIONS, type DestinationDef } from '../../data/destinations';
import { MEAL_MODE_LABEL, MEAL_SLOT_LABEL } from '../format';
import { ExternalLink } from '../components/ExternalLink';

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
  meals: Record<MealSlot, MealDraft>;
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

interface MealDraft {
  enabled: boolean;
  at: string;
  duration: string;
  mode: MealMode;
}

/** Typical time for each way of eating, queue included (the user can change it). */
const MEAL_DURATION: Readonly<Record<MealMode, number>> = { free: 45, picnic: 40, quick: 30, table: 75 };
const MEAL_MODES: readonly MealMode[] = ['quick', 'table', 'picnic', 'free'];
const DURATIONS = ['20', '30', '40', '45', '60', '75', '90', '120'];

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minutesOf = (v: string) => {
  const t = /^(\d{2}):(\d{2})$/.exec(v);
  return t ? Number(t[1]) * 60 + Number(t[2]) : NaN;
};

type DraftField = 'size' | 'height' | 'budget' | 'lunchAt' | 'dinnerAt';
interface FieldProblem {
  readonly field: DraftField;
  readonly text: string;
}
const FIELD_IDS: Readonly<Record<DraftField, string>> = { size: 'size', height: 'height', budget: 'budget', lunchAt: 'lunch-at', dinnerAt: 'dinner-at' };

/** Field-level checks, each with a message that says how to fix the value. */
function validateDraft(d: Draft): FieldProblem[] {
  const out: FieldProblem[] = [];
  const intIn = (v: string, lo: number, hi: number) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
  if (!intIn(d.size, 1, 20)) out.push({ field: 'size', text: 'Indiquez un nombre entier de 1 à 20 personnes.' });
  if (d.hasChild && !intIn(d.height, 60, 220)) out.push({ field: 'height', text: 'Indiquez une taille en centimètres, entre 60 et 220.' });
  const budget = Number(d.budget);
  if (d.budget.trim() === '' || !Number.isFinite(budget) || budget < 0 || budget > 1000) out.push({ field: 'budget', text: 'Indiquez un montant entre 0 et 1000 €.' });
  for (const slot of ['lunch', 'dinner'] as const) {
    const meal = d.meals[slot];
    const [lo, hi] = MEAL_WINDOWS[slot];
    const m = minutesOf(meal.at);
    if (meal.enabled && !(m >= lo && m <= hi)) out.push({ field: `${slot}At`, text: `Choisissez une heure entre ${hhmm(lo)} et ${hhmm(hi)}.` });
  }
  return out;
}

/** One meal: on/off, how the group eats, when, and for how long. */
function MealFields({ slot, meal, error, onChange }: { slot: MealSlot; meal: MealDraft; error: string | null; onChange: (m: MealDraft) => void }) {
  const id = `${slot}`;
  const label = MEAL_SLOT_LABEL[slot];
  const { resort } = useAppState();
  return (
    <div class="meal-fields">
      <label class="toggle">
        <input type="checkbox" checked={meal.enabled} onChange={(e) => onChange({ ...meal, enabled: (e.target as HTMLInputElement).checked })} />
        <span>Prévoir le {label.toLowerCase()}</span>
      </label>
      {meal.enabled && (
        <div class="field-nested">
          <fieldset>
            <legend>{label} : comment ?</legend>
            <div class="segmented">
              {MEAL_MODES.map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={meal.mode === mode}
                    onChange={() => onChange({ ...meal, mode, duration: String(MEAL_DURATION[mode]) })}
                  />
                  <span>{MEAL_MODE_LABEL[mode]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div class="row">
            <div class="field">
              <label for={`${id}-at`}>Vers</label>
              <input
                id={`${id}-at`}
                type="time"
                value={meal.at}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                onInput={(e) => onChange({ ...meal, at: (e.target as HTMLInputElement).value })}
              />
              <FieldError id={`${id}-error`} text={error} />
            </div>
            <div class="field">
              <label for={`${id}-duration`}>Durée</label>
              <select id={`${id}-duration`} value={meal.duration} onChange={(e) => onChange({ ...meal, duration: (e.target as HTMLSelectElement).value })}>
                {[...new Set([...DURATIONS, meal.duration])].sort((a, b) => Number(a) - Number(b)).map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p class="hint">{meal.mode === 'picnic' ? `Aire de pique-nique : ${lowerFirst(resort.def.dining.picnicNote)}` : MEAL_HINT[meal.mode]}</p>
        </div>
      )}
    </div>
  );
}

const MEAL_HINT: Readonly<Record<MealMode, string>> = {
  quick: "Comptoir, kiosque ou food truck : le plan choisit le plus proche du parcours, ou celui que vous indiquez dans Ma liste.",
  table: 'Restaurant à table : indiquez votre réservation dans Ma liste, le plan se cale dessus.',
  picnic: '',
  free: 'Une pause là où vous êtes, sans détour.',
};

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

const COUNTRIES = [...new Set(DESTINATIONS.map((d) => d.country))];

/** Which park the day is planned for. Takes effect at once: the list of that park comes back. */
function DestinationPicker({ onboarding }: { onboarding: boolean }) {
  const store = useStore();
  const { resort, data } = useAppState();
  const def = resort.def;
  const mode = def.live ? 'Temps d’attente en direct quand le parc les publie.' : 'Mode estimé : attentes estimées, séances saisies par vous.';
  return (
    <section class="form-section" aria-labelledby="sec-dest">
      <h2 id="sec-dest">Parc visité</h2>
      <div class="field">
        <label for="destination">{onboarding ? 'Où allez-vous ?' : 'Destination'}</label>
        <select
          id="destination"
          class="dest-select"
          value={def.id}
          aria-describedby="dest-hint"
          onChange={(e) => void store.setDestination((e.target as HTMLSelectElement).value)}
        >
          {COUNTRIES.map((c) => (
            <optgroup key={c} label={c}>
              {DESTINATIONS.filter((d) => d.country === c).map((d: DestinationDef) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.place})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span class="hint" id="dest-hint">
          {mode} Changer de parc recommence la journée ; la liste de chaque parc est gardée.
          {data.mode === 'unavailable' && ' Données du parc inaccessibles pour le moment : une connexion est nécessaire au premier chargement.'}
        </span>
      </div>
    </section>
  );
}

function FieldError({ id, text }: { id: string; text: string | null }) {
  return text ? (
    <span class="field-error" id={id}>
      {text}
    </span>
  ) : null;
}

const mealDraft = (m: MealPref): MealDraft => ({ enabled: m.enabled, at: hhmm(m.atMin), duration: String(m.durationMin), mode: m.mode });

function toDraft(p: GroupProfile): Draft {
  return {
    size: String(p.size),
    hasChild: p.smallestHeightCm !== null,
    height: p.smallestHeightCm === null ? '' : String(p.smallestHeightCm),
    singleRiderOk: p.singleRiderOk,
    budget: String(p.paBudgetEur),
    pace: p.pace,
    stroller: p.stroller,
    meals: { lunch: mealDraft(p.lunch), dinner: mealDraft(p.dinner) },
    startPark: p.startPark,
    emhAccess: p.emhAccess,
    easyAccess: p.easyAccess,
  };
}

function fromDraft(d: Draft): GroupProfile | null {
  const toNum = (s: string) => (s.trim() === '' ? NaN : Number(s));
  return parseProfile({
    size: toNum(d.size),
    smallestHeightCm: d.hasChild ? toNum(d.height) : null,
    singleRiderOk: singleRiderOffered(d) ? d.singleRiderOk : false,
    paBudgetEur: toNum(d.budget),
    pace: d.pace,
    stroller: d.stroller,
    lunch: { enabled: d.meals.lunch.enabled, atMin: minutesOf(d.meals.lunch.at), durationMin: toNum(d.meals.lunch.duration), mode: d.meals.lunch.mode },
    dinner: { enabled: d.meals.dinner.enabled, atMin: minutesOf(d.meals.dinner.at), durationMin: toNum(d.meals.dinner.duration), mode: d.meals.dinner.mode },
    startPark: d.startPark,
    emhAccess: d.emhAccess,
    easyAccess: d.easyAccess,
  });
}

/** Manual mode: the day's opening hours, read at the gate or on the park's site. */
function ManualHours({ open, close }: { open: number | null; close: number | null }) {
  const store = useStore();
  const [from, setFrom] = useState(open === null ? '' : formatHM(open));
  const [to, setTo] = useState(close === null ? '' : formatHM(close));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section class="panel" aria-labelledby="hours-title">
      <h3 id="hours-title">Horaires du jour</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const ok = store.setManualHours(minutesOf(from), minutesOf(to));
          setMsg(ok ? { ok, text: 'Horaires enregistrés, plan recalculé.' } : { ok, text: 'Ouverture après 6:00, fermeture au plus tard à minuit, au moins une heure entre les deux.' });
        }}
        noValidate
      >
        <div class="row">
          <div class="field">
            <label for="hours-open">Ouverture</label>
            <input id="hours-open" type="time" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for="hours-close">Fermeture</label>
            <input id="hours-close" type="time" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <button class="btn btn-small" type="submit">
          Enregistrer les horaires
        </button>
        <p class={msg && !msg.ok ? 'field-error' : 'hint'} role="status">
          {msg?.text ?? ''}
        </p>
      </form>
    </section>
  );
}

function DataSettings() {
  const store = useStore();
  const { persisted, data, now, plan, resort, snapshot } = useAppState();
  const [time, setTime] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const clock = persisted.settings.demoClock;
  const nextRide = plan?.steps.find((s) => s.kind === 'ride');

  return (
    <>
      <section class="form-section" aria-labelledby="sec-data">
      <h2 id="sec-data">Données</h2>
      {resort.def.features.demo ? (
      <fieldset>
        <legend>Source des temps d'attente</legend>
        <div class="segmented joined">
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
      ) : (
        <p class="hint">
          {resort.def.live
            ? `Temps d’attente en direct pour ${resort.def.name} quand ils sont publiés ; à défaut, dernières données reçues puis mode estimé.`
            : `${resort.def.name} ne publie pas ses temps d’attente : ils sont estimés, et vous les corrigez sur place.`}
        </p>
      )}

      {data.mode === 'manual' && <ManualHours open={snapshot ? Object.values(snapshot.hours)[0]?.open ?? null : null} close={snapshot ? Object.values(snapshot.hours)[0]?.close ?? null : null} />}

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
            <div class="segmented joined">
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
      </section>

      <section class="form-section" aria-labelledby="sec-position">
      <h2 id="sec-position">Position</h2>
      <label class="toggle">
        <input type="checkbox" checked={persisted.settings.useGps} onChange={(e) => store.setUseGps((e.target as HTMLInputElement).checked)} />
        <span>Utiliser la position du téléphone dans les parcs</span>
      </label>
      <p class="hint">Traitée uniquement sur cet appareil. Sans elle, la position est celle de la dernière étape terminée. Position utilisée : {store.currentPosition().key === 'gps' ? 'celle du téléphone' : 'dernière étape terminée ou entrée du parc'}.</p>

      </section>

      <section class="form-section" aria-labelledby="sec-reset">
      <h2 id="sec-reset">Journée</h2>
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
      </section>

      <section class="form-section" aria-labelledby="sec-a11y">
        <h2 id="sec-a11y">Accessibilité</h2>
        <p>
          L'application suit le référentiel général d'amélioration de l'accessibilité (RGAA 4.1) : navigation complète au clavier, liens d'évitement, contrastes
          renforcés, texte agrandissable jusqu'à 200 %, affichage sans défilement horizontal dès 320 pixels de large, thème sombre, animations désactivées si
          votre appareil le demande, police conçue pour la lisibilité.
        </p>
        <p class="hint">
          Conformité non auditée : ces points sont vérifiés par des tests automatisés à chaque version, sans audit RGAA indépendant. Pour signaler une difficulté,
          ouvrez une demande sur le <ExternalLink href="https://github.com/Metazel/Parcpilote/issues">dépôt du projet</ExternalLink>.
        </p>
      </section>
    </>
  );
}

export function ProfileScreen({ onboarding, onDone }: { onboarding: boolean; onDone: () => void }) {
  const store = useStore();
  const { persisted, resort } = useAppState();
  const features = resort.def.features;
  const parks = resort.parks;
  const isDlp = resort.def.id === 'dlp';
  const [draft, setDraft] = useState<Draft>(() => toDraft(persisted.profile ?? DEFAULT_PROFILE));
  const [errors, setErrors] = useState<FieldProblem[]>([]);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const errorOf = (field: DraftField) => errors.find((x) => x.field === field)?.text ?? null;

  const submit = (e: Event) => {
    e.preventDefault();
    const found = validateDraft(draft);
    const fixed: Draft = {
      ...draft,
      startPark: parks.some((p) => p.id === draft.startPark) ? draft.startPark : (parks[0]?.id ?? resort.def.id),
      easyAccess: features.easyAccess && draft.easyAccess,
      emhAccess: features.emh && draft.emhAccess,
    };
    const profile = found.length === 0 ? fromDraft(fixed) : null;
    if (!profile) {
      const list: FieldProblem[] = found.length > 0 ? found : [{ field: 'size', text: 'Vérifiez les valeurs saisies.' }];
      setErrors(list);
      // Focus the first field to correct (RGAA 11.10).
      document.getElementById(FIELD_IDS[list[0]!.field])?.focus();
      return;
    }
    setErrors([]);
    store.saveProfile(profile);
    setSaved(true);
    onDone();
  };

  return (
    <div>
      <h1>{onboarding ? 'Votre groupe' : 'Groupe et réglages'}</h1>
      {onboarding && <p class="muted">Quelques réglages pour calculer un itinéraire adapté à votre groupe. Tout reste sur ce téléphone.</p>}
      <DestinationPicker onboarding={onboarding} />
      <form onSubmit={submit} noValidate>
        {errors.length > 0 && (
          <div role="alert" class="banner banner-error">
            <p>Le profil n'est pas enregistré : {errors.length === 1 ? 'un champ est à corriger' : `${errors.length} champs sont à corriger`}.</p>
          </div>
        )}

        <section class="form-section" aria-labelledby="sec-who">
          <h2 id="sec-who">Qui vient</h2>
          <div class="field">
            <label for="size">Nombre de personnes</label>
            <input
              id="size"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={draft.size}
              aria-invalid={errorOf('size') ? 'true' : undefined}
              aria-describedby={errorOf('size') ? 'size-error' : undefined}
              onInput={(e) => set('size', (e.target as HTMLInputElement).value)}
            />
            <FieldError id="size-error" text={errorOf('size')} />
          </div>

          <label class="toggle">
            <input type="checkbox" checked={draft.hasChild} onChange={(e) => set('hasChild', (e.target as HTMLInputElement).checked)} />
            <span>Il y a un enfant dans le groupe</span>
          </label>
          {draft.hasChild && (
            <div class="field field-nested">
              <label for="height">Taille du plus petit (cm)</label>
              <input
                id="height"
                type="number"
                inputMode="numeric"
                min={60}
                max={220}
                value={draft.height}
                aria-invalid={errorOf('height') ? 'true' : undefined}
                aria-describedby={errorOf('height') ? 'height-error height-hint' : 'height-hint'}
                onInput={(e) => set('height', (e.target as HTMLInputElement).value)}
              />
              <span class="hint" id="height-hint">
                Sert à écarter les attractions interdites sous une certaine taille.
              </span>
              <FieldError id="height-error" text={errorOf('height')} />
            </div>
          )}
        </section>

        <section class="form-section" aria-labelledby="sec-access">
          <h2 id="sec-access">Accès et files</h2>
          {features.easyAccess ? (
          <>
          <label class="toggle">
            <input
              type="checkbox"
              checked={draft.easyAccess}
              aria-describedby={draft.easyAccess ? 'easy-hint' : undefined}
              onChange={(e) => set('easyAccess', (e.target as HTMLInputElement).checked)}
            />
            <span>Une personne a la Carte Facilité (ALD)</span>
          </label>
          {draft.easyAccess && (
            <p class="hint field-nested" id="easy-hint">
              Le titulaire s'inscrit à l'entrée Premier Access d'une attraction et reçoit une heure de retour égale à l'attente ; une seule inscription à la fois. Le
              plan occupe ce délai avec d'autres attractions en file normale. Le titulaire passe avec 4 accompagnateurs au plus, enfants compris.
              {othersOf(draft) > 0 && ` Les ${othersOf(draft)} autres personnes font chaque attraction de leur côté et vous retrouvent à la sortie.`}
            </p>
          )}
          </>
          ) : (
            <p class="hint">Accès des personnes handicapées : chaque parc a son propre dispositif. Renseignez-vous à l’accueil de {resort.def.name} ; le plan compte ici l’attente normale.</p>
          )}

          <label class="toggle">
            <input
              type="checkbox"
              checked={draft.singleRiderOk && singleRiderOffered(draft)}
              disabled={!singleRiderOffered(draft)}
              aria-describedby={singleRiderOffered(draft) ? undefined : 'sr-hint'}
              onChange={(e) => set('singleRiderOk', (e.target as HTMLInputElement).checked)}
            />
            <span>
              {draft.hasChild && othersOf(draft) > 0 ? `Les ${othersOf(draft)} personnes hors carte acceptent la file Single Rider` : "Accepter d'être séparés (file Single Rider)"}
            </span>
          </label>
          {!singleRiderOffered(draft) && (
            <p class="hint field-nested" id="sr-hint">
              Jamais proposé quand un enfant est dans le groupe, sauf pour les personnes hors Carte Facilité.
            </p>
          )}

          {features.emh && (
            <>
              <label class="toggle">
                <input type="checkbox" checked={draft.emhAccess} aria-describedby="emh-hint" onChange={(e) => set('emhAccess', (e.target as HTMLInputElement).checked)} />
                <span>Accès aux Heures de Magie en Plus</span>
              </label>
              <p class="hint field-nested" id="emh-hint">
                Hôtels Disney et certains pass annuels : accès à quelques attractions avant l'ouverture officielle, selon les horaires publiés du jour.
              </p>
            </>
          )}

          <div class="field">
            <label for="budget">{isDlp ? 'Budget Premier Access par personne (€)' : 'Budget coupe-file payant par personne (€)'}</label>
            <input
              id="budget"
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              value={draft.budget}
              aria-invalid={errorOf('budget') ? 'true' : undefined}
              aria-describedby={errorOf('budget') ? 'budget-error budget-hint' : 'budget-hint'}
              onInput={(e) => set('budget', (e.target as HTMLInputElement).value)}
            />
            <span class="hint" id="budget-hint">
              0 : aucun conseil d'achat.
            </span>
            <FieldError id="budget-error" text={errorOf('budget')} />
          </div>
        </section>

        <section class="form-section" aria-labelledby="sec-day">
          <h2 id="sec-day">Rythme de la journée</h2>
          {parks.length > 1 && (
            <fieldset>
              <legend>Parc de départ</legend>
              <div class="segmented joined">
                {parks.map((p, i) => (
                  <label key={p.id}>
                    <input
                      type="radio"
                      name="start-park"
                      checked={draft.startPark === p.id || (i === 0 && !parks.some((x) => x.id === draft.startPark))}
                      onChange={() => set('startPark', p.id)}
                    />
                    <span>{p.short}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend>Rythme de marche</legend>
            <div class="segmented joined">
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

          {(['lunch', 'dinner'] as const).map((slot) => (
            <MealFields
              key={slot}
              slot={slot}
              meal={draft.meals[slot]}
              error={errorOf(`${slot}At`)}
              onChange={(meal) => set('meals', { ...draft.meals, [slot]: meal })}
            />
          ))}
        </section>

        <div class="form-submit">
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
        Temps d'attente en direct fournis par <ExternalLink href="https://themeparks.wiki/">ThemeParks.wiki</ExternalLink> ; plans et lieux © les contributeurs{' '}
        <ExternalLink href="https://www.openstreetmap.org/copyright">OpenStreetMap</ExternalLink>. Application indépendante, non affiliée aux parcs proposés. Tailles minimales, durées,
        horaires et positions sont indicatifs : vérifiez-les sur place ou sur le <ExternalLink href={resort.def.site}>site officiel de {resort.def.name}</ExternalLink>.
      </p>
    </div>
  );
}
