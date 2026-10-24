import type { Plan } from '../domain/types';
import type { PlannerClient, PlanRequest, WorkerRequest, WorkerResponse } from './planner';

/** Planner running in a module worker; null when the browser cannot start one. */
export function createWorkerPlanner(): PlannerClient | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module', name: 'planner' });
  } catch {
    return null;
  }
  let nextId = 1;
  const pending = new Map<number, { resolve: (p: Plan) => void; reject: (e: Error) => void }>();
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'plan') p.resolve(msg.plan);
    else p.reject(new Error(msg.message));
  });
  worker.addEventListener('error', () => {
    for (const p of pending.values()) p.reject(new Error('planner worker failed'));
    pending.clear();
  });
  const send = (msg: WorkerRequest) => worker.postMessage(msg);
  return {
    plan(request: PlanRequest): Promise<Plan> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: 'plan', id, request });
      });
    },
    setNetwork(data) {
      send({ type: 'network', data });
    },
  };
}
