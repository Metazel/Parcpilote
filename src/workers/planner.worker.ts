/// <reference lib="webworker" />
import { computePlan } from '../domain/planner';
import { WalkGraph } from '../domain/walkGraph';
import type { WorkerRequest, WorkerResponse } from '../state/planner';

/** Planner worker: keeps the UI thread free while the day plan is optimised. */
let graph: WalkGraph | null = null;

const post = (msg: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'network') {
    graph = msg.data && msg.data.lat.length >= 20 ? new WalkGraph(msg.data) : null;
    return;
  }
  try {
    const g = graph;
    const plan = computePlan({ ...msg.request, network: g ? (a, b) => g.distanceM(a, b) : undefined });
    post({ type: 'plan', id: msg.id, plan });
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : 'planner error' });
  }
});
