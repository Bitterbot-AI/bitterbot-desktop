/**
 * PLAN-52 Phase 4: build the owned session from the gateway config, the way
 * the embedded runner needs it.
 *
 * The caller still installs the stream function stack on `session.agent`
 * (provider runtime, extra params, tracing, request auth); compaction
 * summaries then take the same path as turns.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { BitterbotConfig } from "../../../config/config.js";
import { resolveAgentCompaction } from "../compaction/agent-config.js";
import { resolveHeartbeatPromptSet } from "../compaction/heartbeat.js";
import { createOffloadCompactionPolicy } from "../compaction/offload-compaction.js";
import { resolveOffloadSettings } from "../compaction/offload-policy.js";
import type { CompactionPolicy } from "../compaction/policy.js";
import { createSummaryCompactionPolicy } from "../compaction/summary-policy.js";
import type { AnyAgentTool, ThinkingLevel } from "../loop/index.js";
import { resolveCompactionReserveTokensFloor } from "./compaction-reserve.js";
import {
  AgentSession,
  DEFAULT_SESSION_SETTINGS,
  type RequestAuthResult,
  type SessionStore,
} from "./session.js";

export const DEFAULT_OFFLOAD_SUMMARY_MODEL = "anthropic/claude-haiku-4-5";

export type CreateOwnedSessionParams = {
  config?: BitterbotConfig;
  /** The agent the session belongs to, for per-agent compaction settings. */
  agentId?: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  /** Already wrapped for the runtime (`toRuntimeTools`), in the order sent to the model. */
  tools: AnyAgentTool[];
  /** The guarded transcript store of this run. */
  store: SessionStore;
  resolveRequestAuth: (model: Model<Api>) => Promise<RequestAuthResult>;
  /** Looks up a model by provider and id (for the cheap offload summary). */
  findModel?: (provider: string, modelId: string) => Model<Api> | undefined;
  log?: (message: string) => void;
};

function estimateToolTokens(tools: readonly AnyAgentTool[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars += tool.name.length + (tool.description?.length ?? 0);
    try {
      chars += JSON.stringify(tool.parameters ?? {}).length;
    } catch {
      // A schema that does not serialize contributes nothing to the estimate.
    }
  }
  return Math.ceil(chars / 4);
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return undefined;
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** The compaction policy the config selects for this agent. */
export function resolveCompactionPolicy(params: {
  config?: BitterbotConfig;
  agentId?: string;
  store: SessionStore;
  fixedTokens: () => number;
  findModel?: (provider: string, modelId: string) => Model<Api> | undefined;
  log?: (message: string) => void;
}): CompactionPolicy {
  const summary = createSummaryCompactionPolicy();
  const compaction = resolveAgentCompaction(params.config, params.agentId);
  if (compaction.policy !== "offload") {
    return summary;
  }
  const offload = compaction.offload;
  const summaryRef = parseModelRef(offload?.summaryModel ?? DEFAULT_OFFLOAD_SUMMARY_MODEL);
  return createOffloadCompactionPolicy({
    settings: resolveOffloadSettings(offload),
    summaryMode: offload?.summary ?? "always",
    summaryModel: () =>
      summaryRef ? params.findModel?.(summaryRef.provider, summaryRef.modelId) : undefined,
    sessionFile: () => params.store.getSessionFile(),
    sessionId: () => params.store.getSessionId(),
    heartbeatPrompts: resolveHeartbeatPromptSet(params.config),
    fixedTokens: params.fixedTokens,
    fallback: summary,
    log: params.log,
  });
}

export function createOwnedSession(params: CreateOwnedSessionParams): AgentSession {
  // The session is referenced by the policy's size estimate, which only runs
  // after construction.
  const holder: { session?: AgentSession } = {};
  const fixedTokens = () => {
    const session = holder.session;
    if (!session) {
      return 0;
    }
    return (
      Math.ceil(session.systemPrompt.length / 4) + estimateToolTokens(session.agent.state.tools)
    );
  };
  const session = new AgentSession({
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    systemPrompt: params.systemPrompt,
    tools: params.tools,
    store: params.store,
    settings: {
      compaction: {
        // Floor from `agents.defaults.compaction.reserveTokensFloor`.
        reserveTokens: Math.max(
          DEFAULT_SESSION_SETTINGS.compaction.reserveTokens,
          resolveCompactionReserveTokensFloor(params.config),
        ),
      },
    },
    resolveRequestAuth: params.resolveRequestAuth,
    compactionPolicy: resolveCompactionPolicy({
      config: params.config,
      agentId: params.agentId,
      store: params.store,
      fixedTokens,
      findModel: params.findModel,
      log: params.log,
    }),
    onListenerError: (error, event) => {
      params.log?.(`session listener failed on ${event.type}: ${String(error)}`);
    },
    onPersistenceError: (error) => {
      params.log?.(`transcript write failed: ${String(error)}`);
    },
  });
  holder.session = session;
  return session;
}
