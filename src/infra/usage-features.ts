/**
 * PLAN-50: the attribution vocabulary for the usage ledger.
 *
 * `feature` answers "what was this token spent on?" at the granularity an
 * operator reasons about: a chat turn, a cron job, a dream cycle, a memory
 * search, an embedding backfill. Names follow the subsystem-logger convention
 * (`memory/embeddings`, `tasks/judge-provider`) so the ledger and the logs share
 * one vocabulary.
 */

import {
  isA2aTaskSessionKey,
  isAcpSessionKey,
  isCronSessionKey,
  isSkillEvolveValidationSessionKey,
  isSubagentSessionKey,
} from "../sessions/session-key-utils.js";

export const USAGE_FEATURES = {
  agentTurn: "agent/turn",
  agentSubagent: "agent/subagent",
  agentCron: "agent/cron",
  agentHeartbeat: "agent/heartbeat",
  agentA2a: "agent/a2a",
  agentAcp: "agent/acp",
  agentCliBackend: "agent/cli-backend",
  agentContinuityGate: "agent/continuity-gate",
  skillsEvolution: "skills/evolution",
  memorySearch: "memory/search",
  memoryRecall: "memory/recall",
  memoryIndex: "memory/index",
  memoryIndexBatch: "memory/index-batch",
  memoryDream: "memory/dream",
  memoryExtraction: "memory/extraction",
  memoryProbe: "memory/probe",
  memoryEmbeddings: "memory/embeddings",
  memoryPlanner: "memory/planner",
  memoryArchitect: "memory/architect",
  memoryMarketability: "memory/marketability",
  memoryDiscovery: "memory/discovery",
  tasksJudge: "tasks/judge",
  rlmDeepRecall: "rlm/deep-recall",
  ttsSummary: "tts/summary",
  mediaImage: "media/image",
} as const;

export type UsageFeature = (typeof USAGE_FEATURES)[keyof typeof USAGE_FEATURES] | (string & {});

/** Background lanes that a budget in `enforce` mode is allowed to pause. */
export const BACKGROUND_USAGE_FEATURES: ReadonlySet<string> = new Set([
  USAGE_FEATURES.memoryDream,
  USAGE_FEATURES.memoryExtraction,
  USAGE_FEATURES.memoryMarketability,
  USAGE_FEATURES.memoryDiscovery,
  USAGE_FEATURES.skillsEvolution,
]);

/**
 * Classify an embedded-runner session by its session key. Heartbeats are not
 * encoded in the key, so callers that know pass `isHeartbeat`.
 */
export function classifyAgentFeature(
  sessionKey: string | undefined | null,
  opts?: { isHeartbeat?: boolean },
): string {
  if (opts?.isHeartbeat) {
    return USAGE_FEATURES.agentHeartbeat;
  }
  if (!sessionKey) {
    return USAGE_FEATURES.agentTurn;
  }
  if (isSkillEvolveValidationSessionKey(sessionKey)) {
    return USAGE_FEATURES.skillsEvolution;
  }
  if (isSubagentSessionKey(sessionKey)) {
    return USAGE_FEATURES.agentSubagent;
  }
  if (isCronSessionKey(sessionKey)) {
    return USAGE_FEATURES.agentCron;
  }
  if (isAcpSessionKey(sessionKey)) {
    return USAGE_FEATURES.agentAcp;
  }
  if (isA2aTaskSessionKey(sessionKey)) {
    return USAGE_FEATURES.agentA2a;
  }
  return USAGE_FEATURES.agentTurn;
}

/** Human label for a feature id, used by the CLI and UI. */
export function describeUsageFeature(feature: string): string {
  switch (feature) {
    case USAGE_FEATURES.agentTurn:
      return "Chat turns";
    case USAGE_FEATURES.agentSubagent:
      return "Subagents";
    case USAGE_FEATURES.agentCron:
      return "Cron jobs";
    case USAGE_FEATURES.agentHeartbeat:
      return "Heartbeats";
    case USAGE_FEATURES.agentA2a:
      return "Agent-to-agent";
    case USAGE_FEATURES.agentAcp:
      return "ACP sessions";
    case USAGE_FEATURES.agentCliBackend:
      return "CLI-backed models";
    case USAGE_FEATURES.agentContinuityGate:
      return "Session continuity gate";
    case USAGE_FEATURES.skillsEvolution:
      return "Skill evolution";
    case USAGE_FEATURES.memorySearch:
      return "Memory search (embeddings)";
    case USAGE_FEATURES.memoryRecall:
      return "Proactive recall (embeddings)";
    case USAGE_FEATURES.memoryIndex:
      return "Memory indexing (embeddings)";
    case USAGE_FEATURES.memoryIndexBatch:
      return "Memory indexing, batch API (embeddings)";
    case USAGE_FEATURES.memoryDream:
      return "Dream engine";
    case USAGE_FEATURES.memoryExtraction:
      return "Session fact extraction";
    case USAGE_FEATURES.memoryProbe:
      return "Embedding health probe";
    case USAGE_FEATURES.memoryEmbeddings:
      return "Embeddings (other)";
    case USAGE_FEATURES.memoryPlanner:
      return "Memory query planner";
    case USAGE_FEATURES.memoryArchitect:
      return "Memory architect";
    case USAGE_FEATURES.memoryMarketability:
      return "Skill marketability";
    case USAGE_FEATURES.memoryDiscovery:
      return "Discovery agent";
    case USAGE_FEATURES.tasksJudge:
      return "Task judge";
    case USAGE_FEATURES.rlmDeepRecall:
      return "Deep recall (RLM)";
    case USAGE_FEATURES.ttsSummary:
      return "TTS summaries";
    case USAGE_FEATURES.mediaImage:
      return "Image understanding";
    default:
      return feature;
  }
}
