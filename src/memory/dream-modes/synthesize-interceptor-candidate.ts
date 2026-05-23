/**
 * PLAN-20: Given a recurring failure cluster from `interceptor_harvest`,
 * call the LLM to produce a typed `PreActionInterceptor` candidate as
 * structured JSON. Validate the JSON, sanity-check the generated logic,
 * and (if a SICA staging dir is provided) write a stub to
 * `skills-staging/<name>/SKILL.md` so the operator can promote it via
 * the Active Guards UI.
 *
 * The LLM is asked for a strict JSON shape: id / skill / priority / tools /
 * activation / intervention. We never run the LLM-generated source through
 * eval at runtime — it lands as a SKILL.md proposal that requires explicit
 * human promotion through the existing SICA gate.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory/dream/synthesize-interceptor");

export interface HarvestClusterSummary {
  toolName: string;
  channel: string;
  shape: string;
  cohortSize: number;
  failureRate: number;
  sampleParams: ReadonlyArray<Record<string, unknown>>;
}

export interface CandidateSpec {
  id: string;
  skill: string;
  priority: number;
  tools: string[];
  maxFiresPerEpisode: number;
  activation: {
    description: string;
    conditions: string[];
  };
  intervention: {
    type: "modify" | "inject" | "require_prereq" | "block";
    description: string;
    /** For require_prereq, the tool name. */
    prereqTool?: string;
    /** Free-form reason the agent will see. */
    reason: string;
  };
  rationale: string;
}

const SYSTEM_PROMPT = `You design pre-action interceptors for the Bitterbot agent.

When a recurring failure cluster is observed (e.g. the agent keeps using a tool incorrectly under certain conditions), your job is to propose a *typed* interceptor specification in strict JSON that, once promoted by the operator, will deterministically prevent the failure.

You will be given:
- The toolName, channel, and parameter shape that recurs.
- A failure rate and cohort size.
- Up to 3 sample parameter blocks from real failures.

Produce JSON matching exactly this shape (no commentary, no markdown, no preamble):

{
  "id": "kebab-case:variant",
  "skill": "kebab-case-skill-name",
  "priority": 0-100,
  "tools": ["one-or-more-tool-names"],
  "maxFiresPerEpisode": 1-20,
  "activation": {
    "description": "human-readable trigger condition",
    "conditions": ["short", "list", "of", "conditions"]
  },
  "intervention": {
    "type": "modify" | "inject" | "require_prereq" | "block",
    "description": "what the intervention does",
    "prereqTool": "<only-if-type-is-require_prereq>",
    "reason": "first-person explanation the agent reads"
  },
  "rationale": "1-2 sentence justification for why this prevents the observed failure"
}

Rules:
- Choose the narrowest activation that catches the cluster — never broader.
- Prefer require_prereq over block when a fallback tool exists.
- Choose modify when the input can be rewritten safely.
- Set priority 60-80 by default; 80-100 only for safety guards.
- Set maxFiresPerEpisode to 3 unless the failure is rare.
- The id and skill should be descriptive and unique.
- Output JSON only.`;

function buildPrompt(cluster: HarvestClusterSummary): string {
  const samples = cluster.sampleParams
    .slice(0, 3)
    .map((p, i) => `Sample ${i + 1}: ${JSON.stringify(p)}`)
    .join("\n");
  return [
    SYSTEM_PROMPT,
    "",
    "=== CLUSTER ===",
    `toolName: ${cluster.toolName}`,
    `channel: ${cluster.channel}`,
    `parameter-shape: ${cluster.shape}`,
    `cohort size: ${cluster.cohortSize}`,
    `failure rate: ${(cluster.failureRate * 100).toFixed(0)}%`,
    "",
    samples,
    "",
    "Return JSON only.",
  ].join("\n");
}

const KEBAB_RX = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;
const VALID_TYPES = new Set(["modify", "inject", "require_prereq", "block"]);

function validateCandidate(
  raw: unknown,
): { ok: true; spec: CandidateSpec } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !KEBAB_RX.test(o.id)) {
    return { ok: false, reason: "invalid id" };
  }
  if (typeof o.skill !== "string" || !KEBAB_RX.test(o.skill)) {
    return { ok: false, reason: "invalid skill" };
  }
  const priority = Number(o.priority);
  if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
    return { ok: false, reason: "invalid priority" };
  }
  if (!Array.isArray(o.tools) || o.tools.length === 0) {
    return { ok: false, reason: "tools must be a non-empty array" };
  }
  const tools = o.tools.filter((t): t is string => typeof t === "string");
  if (tools.length === 0) return { ok: false, reason: "tools must be strings" };
  const maxFires = Number(o.maxFiresPerEpisode);
  if (!Number.isFinite(maxFires) || maxFires < 1 || maxFires > 50) {
    return { ok: false, reason: "invalid maxFiresPerEpisode" };
  }
  const activation = o.activation as { description?: unknown; conditions?: unknown } | undefined;
  if (!activation || typeof activation.description !== "string") {
    return { ok: false, reason: "invalid activation" };
  }
  const intervention = o.intervention as
    | { type?: unknown; description?: unknown; reason?: unknown; prereqTool?: unknown }
    | undefined;
  if (
    !intervention ||
    typeof intervention.type !== "string" ||
    !VALID_TYPES.has(intervention.type)
  ) {
    return { ok: false, reason: "invalid intervention.type" };
  }
  if (intervention.type === "require_prereq" && typeof intervention.prereqTool !== "string") {
    return { ok: false, reason: "require_prereq missing prereqTool" };
  }
  if (typeof intervention.reason !== "string" || intervention.reason.length < 8) {
    return { ok: false, reason: "missing intervention.reason" };
  }
  if (typeof o.rationale !== "string" || o.rationale.length < 8) {
    return { ok: false, reason: "missing rationale" };
  }
  const conditions = Array.isArray(activation.conditions)
    ? activation.conditions.filter((c): c is string => typeof c === "string")
    : [];
  const spec: CandidateSpec = {
    id: o.id,
    skill: o.skill,
    priority,
    tools,
    maxFiresPerEpisode: Math.floor(maxFires),
    activation: {
      description: activation.description as string,
      conditions,
    },
    intervention: {
      type: intervention.type as CandidateSpec["intervention"]["type"],
      description: typeof intervention.description === "string" ? intervention.description : "",
      prereqTool: typeof intervention.prereqTool === "string" ? intervention.prereqTool : undefined,
      reason: intervention.reason as string,
    },
    rationale: o.rationale,
  };
  return { ok: true, spec };
}

function tryParseJson(raw: string): unknown {
  // Strip leading code-fences if the model wrapped the JSON.
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fallback: scan for the first {...} block.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function synthesizeInterceptorCandidate(args: {
  llmCall: (prompt: string) => Promise<string>;
  cluster: HarvestClusterSummary;
  timeoutMs?: number;
}): Promise<{ ok: true; spec: CandidateSpec } | { ok: false; reason: string }> {
  const prompt = buildPrompt(args.cluster);
  let raw: string;
  try {
    const callPromise = args.llmCall(prompt);
    const timeoutMs = args.timeoutMs ?? 25_000;
    raw = await Promise.race([
      callPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`llm timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  } catch (err) {
    log.debug(`llm call failed: ${String(err)}`);
    return { ok: false, reason: `llm call failed: ${String(err)}` };
  }
  const parsed = tryParseJson(raw);
  if (!parsed) {
    log.debug(`llm produced unparseable JSON; first 200 chars: ${raw.slice(0, 200)}`);
    return { ok: false, reason: "llm produced unparseable JSON" };
  }
  const validated = validateCandidate(parsed);
  if (!validated.ok) {
    log.debug(`candidate validation failed: ${validated.reason}`);
    return validated;
  }
  return validated;
}

/**
 * Render a CandidateSpec into a SKILL.md body the operator can review
 * via the Active Guards "Promote candidate" CTA. The TS implementation
 * is left as a stub because user-authored interceptor.ts execution is
 * gated on issue #21 (capability sandbox).
 */
export function renderSkillMd(spec: CandidateSpec): string {
  const conditionLines = spec.activation.conditions.map((c) => `  - ${c}`).join("\n");
  return [
    "---",
    `name: ${spec.skill}`,
    `description: ${spec.intervention.description || spec.activation.description}`,
    `tier: executable`,
    "bitterbot:",
    "  always: false",
    "  interceptors:",
    `    - id: ${spec.id}`,
    `      builtin: false`,
    `      activates_on: ${spec.activation.description}`,
    `      intervention: ${spec.intervention.type}`,
    "---",
    "",
    `# ${spec.skill}`,
    "",
    "**Source:** auto-proposed by dream-cycle interceptor_harvest mode.",
    "",
    "## Activation",
    "",
    `Fires when:`,
    "",
    conditionLines || "  - (no conditions enumerated)",
    "",
    "## Intervention",
    "",
    `**Type:** \`${spec.intervention.type}\`  `,
    spec.intervention.prereqTool
      ? `**Required prereq tool:** \`${spec.intervention.prereqTool}\`  `
      : "",
    "",
    spec.intervention.description,
    "",
    `**Agent-visible reason:** ${spec.intervention.reason}`,
    "",
    "## Why this exists",
    "",
    spec.rationale,
    "",
    "## Promotion",
    "",
    `Tools intercepted: ${spec.tools.map((t) => "`" + t + "`").join(", ")}  `,
    `Priority: ${spec.priority}  `,
    `Max fires per session: ${spec.maxFiresPerEpisode}`,
    "",
    "Implementation (TypeScript module) must be added under `src/agents/skills/builtin-interceptors/` before this skill becomes live. Until then it remains in staging.",
    "",
  ]
    .filter((l) => l !== "")
    .concat([""])
    .join("\n");
}

export const __testing = { buildPrompt, validateCandidate, tryParseJson };
