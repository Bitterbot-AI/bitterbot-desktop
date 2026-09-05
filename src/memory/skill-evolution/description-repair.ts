/**
 * PLAN-44 Phase 4a: the DESCRIPTION REPAIR loop.
 *
 * The tasks-mode gate HOLDs a proposal as `never-triggered` when the agent
 * did not open the candidate on the capability tasks it was written for.
 * That verdict says nothing about the body: the description (the routing
 * key the runtime index shows) did not fire. Before the 2026-09-05 build
 * the same content just re-ran after the backoff and held again.
 *
 * Repair = generate a few rewordings that satisfy the description
 * contract, rank them with a cheap ROUTING PROXY (an LLM asked, per task,
 * whether the index entry would make it open the skill — capability tasks
 * should say yes, regression tasks should say no), and rewrite only the
 * `description:` line of the staged SKILL.md. The proxy is a selection
 * heuristic, not the verdict: the real gate re-measures the repaired
 * candidate on its next pass (new content hash → no backoff; incumbent
 * trials are memoized, only the candidate arm re-runs). Repairs are capped
 * per proposal so a skill that cannot be routed to stops costing anything.
 */

import type { LlmCallFn } from "./maintainer.js";
import type { CorpusTask } from "./task-corpus.js";
import {
  checkDescriptionContract,
  DESCRIPTION_CONTRACT_PROMPT,
  rewriteDescriptionLine,
} from "../../agents/skills/description-contract.js";
import { runSkillGate } from "../../agents/skills/skill-gate.js";
import { parseSkillMarkdown } from "../skill-curator-judge.js";
import { extractJsonObjectLenient } from "./json-extract.js";

export const MAX_DESCRIPTION_REPAIRS = 2;
/** Longest run of consecutive words a rewording may share with a task prompt (adversarial M4). */
export const MAX_SHARED_WORD_RUN = 5;
export const DEFAULT_REPAIR_VARIANTS = 3;
/** Regression tasks sampled into the proxy (keeps the call bounded). */
const MAX_PROXY_REGRESSION_TASKS = 8;
const BODY_EXCERPT_CHARS = 1_200;
const TASK_PROMPT_CHARS = 200;

export interface RepairCandidate {
  description: string;
  /** Proxy hits on capability tasks (should open) and regression tasks (should not). */
  capabilityHits: number;
  regressionHits: number;
  /** capabilityHits/cap − regressionHits/reg, in [-1, 1]. */
  score: number;
  /** Hits among capability tasks the rewriter did not see. */
  heldOutHits?: number;
}

export interface DescriptionRepairResult {
  applied: boolean;
  reason: string;
  from: string;
  to?: string;
  /** Rewritten SKILL.md when applied. */
  skillMd?: string;
  candidates: RepairCandidate[];
  llmCalls: number;
}

export interface DescriptionRepairDeps {
  llmCall: LlmCallFn;
  skillName: string;
  skillMd: string;
  tasks: CorpusTask[];
  variants?: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when `text` copies a run of more than MAX_SHARED_WORD_RUN consecutive words from `source`. */
export function copiesWording(text: string, source: string): boolean {
  const a = words(text);
  const b = words(source);
  const n = MAX_SHARED_WORD_RUN + 1;
  if (a.length < n || b.length < n) {
    return false;
  }
  const runs = new Set<string>();
  for (let i = 0; i + n <= b.length; i++) {
    runs.add(b.slice(i, i + n).join(" "));
  }
  for (let i = 0; i + n <= a.length; i++) {
    if (runs.has(a.slice(i, i + n).join(" "))) {
      return true;
    }
  }
  return false;
}

/** Deterministic split: every third capability task is held out of the variant prompt (shown only to the proxy). */
export function splitHeldOut<T>(tasks: T[]): { shown: T[]; heldOut: T[] } {
  if (tasks.length < 3) {
    return { shown: tasks, heldOut: [] };
  }
  const shown: T[] = [];
  const heldOut: T[] = [];
  tasks.forEach((t, i) => ((i + 1) % 3 === 0 ? heldOut : shown).push(t));
  return { shown, heldOut };
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Deterministic interleave so the proxy sees no suite-ordered block. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) {
      out.push(a[i] as T);
    }
    if (i < b.length) {
      out.push(b[i] as T);
    }
  }
  return out;
}

export function buildVariantPrompt(params: {
  skillName: string;
  currentDescription: string;
  body: string;
  capabilityTasks: CorpusTask[];
  regressionTasks: CorpusTask[];
  variants: number;
}): string {
  return [
    "You rewrite the DESCRIPTION of a skill so the runtime router opens it on the right tasks.",
    "The router sees only an index of <name> + <description> and opens a skill when exactly one description clearly applies.",
    `The current description did not fire on any of the tasks it was written for.`,
    "",
    DESCRIPTION_CONTRACT_PROMPT,
    "",
    `Skill name: ${params.skillName}`,
    `Current description: ${params.currentDescription || "(empty)"}`,
    "Skill body (what it does once opened):",
    truncate(params.body, BODY_EXCERPT_CHARS),
    "",
    "Situations it SHOULD fire on (describe the class, do not copy the wording):",
    ...params.capabilityTasks.map((t) => `- ${truncate(t.prompt, TASK_PROMPT_CHARS)}`),
    "",
    "Task classes it must NOT fire on:",
    ...params.regressionTasks.map(
      (t) => `- ${t.id}${t.tags?.length ? ` (${t.tags.join(", ")})` : ""}`,
    ),
    "",
    `Reply with exactly one JSON object: {"descriptions": [${Array.from({ length: params.variants }, () => '"..."').join(", ")}]}`,
    "Each entry is a complete description, different in emphasis from the others. Nothing else.",
  ].join("\n");
}

export function buildProxyPrompt(params: {
  skillName: string;
  description: string;
  tasks: CorpusTask[];
}): string {
  return [
    "You are the skill router of an agent runtime. The system prompt lists:",
    "<available_skills>",
    "  <skill>",
    `    <name>${params.skillName}</name>`,
    `    <description>${params.description}</description>`,
    "  </skill>",
    "</available_skills>",
    "Rule: read a skill's file only when the task clearly matches its description; otherwise do not.",
    "",
    "For each task below decide whether you would read this skill's file BEFORE starting the task.",
    ...params.tasks.map((t, i) => `${i + 1}. ${truncate(t.prompt, TASK_PROMPT_CHARS)}`),
    "",
    `Reply with exactly one JSON object: {"reads": [${params.tasks.map(() => "true|false").join(", ")}]} — one boolean per task, in order. Nothing else.`,
  ].join("\n");
}

export function parseVariants(raw: string): string[] {
  const obj = extractJsonObjectLenient(raw);
  const list =
    obj && Array.isArray((obj as { descriptions?: unknown }).descriptions)
      ? ((obj as { descriptions: unknown[] }).descriptions as unknown[])
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") {
      continue;
    }
    const d = v.replace(/\s+/g, " ").trim();
    if (!d || seen.has(d.toLowerCase())) {
      continue;
    }
    seen.add(d.toLowerCase());
    out.push(d);
  }
  return out;
}

export function parseReads(raw: string, expected: number): boolean[] | null {
  const obj = extractJsonObjectLenient(raw);
  const reads =
    obj && Array.isArray((obj as { reads?: unknown }).reads)
      ? ((obj as { reads: unknown[] }).reads as unknown[])
      : null;
  if (!reads || reads.length !== expected) {
    return null;
  }
  return reads.map((r) => r === true || r === "true");
}

/** Score one description with the routing proxy. Null when the proxy reply is unusable. */
export async function scoreDescriptionByProxy(params: {
  llmCall: LlmCallFn;
  skillName: string;
  description: string;
  capabilityTasks: CorpusTask[];
  regressionTasks: CorpusTask[];
  heldOutIds?: Set<string>;
}): Promise<RepairCandidate | null> {
  const ordered = interleave(params.capabilityTasks, params.regressionTasks);
  const raw = await params.llmCall(
    buildProxyPrompt({
      skillName: params.skillName,
      description: params.description,
      tasks: ordered,
    }),
  );
  const reads = parseReads(raw, ordered.length);
  if (!reads) {
    return null;
  }
  let capabilityHits = 0;
  let regressionHits = 0;
  let heldOutHits = 0;
  ordered.forEach((t, i) => {
    if (!reads[i]) {
      return;
    }
    if (t.suite === "regression") {
      regressionHits += 1;
    } else {
      capabilityHits += 1;
      if (params.heldOutIds?.has(t.id)) {
        heldOutHits += 1;
      }
    }
  });
  const cap = Math.max(1, params.capabilityTasks.length);
  const reg = Math.max(1, params.regressionTasks.length);
  return {
    description: params.description,
    capabilityHits,
    regressionHits,
    score: capabilityHits / cap - regressionHits / reg,
    heldOutHits,
  };
}

/**
 * Generate, rank and (when one wins) apply a reworded description. Never
 * touches the body. `applied: false` carries the reason.
 */
export async function repairDescription(
  deps: DescriptionRepairDeps,
): Promise<DescriptionRepairResult> {
  const parsed = parseSkillMarkdown(deps.skillMd);
  const fm = (parsed?.frontmatter ?? {}) as Record<string, unknown>;
  const from = typeof fm.description === "string" ? fm.description : "";
  const body = parsed?.body ?? "";
  const capabilityTasks = deps.tasks.filter((t) => t.suite !== "regression");
  const regressionTasks = deps.tasks
    .filter((t) => t.suite === "regression")
    .slice(0, MAX_PROXY_REGRESSION_TASKS);
  let llmCalls = 0;
  if (capabilityTasks.length === 0) {
    return {
      applied: false,
      reason: "no capability tasks to repair against",
      from,
      candidates: [],
      llmCalls,
    };
  }
  const variants = deps.variants ?? DEFAULT_REPAIR_VARIANTS;
  // Adversarial M4: the rewriter sees only part of the capability suite;
  // the proxy scores on all of it, so a rewording that merely echoes the
  // shown prompts does not route the held-out ones.
  const { shown, heldOut } = splitHeldOut(capabilityTasks);
  const heldOutIds = new Set(heldOut.map((t) => t.id));
  llmCalls += 1;
  const raw = await deps.llmCall(
    buildVariantPrompt({
      skillName: deps.skillName,
      currentDescription: from,
      body,
      capabilityTasks: shown,
      regressionTasks,
      variants,
    }),
  );
  const proposed = parseVariants(raw)
    .filter((d) => d.toLowerCase() !== from.trim().toLowerCase())
    .filter(
      (d) =>
        checkDescriptionContract({
          skillName: deps.skillName,
          frontmatterName: deps.skillName,
          description: d,
        }).length === 0,
    )
    .filter((d) => !capabilityTasks.some((t) => copiesWording(d, t.prompt)))
    .slice(0, variants);
  if (proposed.length === 0) {
    return {
      applied: false,
      reason: "no contract-compliant rewording produced",
      from,
      candidates: [],
      llmCalls,
    };
  }
  const candidates: RepairCandidate[] = [];
  for (const description of [from, ...proposed]) {
    if (!description) {
      continue;
    }
    llmCalls += 1;
    const scored = await scoreDescriptionByProxy({
      llmCall: deps.llmCall,
      skillName: deps.skillName,
      description,
      capabilityTasks,
      regressionTasks,
      heldOutIds,
    });
    if (scored) {
      candidates.push(scored);
    }
  }
  const baseline = candidates.find((c) => c.description === from) ?? null;
  const ranked = candidates
    .filter((c) => c.description !== from)
    .toSorted((a, b) => b.score - a.score || a.description.length - b.description.length);
  const best = ranked[0];
  if (!best) {
    return {
      applied: false,
      reason: "routing proxy returned nothing usable",
      from,
      candidates,
      llmCalls,
    };
  }
  const capRate = best.capabilityHits / capabilityTasks.length;
  const heldOutHits = best.heldOutHits ?? 0;
  if (heldOutIds.size >= 2 && heldOutHits / heldOutIds.size < 0.5) {
    return {
      applied: false,
      reason: `best rewording routes only ${heldOutHits}/${heldOutIds.size} held-out capability tasks by proxy`,
      from,
      candidates,
      llmCalls,
    };
  }
  if (capRate < 0.5) {
    return {
      applied: false,
      reason: `best rewording routes only ${best.capabilityHits}/${capabilityTasks.length} capability tasks by proxy`,
      from,
      candidates,
      llmCalls,
    };
  }
  if (baseline && best.score <= baseline.score) {
    return {
      applied: false,
      reason: `no rewording beats the current description by proxy (${best.score.toFixed(2)} vs ${baseline.score.toFixed(2)})`,
      from,
      candidates,
      llmCalls,
    };
  }
  // Adversarial H1: the rewording is model text that will be executed by
  // the validation runner and, if promoted, shown in every runtime prompt.
  // Re-run the full staging gate (schema, strict injection, contract) on
  // the rewritten file before it touches disk.
  const rewritten = rewriteDescriptionLine(deps.skillMd, best.description);
  const gate = runSkillGate({
    skillName: deps.skillName,
    stagedContent: rewritten,
    strictInjection: true,
    descriptionContract: true,
  });
  if (gate.outcome === "fail") {
    return {
      applied: false,
      reason: `rewording refused by the staging gate: ${gate.issues.map((i) => i.detail).join("; ")}`,
      from,
      candidates,
      llmCalls,
    };
  }
  return {
    applied: true,
    reason: `proxy score ${best.score.toFixed(2)} (cap ${best.capabilityHits}/${capabilityTasks.length}, held-out ${heldOutHits}/${heldOutIds.size}, reg ${best.regressionHits}/${regressionTasks.length})`,
    from,
    to: best.description,
    skillMd: rewritten,
    candidates,
    llmCalls,
  };
}
