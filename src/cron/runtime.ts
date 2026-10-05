import type { BitterbotConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { notifyOwner } from "../infra/owner-notify.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getCronEngine, setActiveCronEngine } from "./active.js";
import { CronEngine, type CronEngineEvent, type CronEngineOptions } from "./engine.js";
import { jobToWire } from "./normalize.js";
import { ownerNoticeForCronEvent } from "./notices.js";

const log = createSubsystemLogger("gateway/cron");

// Re-export the registry getters so existing callers don't break.
export { getCronEngine };

export function setCronEngineForTests(engine: CronEngine | null): void {
  setActiveCronEngine(engine);
}

let cronBroadcast: ((payload: unknown) => void) | null = null;

/** The gateway installs its broadcaster so the Control UI hears about runs. */
export function setCronBroadcast(fn: ((payload: unknown) => void) | null): void {
  cronBroadcast = fn;
}

/**
 * Every finished run goes to the UI. A failure the owner should know about
 * (the start of a streak, a job turned off, a one-shot that gave up) also
 * goes to them. Before this a job could fail for weeks with nobody told.
 */
function handleCronEvent(event: CronEngineEvent): void {
  try {
    cronBroadcast?.({
      kind: event.kind,
      run: event.run,
      job: event.job ? jobToWire(event.job) : null,
    });
  } catch (err) {
    log.debug(`cron broadcast failed: ${formatErr(err)}`);
  }
  const notice = ownerNoticeForCronEvent(event);
  if (notice) {
    void notifyOwner(notice).catch((err) => log.warn(`owner notice failed: ${formatErr(err)}`));
  }
}

export function buildEngineOptions(cfg: BitterbotConfig): CronEngineOptions {
  const cron = cfg.cron ?? {};
  const enabled = cron.enabled !== false && !isTruthyEnvValue(process.env.BITTERBOT_SKIP_CRON);
  return {
    enabled,
    storePath: cron.store,
    maxConcurrentRuns: cron.maxConcurrentRuns,
    webhook: cron.webhook,
    webhookToken: cron.webhookToken,
    autoDisableAfterErrors: cron.autoDisableAfterErrors,
    onEvent: handleCronEvent,
  };
}

export async function startCronEngine(cfg: BitterbotConfig): Promise<CronEngine | null> {
  await stopCronEngine();
  const opts = buildEngineOptions(cfg);
  if (!opts.enabled) {
    log.info("cron engine skipped (disabled in config or BITTERBOT_SKIP_CRON=1)");
    return null;
  }
  const engine = new CronEngine(opts);
  try {
    await engine.start();
  } catch (err) {
    log.warn(`cron engine failed to start: ${formatErr(err)}`);
    return null;
  }
  setActiveCronEngine(engine);
  return engine;
}

export async function stopCronEngine(): Promise<void> {
  const current = getCronEngine();
  if (!current) return;
  setActiveCronEngine(null);
  try {
    await current.stop();
  } catch (err) {
    log.warn(`cron engine failed to stop cleanly: ${formatErr(err)}`);
  }
}

export async function restartCronEngine(cfg: BitterbotConfig): Promise<CronEngine | null> {
  return startCronEngine(cfg);
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
