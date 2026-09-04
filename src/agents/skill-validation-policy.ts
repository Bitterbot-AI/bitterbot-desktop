/**
 * PLAN-44 Phase 2 (D-4): the tool policy for skill-evolution VALIDATION
 * sessions (`agent:<id>:skill-evolve-val-<nonce>`).
 *
 * PLAN-43 §3.2b gave these sessions the A2A remote floor — no tools at all
 * — because peer-authored skill text executes in them. That floor also
 * made tasks-mode validation meaningless: the runtime pathway needs the
 * `read` tool to open SKILL.md, and a fifth of the canonical regression
 * suite needs a shell. This policy replaces the floor for validation
 * sessions only: an explicit ALLOW list of workspace-scoped tools, nothing
 * that reaches the network, other sessions, memory, skills, or money.
 * `tools.fs.workspaceOnly` is forced on for these sessions in pi-tools.ts,
 * so read/write/edit cannot leave the per-trial scratch workspace.
 *
 * Residual (documented, Phase 3 sandbox work): `exec` itself can reach the
 * network with curl and can `cd` elsewhere; the exec security policy
 * (no-pipe-to-shell etc.) still applies.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";

/** Tools a validation rollout may use. Everything else is refused. */
export const SKILL_VALIDATION_TOOL_ALLOW = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
] as const;

/** Defence in depth: never grantable to a validation session, even by config. */
export const SKILL_VALIDATION_TOOL_DENY_ALWAYS = [
  "group:web",
  "group:messaging",
  "group:sessions",
  "group:memory",
  "browser",
  "message",
  "skill_manage",
  "circles",
  "wallet",
  "forage",
  "gateway",
  "cron",
  "memory_pin",
  "memory_search",
  "deep_recall",
  "task_*",
  "sessions_*",
] as const;

export function resolveSkillValidationToolPolicy(cfg?: BitterbotConfig): SandboxToolPolicy {
  const configured = cfg?.skills?.evolution?.validationTools;
  const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : [];
  return {
    allow: [...SKILL_VALIDATION_TOOL_ALLOW, ...alsoAllow],
    deny: [...SKILL_VALIDATION_TOOL_DENY_ALWAYS],
  };
}
