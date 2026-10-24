import type { PlanInput } from '../domain/planner';
import type { Plan } from '../domain/types';
import type { CompactOsm } from '../domain/walkGraph';

/** Plan input as sent to an off-thread planner: no functions (the network is sent separately). */
export type PlanRequest = Omit<PlanInput, 'network'>;

/**
 * Computes plans away from the UI thread. The store falls back to computing synchronously
 * when no client is given (tests, single-file build, browsers without module workers).
 */
export interface PlannerClient {
  plan(request: PlanRequest): Promise<Plan>;
  /** Pedestrian network for walking times, or null to use straight-line estimates. */
  setNetwork(data: CompactOsm | null): void;
}

export type WorkerRequest = { readonly type: 'plan'; readonly id: number; readonly request: PlanRequest } | { readonly type: 'network'; readonly data: CompactOsm | null };

export type WorkerResponse = { readonly type: 'plan'; readonly id: number; readonly plan: Plan } | { readonly type: 'error'; readonly id: number; readonly message: string };
