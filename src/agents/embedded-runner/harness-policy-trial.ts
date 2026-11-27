// PLAN-64 Phase 6: per-trial harness policy for replay evaluation.
//
// Harness evolution judges a candidate policy by re-running verifiable tasks
// under the baseline policy and under the candidate. A trial turn therefore
// has to run with a policy that is NOT the live one on disk. This registry is
// the only way to do that, and it is deliberately narrow:
//
//   - process-local: only code inside this gateway process can register;
//   - keyed by the trial's scratch workspace, the same handle the trial runner
//     already registers for the workspace override and the egress record;
//   - honoured only for skill-evolution validation sessions, which run with the
//     restricted validation tool policy in a scratch workspace;
//   - bounded, and cleared by the runner when the trial ends.
//
// A normal turn never consults a registered policy: its workspace is not a
// registered trial directory and its session key is not a validation key.

import path from "node:path";
import { isSkillEvolveValidationSessionKey } from "../../sessions/session-key-utils.js";
import type { HarnessPolicy } from "./harness-policy.js";

const policyByWorkspace = new Map<string, HarnessPolicy>();
const MAX_TRACKED = 64;

/** Bind a harness policy to one trial workspace. The caller must clear it. */
export function registerTrialHarnessPolicy(workspaceDir: string, policy: HarnessPolicy): void {
  policyByWorkspace.set(path.resolve(workspaceDir), policy);
  if (policyByWorkspace.size > MAX_TRACKED) {
    const oldest = policyByWorkspace.keys().next().value;
    if (oldest !== undefined) {
      policyByWorkspace.delete(oldest);
    }
  }
}

export function clearTrialHarnessPolicy(workspaceDir: string): void {
  policyByWorkspace.delete(path.resolve(workspaceDir));
}

/**
 * The policy a trial turn must run under, or null for every other turn. Null
 * means "use the active policy" (config baseline plus the promoted evolution).
 */
export function resolveTrialHarnessPolicy(params: {
  workspaceDir: string | undefined;
  sessionKey: string | undefined | null;
}): HarnessPolicy | null {
  if (!params.workspaceDir || !isSkillEvolveValidationSessionKey(params.sessionKey)) {
    return null;
  }
  return policyByWorkspace.get(path.resolve(params.workspaceDir)) ?? null;
}
