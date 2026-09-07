/**
 * PLAN-45 5.5: ContinualSkillBench (arXiv 2608.03874, Apache-2.0,
 * github.com/gtynnn060110-hash/continual-skill-bench-final) as an external
 * corpus for the ablation harness, with Bitterbot as the executor.
 *
 * Only the deterministically scored subtasks are imported (`exact_match`
 * and `numeric`; 279 of 600 across the six domains); `programmatic`,
 * `f1` and `rubric_judge` subtasks need the benchmark's Docker verifiers
 * or a judge and are skipped, by count, in the report. The benchmark's
 * own protocol is sequential (skills evolving across a domain's 100
 * subtasks); the harness measures the STATIC arms on the same tasks,
 * which answers "does the node's skill set help on these" and not "can
 * the node evolve along the sequence".
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { CorpusTask } from "../../../src/memory/skill-evolution/task-corpus.js";

export const CSB_REPO = "https://github.com/gtynnn060110-hash/continual-skill-bench-final";
export const CSB_LICENSE = "Apache-2.0";
export const CSB_DOMAINS = [
  "math-100",
  "finance-econ-100",
  "law-100",
  "office-100",
  "healthcare-100",
  "science-100",
] as const;
export const CSB_DETERMINISTIC = new Set(["exact_match", "numeric"]);

export interface CsbSpecItem {
  task_id: number;
  source?: string;
  source_id?: string;
  instruction: string;
  eval_type: string;
  difficulty?: string;
  domain?: string;
  skill_layer?: number;
  skill_tags?: string[];
  answer?: string | number | null;
  numeric_tolerance?: number | null;
}

export interface CsbLoadResult {
  tasks: CorpusTask[];
  /** Subtasks skipped per eval type (needs the benchmark's verifier or a judge). */
  skipped: Record<string, number>;
  domains: string[];
}

/** Shallow-clone the benchmark when the directory has no tasks yet. */
export function ensureContinualSkillBench(dir: string): string {
  const specs = path.join(dir, "Continual-Skill-Bench", "tasks");
  try {
    execFileSync("test", ["-d", specs]);
    return dir;
  } catch {
    execFileSync("git", ["clone", "--depth", "1", CSB_REPO, dir], { stdio: "ignore" });
    return dir;
  }
}

export function csbTask(domain: string, item: CsbSpecItem): CorpusTask | null {
  if (!CSB_DETERMINISTIC.has(item.eval_type) || item.answer === null || item.answer === undefined) {
    return null;
  }
  const answer = String(item.answer).trim();
  if (!answer) {
    return null;
  }
  const shortDomain = domain.replace(/-100$/, "");
  const id = `csb-${shortDomain}-${String(item.task_id).padStart(3, "0")}`;
  // A single-letter gold is a multiple-choice answer: ask for the letter and
  // accept it bare or in parentheses on the FINAL line (the benchmark's own
  // exact-match scoring normalizes the choice marker).
  const isChoice = item.eval_type === "exact_match" && /^[A-E]$/.test(answer);
  const prompt = `${item.instruction.trim()}\n\nWhen you are done, reply with a single line \`FINAL: <answer>\` containing only the answer${isChoice ? " (the letter of the correct choice)" : ""}.`;
  const checker: CorpusTask["checker"] =
    item.eval_type === "numeric"
      ? {
          kind: "numeric",
          value: answer,
          tolerance:
            typeof item.numeric_tolerance === "number" && item.numeric_tolerance >= 0
              ? item.numeric_tolerance
              : 0,
        }
      : isChoice
        ? {
            kind: "regex",
            value: `(?:^|\\n)[ \\t]*FINAL:[ \\t]*\\(?${answer}\\)?[ \\t.,]*(?:$|\\n)`,
          }
        : { kind: "final", value: answer };
  return {
    id,
    prompt,
    checker,
    suite: "capability",
    timeoutMs: 120_000,
    tags: [
      "external",
      "csb",
      shortDomain,
      `layer-${item.skill_layer ?? 0}`,
      ...(item.skill_tags ?? []).slice(0, 4),
    ],
  };
}

export async function loadContinualSkillBench(
  dir: string,
  opts: { domains?: readonly string[] } = {},
): Promise<CsbLoadResult> {
  const domains = (opts.domains?.length ? opts.domains : CSB_DOMAINS).map((d) =>
    d.endsWith("-100") ? d : `${d}-100`,
  );
  const tasks: CorpusTask[] = [];
  const skipped: Record<string, number> = {};
  const seen: string[] = [];
  for (const domain of domains) {
    const file = path.join(
      dir,
      "Continual-Skill-Bench",
      "tasks",
      domain,
      "environment",
      "tasks_spec.json",
    );
    let items: CsbSpecItem[];
    try {
      items = JSON.parse(await fs.readFile(file, "utf-8")) as CsbSpecItem[];
    } catch {
      continue;
    }
    seen.push(domain);
    for (const item of items) {
      const task = csbTask(domain, item);
      if (task) {
        tasks.push(task);
      } else {
        skipped[item.eval_type] = (skipped[item.eval_type] ?? 0) + 1;
      }
    }
  }
  return { tasks, skipped, domains: seen };
}
