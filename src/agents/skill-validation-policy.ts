/**
 * PLAN-44 Phase 2 (D-4): the tool policy for skill-evolution VALIDATION
 * sessions (`agent:<id>:skill-evolve-val-<nonce>`).
 *
 * PLAN-43 §3.2b gave these sessions the A2A remote floor — no tools at all
 * — because peer-authored skill text executes in them. That floor also
 * made tasks-mode validation meaningless: the runtime pathway needs the
 * `read` tool to open SKILL.md. This policy replaces the floor for the
 * node's OWN candidate validations only: an explicit ALLOW list of
 * workspace-scoped file tools; `exec`/`process` only when the operator
 * opts in (`skills.evolution.validationTools.exec: true`), and then with
 * approvals off, a scrubbed environment and a workdir confined to the
 * scratch workspace (adversarial C1: candidate text is proposer-authored
 * from untrusted traces and must never get an unconfined host shell).
 * Peer skills (attestation sweep) keep the A2A floor via the `peer-`
 * session flavor. `tools.fs.workspaceOnly` is forced on for these sessions
 * in pi-tools.ts.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { A2A_REMOTE_TOOL_DENY_ALWAYS } from "./a2a-remote-policy.js";

/** File tools a validation rollout may always use (workspace-scoped). */
export const SKILL_VALIDATION_TOOL_ALLOW = ["read", "write", "edit", "apply_patch"] as const;
/** Shell tools, granted only with `skills.evolution.validationTools.exec: true`. */
export const SKILL_VALIDATION_SHELL_TOOLS = ["exec", "process"] as const;

const FS_AND_SHELL = new Set(["group:runtime", "apply_patch", "shell", "bash"]);

/**
 * Defence in depth: the A2A remote floor's always-deny list minus the file
 * and shell entries this policy manages explicitly. Never grantable to a
 * validation session, even by config.
 */
export const SKILL_VALIDATION_TOOL_DENY_ALWAYS = A2A_REMOTE_TOOL_DENY_ALWAYS.filter(
  (t) => !FS_AND_SHELL.has(t),
);

export function validationExecEnabled(cfg?: BitterbotConfig): boolean {
  return cfg?.skills?.evolution?.validationTools?.exec === true;
}

export function resolveSkillValidationToolPolicy(cfg?: BitterbotConfig): SandboxToolPolicy {
  const configured = cfg?.skills?.evolution?.validationTools;
  const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : [];
  return {
    allow: [
      ...SKILL_VALIDATION_TOOL_ALLOW,
      ...(validationExecEnabled(cfg) ? SKILL_VALIDATION_SHELL_TOOLS : []),
      ...alsoAllow,
    ],
    deny: [
      ...SKILL_VALIDATION_TOOL_DENY_ALWAYS,
      ...(validationExecEnabled(cfg) ? [] : ["group:runtime"]),
    ],
  };
}
