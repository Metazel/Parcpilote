import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { AppState, AppStore } from '../state/store';

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreContext manquant');
  return store;
}

/** Subscribes the component to store updates. */
export function useAppState(): AppState {
  const store = useStore();
  const [state, setState] = useState(store.getState());
  useEffect(() => {
    setState(store.getState());
    return store.subscribe(() => setState(store.getState()));
  }, [store]);
  return state;
}

export type Tab = 'now' | 'plan' | 'list' | 'map' | 'profile';
