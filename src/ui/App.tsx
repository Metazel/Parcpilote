import type { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatHM } from '../domain/time';
import type { AppState } from '../state/store';
import { useAppState, useStore } from './context';
import type { Tab } from './context';
import { BrandMark, IconGroup, IconList, IconMap, IconNow, IconRoute } from './components/Icons';
import { ReportDialog } from './components/ReportDialog';
import { ListScreen } from './screens/ListScreen';
import { NowScreen } from './screens/NowScreen';
import { PlanScreen } from './screens/PlanScreen';
import { ProfileScreen } from './screens/ProfileScreen';

const TABS: ReadonlyArray<{ id: Tab; label: string; Icon: typeof IconNow }> = [
  { id: 'now', label: 'Maintenant', Icon: IconNow },
  { id: 'plan', label: 'Plan', Icon: IconRoute },
  { id: 'list', label: 'Ma liste', Icon: IconList },
  { id: 'map', label: 'Carte', Icon: IconMap },
  { id: 'profile', label: 'Groupe', Icon: IconGroup },
];

const STATUS_LABEL: Readonly<Record<AppState['data']['mode'], string>> = {
  live: 'En direct',
  offline: 'Hors-ligne',
  demo: 'Démo',
  manual: 'Estimé',
  unavailable: 'Indisponible',
};

function StatusLine() {
  const { data, now } = useAppState();
  const label = data.state === 'loading' ? 'Connexion…' : STATUS_LABEL[data.mode];
  return (
    <p class="status" aria-live="polite">
      <span class={`status-dot ${data.mode}`} aria-hidden="true" />
      <span>
        {label}, <span class="num">{formatHM(now)}</span>
        {data.mode === 'demo' && <span class="visually-hidden"> (heure simulée)</span>}
      </span>
    </p>
  );
}

function Alerts() {
  const store = useStore();
  const { alerts } = useAppState();
  return (
    <div class="alerts" role="region" aria-label="Alertes" aria-live="polite">
      {alerts.map((a) => (
        <div key={a.id} class={`alert ${a.level}`}>
          <span>
            <span class="num muted">{formatHM(a.at)}</span> {a.text}
          </span>
          <button type="button" aria-label="Masquer l'alerte" onClick={() => store.dismissAlert(a.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function useGps(enabled: boolean) {
  const store = useStore();
  useEffect(() => {
    if (!enabled || !('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => store.updateGps(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      () => store.gpsUnavailable(),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled, store]);
}

type MapScreenProps = { report: (id: string) => void };

/** The map (Leaflet) is loaded on first visit to the tab, keeping the first paint light. */
function LazyMap(props: MapScreenProps) {
  const [Screen, setScreen] = useState<ComponentType<MapScreenProps> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('./screens/MapScreen')
      .then((m) => alive && setScreen(() => m.MapScreen))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);
  if (failed) return <p class="banner">La carte n'a pas pu être chargée. Vérifiez la connexion puis rouvrez l'onglet.</p>;
  return Screen ? <Screen {...props} /> : <p class="muted" role="status">Chargement de la carte…</p>;
}

export function App() {
  const state = useAppState();
  const [tab, setTab] = useState<Tab>('now');
  const [reportId, setReportId] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useGps(state.persisted.settings.useGps);

  const onboarding = state.persisted.profile === null;
  const viewLabel = onboarding ? 'Votre groupe' : (TABS.find((t) => t.id === tab)?.label ?? '');

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
    window.scrollTo(0, 0);
  }, [tab]);

  // Each view has its own page title (RGAA 8.6).
  useEffect(() => {
    document.title = `${viewLabel} – ParcPilote`;
  }, [viewLabel]);

  return (
    <div class={`app${onboarding ? ' app-onboarding' : ''}`}>
      <div class="skip-links">
        <a href="#contenu">Aller au contenu</a>
        {!onboarding && <a href="#navigation">Aller à la navigation</a>}
      </div>
      <header class="topbar">
        <span class="brand">
          <BrandMark class="brand-mark" />
          ParcPilote
        </span>
        <StatusLine />
      </header>
      {!onboarding && (
        <nav class="tabbar" id="navigation" aria-label="Navigation principale">
          <ul>
            {TABS.map(({ id, label, Icon }) => (
              <li key={id}>
                <button type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
                  <Icon />
                  <span>{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <main ref={mainRef} id="contenu" tabIndex={-1} aria-label={viewLabel}>
        {state.data.message && (
          <p class="banner" role="status">
            {state.data.message}
          </p>
        )}
        {!onboarding && <Alerts />}
        {onboarding ? (
          <ProfileScreen onboarding onDone={() => setTab('list')} />
        ) : tab === 'now' ? (
          <NowScreen go={setTab} report={setReportId} />
        ) : tab === 'plan' ? (
          <PlanScreen go={setTab} />
        ) : tab === 'list' ? (
          <ListScreen />
        ) : tab === 'map' ? (
          <LazyMap report={setReportId} />
        ) : (
          <ProfileScreen onboarding={false} onDone={() => undefined} />
        )}
      </main>
      <ReportDialog placeId={reportId} onClose={() => setReportId(null)} />
    </div>
  );
}
