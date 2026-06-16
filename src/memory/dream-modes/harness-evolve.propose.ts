// PLAN-25 Phase 3: the Harness Proposal stage. Given the live policy and the top
// failure clusters, the (frozen) model emits K minimal candidate policies in one
// batched call. Each candidate is whitelist-parsed (forbidden surfaces are
// structurally impossible) and must actually differ from the live policy.

import type { FailureCluster } from "./harness-evolve.weakness.js";
import {
  type HarnessPolicy,
  parseHarnessPolicy,
  policyDiffSummary,
  serializePolicyForJudge,
} from "../../agents/pi-embedded-runner/harness-policy.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory/dream/harness-evolve.propose");

export interface HarnessProposal {
  candidate: HarnessPolicy;
  audit: { targetedMechanism: string; surfacesTouched: string[]; rationale: string };
}

function extractJsonArray(raw: string): unknown[] {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildPrompt(live: HarnessPolicy, clusters: FailureCluster[], k: number): string {
  const clusterLines = clusters
    .map(
      (c, i) =>
        `${i + 1}. surface=${c.signature.surface} cause="${c.signature.terminalCause}" ` +
        `mechanism="${c.signature.mechanism}" count=${c.count} e.g. ${c.exampleDetail}`,
    )
    .join("\n");

  return [
    "You are improving an AI agent's OPERATIONAL HARNESS by editing a JSON policy.",
    "You may ONLY edit these surfaces; anything else is ignored:",
    "- prompt.fragments: array of { id, text, order } appended to the system prompt",
    "- tools.descriptionOverrides: { [toolName]: betterDescription }",
    "",
    "Current live policy (serialized):",
    serializePolicyForJudge(live),
    "",
    "Recurring failure clusters mined from real execution traces:",
    clusterLines || "(none)",
    "",
    `Propose up to ${k} candidate policies. RULES:`,
    "- Each candidate targets ONE cluster and makes the SMALLEST change that could fix it.",
    "- Return the FULL policy object (keep existing fields, add/modify only what's needed).",
    "- Prefer adding a precise prompt fragment or a clearer tool description over broad rewrites.",
    "- Keep fragment ids stable and descriptive (e.g. 'route-entity-queries').",
    "",
    'Respond with ONLY a JSON array. Each element: { "policy": <HarnessPolicy>, "targetedMechanism": <string>, "rationale": <string> }',
  ].join("\n");
}

/**
 * Ask the model for candidate policies. Returns only well-formed candidates that
 * actually differ from the live policy. One LLM call total (batched).
 */
export async function proposeHarnessCandidates(args: {
  live: HarnessPolicy;
  clusters: FailureCluster[];
  llmCall: (prompt: string) => Promise<string>;
  k?: number;
}): Promise<HarnessProposal[]> {
  const k = args.k ?? 4;
  if (args.clusters.length === 0) return [];
  let raw: string;
  try {
    raw = await args.llmCall(buildPrompt(args.live, args.clusters.slice(0, k), k));
  } catch (err) {
    log.debug(`proposer LLM call failed: ${String(err)}`);
    return [];
  }

  const out: HarnessProposal[] = [];
  for (const item of extractJsonArray(raw)) {
    if (out.length >= k) break;
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const candidate = parseHarnessPolicy(rec.policy);
    if (!candidate) continue;
    const diff = policyDiffSummary(args.live, candidate);
    if (diff.changeCount === 0) continue; // no-op, skip
    out.push({
      candidate,
      audit: {
        targetedMechanism: typeof rec.targetedMechanism === "string" ? rec.targetedMechanism : "",
        surfacesTouched: diff.surfacesTouched,
        rationale: typeof rec.rationale === "string" ? rec.rationale : "",
      },
    });
  }
  return out;
}
