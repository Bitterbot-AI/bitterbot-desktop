/**
 * Tiny module that holds the active CronEngine reference, so consumers
 * (agent tools, schedulers) can fetch the engine without importing the
 * full engine module. The full module pulls in main-session, isolated-
 * agent, channel delivery, and (transitively) the Slack SDK, which is
 * heavy for unit tests that only want to mock the registry.
 *
 * `import type` is used for the CronEngine type so this file has no
 * runtime dependency on the engine; only the type is erased at compile.
 */

import type { CronEngine } from "./engine.js";

let active: CronEngine | null = null;

export function getCronEngine(): CronEngine | null {
  return active;
}

export function setActiveCronEngine(engine: CronEngine | null): void {
  active = engine;
}
