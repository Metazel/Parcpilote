import { render } from 'preact';
import type { FetchFn } from './data/themeparks';
import { AppStore } from './state/store';
import type { StorageLike } from './state/storage';
import { createWorkerPlanner } from './state/workerPlanner';
import { App } from './ui/App';
import { StoreContext } from './ui/context';
import './ui/styles.css';

/** Anonymous requests only: no cookies, no referrer, no HTTP cache reuse for live data. */
const fetchFn: FetchFn | null =
  typeof fetch === 'function'
    ? (url, init) => fetch(url, { ...init, method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
    : null;

function safeStorage(): StorageLike {
  try {
    const probe = '__parcpilote_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    // Private mode or blocked storage: keep state in memory for this session.
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
}

// The day plan is optimised in a worker so taps and scrolling stay instant.
const planner = typeof Worker === 'function' ? createWorkerPlanner() : null;
const store = new AppStore({ storage: safeStorage(), fetchFn, realNow: () => Date.now(), planner });
store.start();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') store.tick();
});

const root = document.getElementById('app');
if (root) {
  render(
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>,
    root,
  );
}

if (__PWA__ && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined);
  });
}
