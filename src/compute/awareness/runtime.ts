/**
 * PLAN-57 Phase 2: the pieces the `compute` tool needs beyond the backend
 * when it submits work: the durable delivery store (to record who started
 * a job) and the watcher (to resume polling at once). The plugin registers
 * them after it starts the watcher; without them the tool stays read-only.
 */

import type { ComputeDeliveryStore } from "./deliveries.js";
import type { ComputeWatcher } from "./watcher.js";

export type ComputeRuntime = {
  store: ComputeDeliveryStore;
  watcher: ComputeWatcher | null;
};

let runtime: ComputeRuntime | null = null;

export function registerComputeRuntime(next: ComputeRuntime | null): void {
  runtime = next;
}

export function getComputeRuntime(): ComputeRuntime | null {
  return runtime;
}

export function resetComputeRuntimeForTest(): void {
  runtime = null;
}
