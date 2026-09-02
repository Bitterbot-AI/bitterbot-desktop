/**
 * PLAN-43 §3.2b: the remote-caller tool floor for inbound A2A task sessions.
 *
 * An A2A task executes an agent turn on THIS host driven by an EXTERNAL
 * caller's input — a remote-code-execution surface when that turn holds
 * host tools. The floor makes such a turn hermetic at the tool layer:
 *
 *  - Default toolset is EMPTY (`allow: []` fails closed in the policy
 *    matcher): a paid/remote invocation is a pure model turn over the
 *    prompt unless the operator explicitly grants tools.
 *  - The operator can extend via `a2a.remoteExecution.tools.allow`, but the
 *    hardcoded always-deny below is applied as a deny list — deny wins in
 *    the matcher — so wallet/shell/session/egress tools can NEVER be
 *    granted back to a remote caller, by config or otherwise (invariant I9).
 *
 * This floor is intersected with, never unioned into, every other policy:
 * it runs as one more step of the tool-policy pipeline, where each step can
 * only narrow the surviving set. The Docker session sandbox
 * (agents.defaults.sandbox) remains the optional hard process boundary on
 * top of this; the floor does not depend on it.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { SandboxToolPolicy } from "./sandbox.js";

/**
 * Tools a remote A2A caller's turn may NEVER hold, regardless of operator
 * config. Glob patterns; groups expand via expandToolGroups.
 */
export const A2A_REMOTE_TOOL_DENY_ALWAYS = [
  // Money.
  "wallet",
  "a2a_*", // incl. a2a_client: a remote caller must not spend this node's funds
  // Host shell / process (group:runtime = exec + process).
  "group:runtime",
  "shell",
  "bash",
  "apply_patch",
  // Privilege escalation: spawning/steering other sessions escapes the floor.
  "gateway",
  "sessions_*",
  "subagents",
  "agents_list",
  "session_status",
  // Persistence and fleet control.
  "cron",
  "nodes",
  "network_status", // peer table incl. peer wallet addresses
  "skill_*", // skill_manage, skill_seekers_ingest, skill_pipeline_digest, ...
  // Egress and host control surfaces.
  "browser*",
  "computer_use",
  "message",
  "whatsapp_login",
  "tts",
  "canvas*",
  "web_search",
  "web_fetch",
  "image*",
  "code_interpreter",
  // Node state: reading is exfiltration, writing is poisoning.
  "memory_*",
  "deep_recall",
  "*emotional_anchor*",
  "expand_message", // reads the process-global truncated-originals cache
  "*artifact*", // writes attacker HTML/JS into the owner's Control UI panel
  "dream_*",
  "curiosity_*",
  "forage*",
  "circle*",
  "task_*",
] as const;

/**
 * Resolve the effective remote-caller tool policy: the operator's
 * `a2a.remoteExecution.tools` extends the (empty) default allowlist and the
 * deny side, but can never override the always-deny floor.
 */
export function resolveA2aRemoteToolPolicy(cfg?: BitterbotConfig): SandboxToolPolicy {
  const configured = cfg?.a2a?.remoteExecution?.tools;
  const allow = Array.isArray(configured?.allow) ? [...configured.allow] : [];
  const deny = [
    ...A2A_REMOTE_TOOL_DENY_ALWAYS,
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  return { allow, deny };
}
