import type { PlannerClient } from './planner';

/** Single-file build: no separate worker file can be shipped, plans are computed in place. */
export function createWorkerPlanner(): PlannerClient | null {
  return null;
}
