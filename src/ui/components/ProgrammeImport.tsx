import { useRef, useState } from 'preact/hooks';
import { PROGRAMME_MAX_CHARS, type Programme, isEmptyProgramme, parseProgramme } from '../../data/programme';
import { useAppState, useStore } from '../context';
import { ExternalLink } from './ExternalLink';

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const list = (times: readonly number[]) => times.map(hm).join(', ');

interface Row {
  readonly key: string;
  readonly label: string;
  /** Unknown shows are added only if the visitor ticks them. */
  readonly preset: boolean;
}

function rows(p: Programme): Array<{ title: string; items: Row[] }> {
  const groups: Array<{ title: string; items: Row[] }> = [
    { title: 'Horaires du parc', items: p.hours ? [{ key: 'h', label: `Ouvert de ${hm(p.hours.open)} à ${hm(p.hours.close)}`, preset: true }] : [] },
    { title: 'Séances', items: p.shows.map((s) => ({ key: `s:${s.id}`, label: `${s.name}\u00a0: ${list(s.times)}`, preset: true })) },
    { title: 'Spectacles absents de votre liste', items: p.newShows.map((s, i) => ({ key: `n:${i}`, label: `${s.name}\u00a0: ${list(s.times)}`, preset: false })) },
    { title: 'Attentes affichées', items: p.waits.map((w) => ({ key: `w:${w.id}`, label: `${w.name}\u00a0: ${w.min} min`, preset: true })) },
    { title: 'Attractions fermées', items: p.closed.map((c) => ({ key: `c:${c.id}`, label: c.name, preset: true })) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Manual mode: the visitor pastes the text of the day's programme (copied from a photo by the
 * phone's own text recognition), checks what was read, and adds it to the day.
 */
export function ProgrammeImport() {
  const store = useStore();
  const { catalog, resort } = useAppState();
  const def = resort.def;
  const [text, setText] = useState('');
  const [result, setResult] = useState<Programme | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const previewTitle = useRef<HTMLHeadingElement>(null);

  const analyse = (e: Event) => {
    e.preventDefault();
    const places = [...catalog.values()].map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
    const p = parseProgramme(text, places);
    if (text.trim() === '') {
      setResult(null);
      setMessage({ ok: false, text: 'Collez d’abord le texte du programme.' });
      return;
    }
    if (isEmptyProgramme(p)) {
      setResult(null);
      setMessage({ ok: false, text: 'Aucun horaire, séance, attente ou fermeture reconnu. Vérifiez que le texte collé contient les noms et les heures (par exemple « Le Signe du Triomphe 14h30 »).' });
      return;
    }
    setResult(p);
    setPicked(new Set(rows(p).flatMap((g) => g.items.filter((r) => r.preset).map((r) => r.key))));
    setMessage(null);
    requestAnimationFrame(() => previewTitle.current?.focus());
  };

  const toggle = (key: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };

  const apply = (e: Event) => {
    e.preventDefault();
    if (!result) return;
    if (picked.size === 0) {
      setMessage({ ok: false, text: 'Cochez au moins une information à ajouter.' });
      return;
    }
    const n = store.importProgramme({
      hours: picked.has('h') ? result.hours : null,
      shows: result.shows.filter((s) => picked.has(`s:${s.id}`)),
      newShows: result.newShows.filter((_, i) => picked.has(`n:${i}`)),
      waits: result.waits.filter((w) => picked.has(`w:${w.id}`)),
      closed: result.closed.filter((c) => picked.has(`c:${c.id}`)).map((c) => c.id),
    });
    if (n === null) {
      setMessage({ ok: false, text: 'Import possible seulement en mode estimé.' });
      return;
    }
    setMessage(
      n === 0
        ? { ok: false, text: 'Rien de nouveau à ajouter : ces informations sont déjà dans votre journée.' }
        : { ok: true, text: `${n} ${n > 1 ? 'informations ajoutées' : 'information ajoutée'} à votre journée. Choisissez maintenant vos séances dans la liste.` },
    );
    setResult(null);
    setText('');
  };

  const groups = result ? rows(result) : [];

  return (
    <details class="programme-import">
      <summary>Importer le programme du jour</summary>
      <p class="hint" id="prog-help">
        Prenez en photo le programme ou un panneau du parc, puis copiez le texte que votre téléphone y reconnaît (iPhone : appui long sur le texte de la photo ; Android : Google Lens,
        « Texte »). Collez-le ici : il est analysé sur votre téléphone, rien n’est envoyé ni conservé à part ce que vous ajoutez.
      </p>
      <p>
        <ExternalLink href={def.programmeUrl ?? def.site}>{def.programmeUrl ? `Programme officiel de ${def.name}` : `Site officiel de ${def.name}`}</ExternalLink>
      </p>
      <form onSubmit={analyse} noValidate>
        <div class="field">
          <label for="prog-text">Texte du programme</label>
          <textarea
            id="prog-text"
            rows={6}
            maxLength={PROGRAMME_MAX_CHARS}
            autoComplete="off"
            spellcheck={false}
            aria-describedby="prog-help prog-count"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <span class="hint" id="prog-count">
            {text.length} / {PROGRAMME_MAX_CHARS} caractères
          </span>
        </div>
        <button type="submit" class="btn btn-primary">
          Analyser le texte
        </button>
      </form>

      {result && (
        <form class="programme-preview" onSubmit={apply} noValidate>
          <h3 tabIndex={-1} ref={previewTitle}>
            Informations reconnues
          </h3>
          <p class="hint">
            Décochez ce qui est mal lu. Les spectacles absents de votre liste sont ajoutés à l’entrée du parc si vous les cochez. Une fermeture compte pendant 30 minutes, comme un
            signalement.{result.truncated ? ` Seuls les ${PROGRAMME_MAX_CHARS} premiers caractères ont été lus.` : ''}
          </p>
          {groups.map((g) => (
            <fieldset key={g.title}>
              <legend>{g.title}</legend>
              {g.items.map((r) => (
                <label class="toggle" key={r.key}>
                  <input type="checkbox" checked={picked.has(r.key)} onChange={(e) => toggle(r.key, (e.target as HTMLInputElement).checked)} />
                  <span>{r.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <div class="row">
            <button type="submit" class="btn btn-primary">
              Ajouter à ma journée
            </button>
            <button type="button" class="btn btn-quiet" onClick={() => setResult(null)}>
              Annuler
            </button>
          </div>
        </form>
      )}

      <p class={message?.ok === false ? 'field-error' : 'hint'} role="status">
        {message?.text ?? ''}
      </p>
    </details>
  );
}
