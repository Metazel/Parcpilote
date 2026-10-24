import { useEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from '../context';
import { liveLabel } from '../format';

interface Props {
  readonly placeId: string | null;
  readonly onClose: () => void;
}

/** "Signaler": actual wait, ride closed, show full. Reports stay on the device. */
export function ReportDialog({ placeId, onClose }: Props) {
  const store = useStore();
  const state = useAppState();
  const ref = useRef<HTMLDialogElement>(null);
  const [wait, setWait] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const place = placeId ? state.catalog.get(placeId) : undefined;
  const live = placeId ? state.snapshot?.attractions[placeId] : undefined;

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (place && !dlg.open) {
      setWait('');
      setMessage(null);
      dlg.showModal();
    } else if (!place && dlg.open) {
      dlg.close();
    }
  }, [place]);

  const submitWait = (e: Event) => {
    e.preventDefault();
    if (!placeId) return;
    const n = Number(wait);
    if (wait.trim() === '' || !Number.isInteger(n) || n < 0 || n > 300) {
      setMessage('Indiquez une durée entière entre 0 et 300 minutes.');
      return;
    }
    if (store.reportWait(placeId, n)) {
      setMessage('Merci : les prochaines prévisions pour cette attraction en tiennent compte.');
    } else {
      setMessage('Pas de temps affiché actuellement pour comparer : signalement non pris en compte.');
    }
  };

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="report-title">
      {place && (
        <div>
          <h2 id="report-title" class="dialog-title">
            Signaler un écart
          </h2>
          <p>{place.name}</p>
          {place.kind === 'ride' ? (
            <>
              <p class="muted">Affiché maintenant : {liveLabel(live)}</p>
              <form onSubmit={submitWait} noValidate>
                <div class="field">
                  <label for="actual-wait">J'ai réellement attendu (minutes)</label>
                  <input
                    id="actual-wait"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={300}
                    step={1}
                    value={wait}
                    onInput={(e) => setWait((e.target as HTMLInputElement).value)}
                  />
                </div>
                <div class="row">
                  <button class="btn btn-primary" type="submit">
                    Envoyer l'attente
                  </button>
                  <button
                    class="btn"
                    type="button"
                    onClick={() => {
                      store.reportClosed(place.id);
                      setMessage('Attraction retirée du plan pendant 30 minutes.');
                    }}
                  >
                    Elle est fermée
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div class="row">
              <button
                class="btn btn-primary"
                type="button"
                onClick={() => {
                  store.reportShowFull(place.id);
                  onClose();
                }}
              >
                La salle est complète
              </button>
            </div>
          )}
          <p role="status" aria-live="polite" class="hint report-status">
            {message}
          </p>
          <p class="hint">Les signalements restent sur ce téléphone et n'améliorent que vos propres prévisions.</p>
          <button class="btn btn-quiet" type="button" onClick={onClose}>
            Fermer
          </button>
        </div>
      )}
    </dialog>
  );
}
