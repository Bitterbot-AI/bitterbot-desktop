import type { BitterbotConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CronEngine, type CronEngineOptions } from "./engine.js";

const log = createSubsystemLogger("gateway/cron");
let active: CronEngine | null = null;

export function getCronEngine(): CronEngine | null {
  return active;
}

export function setCronEngineForTests(engine: CronEngine | null): void {
  active = engine;
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
  active = engine;
  return engine;
}

export async function stopCronEngine(): Promise<void> {
  if (!active) {
    return;
  }
  const current = active;
  active = null;
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
