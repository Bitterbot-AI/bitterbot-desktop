/**
 * PLAN-44 Phase 0 (D-6): the trust class of the party that authored a run's
 * task. Derived from the session key at READ time (not stored in the
 * journal) so it applies uniformly to rows written before this upgrade and
 * cannot be laundered by whatever wrote the row.
 *
 * The evolution loop learns only from `human` (first-party) and `system`
 * (cron/hook) runs: circle, A2A, subagent and guest sessions carry text
 * authored by third parties, and that text would otherwise flow into wiki
 * pattern pages and the Skill Proposer's transcript.
 */

export type RunOrigin = "human" | "system" | "circle" | "a2a" | "subagent" | "guest" | "unknown";

const CIRCLE_TOKENS = new Set(["circle", "circles", "canvas", "sandbox"]);
const GROUP_TOKENS = new Set(["group", "channel"]);

/** Classify "agent:<id>:<rest...>". Unknown shapes fail closed to "unknown". */
export function classifyRunOrigin(sessionKey: string | null | undefined): RunOrigin {
  if (!sessionKey) {
    return "unknown";
  }
  const parts = sessionKey.toLowerCase().split(":");
  if (parts.length < 2 || parts[0] !== "agent") {
    return "unknown";
  }
  const rest = parts.slice(2);
  if (rest.length === 0) {
    return "human";
  }
  for (const token of rest) {
    if (CIRCLE_TOKENS.has(token)) {
      return "circle";
    }
    if (token === "a2a" || token === "a2a-task" || token.startsWith("a2a-")) {
      return "a2a";
    }
    if (token === "subagent" || token.startsWith("subagent-")) {
      return "subagent";
    }
    if (token === "guest") {
      return "guest";
    }
    if (token === "cron" || token === "hook") {
      return "system";
    }
    if (GROUP_TOKENS.has(token)) {
      // Group/channel chats are multi-author; treat like guest content.
      return "guest";
    }
  }
  return "human";
}

/**
 * Origins whose task text the evolution loop may learn from. `unknown`
 * (no session key, or a non-"agent:" key) is admitted so pre-upgrade rows
 * and probe/test sessions keep today's behaviour; the sampler's legacy
 * session-key regexes still apply on top of this check.
 */
export function isLearnableOrigin(origin: RunOrigin): boolean {
  return origin === "human" || origin === "system" || origin === "unknown";
}
