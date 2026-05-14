/**
 * Long-horizon Task Judge (PLAN-16 Phase D).
 *
 * When a Task transitions to `judging`, an *isolated* judge verifies
 * that the recorded output meets the original done-criteria. The judge
 * cannot see the worker's working memory — only goal, done_criteria,
 * the final output reference, and (optionally) the latest handoff +
 * plan-step statuses. This prevents the worker from grading its own
 * homework, mirroring the planner / worker / judge separation from
 * Cursor / Amp.
 *
 * Hard rule: the judge can return only `pass`, `fail`, or
 * `needs_more`. It cannot mark the task `completed` or `stopped` —
 * those are state transitions the caller applies based on the verdict.
 *
 * Reuses the YAML-fence response parsing pattern from
 * `src/memory/skill-curator-judge.ts` but is independent of that
 * module: task judging has a different decision space (pass/fail/
 * needs_more) than skill curating (keep/archive/consolidate/patch).
 */

import YAML from "yaml";
import type { Task, TaskHandoff } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("tasks/judge");

export type TaskJudgeVerdict = "pass" | "fail" | "needs_more";

export type TaskJudgeDecision = {
  verdict: TaskJudgeVerdict;
  reasoning: string;
  /** When verdict is fail/needs_more, the specific gaps. */
  missing?: string[];
};

export type TaskJudgeInput = {
  task: Task;
  /** Worker's claimed final artifact reference. May echo task.output. */
  output: string | null;
  /** Most recent handoff for cross-checking pending/decisions. Optional. */
  latestHandoff?: TaskHandoff | null;
};

export type LlmCall = (prompt: string) => Promise<string>;

/** Cap on round count before forcing terminal failure. */
export const DEFAULT_MAX_JUDGE_ROUNDS = 5;

const MAX_OUTPUT_PROMPT = 3_000;
const MAX_HANDOFF_PROMPT = 2_000;

export function buildTaskJudgePrompt(input: TaskJudgeInput): string {
  const { task, output, latestHandoff } = input;
  const planLines =
    task.plan && task.plan.steps.length > 0
      ? task.plan.steps
          .map((s, i) => `  ${i + 1}. [${s.status}] ${s.title}${s.output ? ` → ${s.output}` : ""}`)
          .join("\n")
      : "  (no plan recorded)";
  const outputSnippet = truncate(output ?? "(no output recorded)", MAX_OUTPUT_PROMPT);
  const handoffBlock = latestHandoff
    ? [
        `## Latest handoff (intent + pending at suspend)`,
        `Intent: ${latestHandoff.intent}`,
        `Decisions: ${(latestHandoff.decisions ?? []).map((d) => `\n  - ${d}`).join("") || " (none)"}`,
        `Pending: ${(latestHandoff.pending ?? []).map((p) => `\n  - ${p}`).join("") || " (none)"}`,
        latestHandoff.context
          ? `Context: ${truncate(latestHandoff.context, MAX_HANDOFF_PROMPT)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "## Latest handoff\n(no handoff recorded)";

  return `You are the JUDGE for a long-horizon agent task. Your only job is to decide whether the worker's claimed output satisfies the falsifiable done-criteria written when the task was created. Be conservative. If you cannot verify a criterion from the output you've been shown, fail or ask for more — do not assume.

You will NOT see the worker's chain of thought, working memory, or tool history. You will only see what's below. This is by design — your independence is the point.

## Goal
${task.goal}

## Done criteria (the only thing that matters for pass/fail)
${task.doneCriteria}

## Worker plan + step statuses
${planLines}

## Worker output / final artifact reference
\`\`\`
${outputSnippet}
\`\`\`

${handoffBlock}

## Decision
Return ONE of these YAML blocks in a fenced \`\`\`yaml ... \`\`\`, nothing else:

\`\`\`yaml
# Option A — done criteria clearly met. Output verifies all stated requirements.
verdict: pass
reasoning: "<= 60 words explaining what specifically satisfies the criteria >"
\`\`\`

\`\`\`yaml
# Option B — done criteria clearly NOT met. Output is missing or wrong on specific points.
verdict: fail
reasoning: "<= 60 words >"
missing:
  - "specific criterion not satisfied"
  - "another specific gap"
\`\`\`

\`\`\`yaml
# Option C — output looks plausible but you cannot verify from what you've been shown.
# Use this when the worker needs to gather more evidence or surface specific artifacts.
verdict: needs_more
reasoning: "<= 60 words explaining what evidence you need >"
missing:
  - "evidence needed item"
\`\`\`
`;
}

const YAML_FENCE_RE = /```yaml\s*\n([\s\S]*?)```/i;
const ANY_FENCE_RE = /```(?:[\w-]+)?\s*\n([\s\S]*?)```/i;

type RawJudgeYaml = {
  verdict?: unknown;
  reasoning?: unknown;
  missing?: unknown;
};

export function parseTaskJudgeResponse(raw: string): TaskJudgeDecision | null {
  const yamlBlock = raw.match(YAML_FENCE_RE)?.[1] ?? raw.match(ANY_FENCE_RE)?.[1] ?? raw;
  let parsed: RawJudgeYaml;
  try {
    parsed = YAML.parse(yamlBlock) as RawJudgeYaml;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict.trim() : "";
  const reasoning =
    typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "(no reasoning)";
  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : undefined;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "needs_more") return null;
  return {
    verdict,
    reasoning,
    ...(missing && missing.length > 0 ? { missing } : {}),
  };
}

/**
 * Run one judging round: build prompt, call the LLM, parse the verdict.
 * Returns null when the response is malformed (caller should retry or fail).
 */
export async function runTaskJudge(
  input: TaskJudgeInput,
  llmCall: LlmCall,
): Promise<TaskJudgeDecision | null> {
  const prompt = buildTaskJudgePrompt(input);
  let raw: string;
  try {
    raw = await llmCall(prompt);
  } catch (err) {
    log.warn(`judge llmCall failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const decision = parseTaskJudgeResponse(raw);
  if (!decision) {
    log.warn(`judge response unparseable; first 200 chars: ${raw.slice(0, 200)}`);
  }
  return decision;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// Provider registry — gateway boot wires the real LLM call here. Tests inject
// directly via the runJudge function. Tools call into the registry.
// ---------------------------------------------------------------------------

let activeLlmCall: LlmCall | null = null;

export function registerJudgeLlmCall(fn: LlmCall | null): void {
  activeLlmCall = fn;
}

export function getJudgeLlmCall(): LlmCall | null {
  return activeLlmCall;
}
