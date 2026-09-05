/**
 * Failure signatures (2026-09-05 harness review, B6; after Self-Harness
 * §weakness mining).
 *
 * A failed run is clustered by the triple ⟨terminal cause, agent-causal?,
 * mechanism⟩ and two failures join a cluster only when all three agree.
 * Everything here is derived from the programmatic signals and the
 * outcome hierarchy; no model is consulted, so the clusters are
 * reproducible and cheap. The sampler counts them per iteration and the
 * iteration log persists the counts, which is what lets a maintainer (or
 * a human) tell a one-off from a recurring learnable pattern.
 */

import type { RunOutcome } from "./outcome.js";
import type { TraceSignals } from "./signals.js";
import type {
  FailureMechanism,
  FailureSignature,
  ReconstructedTrace,
  TraceLabelResult,
} from "./types.js";

export const REPEATED_CALL_BLOCK_MARKER = "REPEATED-CALL";

function mechanismForErrorClass(cls: string, scope: "env" | "agent"): FailureMechanism {
  if (scope === "env") {
    return "environment-outage";
  }
  // Class names are the ones signals.ts emits (AGENT_RULES + the shell /
  // web_fetch classifiers); anything unnamed stays an unresolved tool error.
  switch (cls) {
    case "file-not-found":
      return "missing-prerequisite";
    case "edit-mismatch":
    case "http-client":
      return "invalid-parameter";
    case "policy-block":
      return "policy-blocked";
    case "unknown-tool":
      return "unknown-tool";
    case "context-overflow":
      return "context-overflow";
    default:
      return "unresolved-tool-error";
  }
}

/**
 * Derive the signature for a fail-labeled trace. Pure. Precedence: grounded
 * negatives (human rejection, failed verification) name the mechanism
 * directly; then the loop's own runtime guard; then the terminal error.
 */
export function deriveFailureSignature(
  trace: ReconstructedTrace,
  signals: TraceSignals,
  label: TraceLabelResult,
  outcome?: RunOutcome,
): FailureSignature {
  let cause: string;
  let agentCausal: boolean;
  let mechanism: FailureMechanism;

  const lastError = signals.errors.length > 0 ? signals.errors[signals.errors.length - 1]! : null;
  const repeatedBlocked = trace.steps.some(
    (s) => s.kind === "tool" && s.isError && s.result.includes(REPEATED_CALL_BLOCK_MARKER),
  );

  if (outcome?.feedback?.verdict === "rejected") {
    cause = "human-rejected";
    agentCausal = true;
    mechanism = "human-rejected";
  } else if (outcome?.taskVerdict?.verdict === "fail") {
    cause = outcome.taskVerdict.checksTotal > 0 ? "checks-failed" : "judge-failed";
    agentCausal = true;
    mechanism = "verification-failed";
  } else if (repeatedBlocked || (signals.repeated && signals.repeated.repeats >= 3 && lastError)) {
    cause = lastError?.cls ?? "repeated-call";
    agentCausal = true;
    mechanism = "repeated-unsuccessful-retry";
  } else if (trace.toolPendingCount > 0 && trace.toolErrorCount === 0) {
    cause = "approval-pending";
    agentCausal = false;
    mechanism = "approval-never-granted";
  } else if (
    trace.completedExplicitly &&
    (trace.toolErrorCount > 0 || trace.toolPendingCount > 0)
  ) {
    cause = lastError?.cls ?? "unresolved";
    agentCausal = true;
    mechanism = "premature-completion";
  } else if (trace.endedWithError && !lastError) {
    const lc = label.reason.toLowerCase();
    if (lc.includes("context-overflow")) {
      cause = "context-overflow";
      agentCausal = true;
      mechanism = "context-overflow";
    } else if (lc.includes("unknown-tool")) {
      cause = "unknown-tool";
      agentCausal = true;
      mechanism = "unknown-tool";
    } else {
      cause = "provider";
      agentCausal = false;
      mechanism = "environment-outage";
    }
  } else if (lastError) {
    cause = lastError.cls;
    agentCausal = lastError.scope === "agent";
    mechanism = mechanismForErrorClass(lastError.cls, lastError.scope);
  } else {
    cause = "unclassified";
    agentCausal = true;
    mechanism = "unresolved-tool-error";
  }
  return {
    cause,
    agentCausal,
    mechanism,
    key: `${cause}|${agentCausal ? "agent" : "env"}|${mechanism}`,
  };
}

/** Merge per-iteration cluster counts (newest last) into a ranked list. */
export function rankFailureSignatures(
  histories: ReadonlyArray<Record<string, number> | null | undefined>,
): Array<{ key: string; count: number; iterations: number }> {
  const totals = new Map<string, { count: number; iterations: number }>();
  for (const h of histories) {
    if (!h) {
      continue;
    }
    for (const [key, count] of Object.entries(h)) {
      const cur = totals.get(key) ?? { count: 0, iterations: 0 };
      cur.count += count;
      cur.iterations += 1;
      totals.set(key, cur);
    }
  }
  return [...totals.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .toSorted((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
