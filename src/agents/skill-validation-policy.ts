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

/**
 * PLAN-45 2.3 (D-2): exec is ON by default in validation. Parity with
 * production (where the agent has a shell) is worth more than the residual
 * risk of a confined, approval-free, env-scrubbed shell over a scratch
 * workspace; `validationTools.exec: false` turns it off.
 */
export function validationExecEnabled(cfg?: BitterbotConfig): boolean {
  return cfg?.skills?.evolution?.validationTools?.exec !== false;
}

/**
 * PLAN-45 2.3: binaries a validation shell may run without an approval
 * prompt (the allowlist floor was jq/grep/cut/sort/uniq/head/tail/tr/wc,
 * which refused `echo`, `sha1sum` and `base64`, so the exec canonical tasks
 * tied in both arms). NO interpreters and NO network clients (adversarial
 * H2: `python3 -c`, `node -e`, `awk 'BEGIN{system(...)}'` are one-token
 * escapes to the network with the gateway user's files readable). The safe
 * bin rule also refuses arguments that name existing files, so task files
 * are read with the read tool; the shell serves the exec regression tasks.
 * Host egress is not isolated; PLAN-45 Phase 4 records and refuses it.
 */
export const SKILL_VALIDATION_SAFE_BINS = [
  "jq",
  "grep",
  "cut",
  "sort",
  "uniq",
  "head",
  "tail",
  "tr",
  "wc",
  "echo",
  "printf",
  "sha1sum",
  "sha256sum",
  "md5sum",
  "base64",
  "date",
  "true",
  "false",
] as const;

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
