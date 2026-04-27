import type { CronJob } from "./types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/cron");

// Run a main-session cron job: enqueue a system event for the agent's main
// session, then optionally trigger an immediate heartbeat run. The actual
// model call happens in the heartbeat lane.
export async function runMainSessionJob(job: CronJob): Promise<void> {
  if (job.payload.kind !== "systemEvent") {
    throw new Error('main-session jobs require payload.kind = "systemEvent"');
  }
  const cfg = loadConfig();
  const agentId = job.agentId ?? resolveDefaultAgentId(cfg);
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const text = formatEventText(job);
  enqueueSystemEvent(text, {
    sessionKey,
    contextKey: `cron:${job.jobId}`,
  });
  log.info(
    `enqueued cron systemEvent for ${job.jobId} (session=${sessionKey}, wake=${job.wakeMode})`,
  );
  if (job.wakeMode === "now") {
    requestHeartbeatNow({ reason: `cron:${job.jobId}` });
  }
}

function formatEventText(job: CronJob): string {
  if (job.payload.kind !== "systemEvent") {
    return "";
  }
  const tag = `[cron:${job.jobId}${job.name ? ` ${job.name}` : ""}]`;
  return `${tag} ${job.payload.text}`.trim();
}
