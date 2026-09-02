/**
 * PLAN-42 Phase 4: the replayable task corpus — the node's local benchmark.
 *
 * "How do we know a generated skill is good?" is answered comparatively:
 * candidate skill set vs incumbent, same frozen corpus, paired scoring,
 * strict improvement only. The corpus is the benchmark artifact:
 *
 *   skill-wiki/task-corpus.jsonl — one task per line:
 *     {"id": "...", "prompt": "...", "checker": {"kind": "contains"|"regex"|"exact", "value": "..."}, "timeoutMs"?: n, "tags"?: [...]}
 *
 * Deterministic checkers only — a task belongs in the corpus precisely
 * because its outcome is checkable without a judge. The corpus version is
 * the SHA-1 of the file, recorded with every verdict so scores are only
 * ever compared within one corpus version. A seed corpus ships in
 * benchmarks/skill-evolution/ for Victor's review (D-D); nodes grow their
 * own from real traces with verifiable outcomes.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skill-evolution/task-corpus");

export const CORPUS_FILENAME = "task-corpus.jsonl";
export const MAX_CORPUS_TASKS = 30;
export const DEFAULT_TASK_TIMEOUT_MS = 120_000;

export interface TaskChecker {
  /**
   * "final" (preferred for new tasks): the answer must carry a line
   * `FINAL: <value>`; the captured value (length-capped) is compared
   * EXACTLY. Closes the documented `contains` false-pass modes — verbose
   * output that happens to include the gold string, or an answer that
   * enumerates every candidate value (xFinder arXiv:2405.11874,
   * WebChoreArena arXiv:2506.01952).
   */
  kind: "contains" | "regex" | "exact" | "final";
  value: string;
}

export interface CorpusTask {
  id: string;
  prompt: string;
  checker: TaskChecker;
  timeoutMs?: number;
  tags?: string[];
  /**
   * Which gate the task feeds (corpus/gate upgrade 2026-09-02):
   * - "regression": near-ceiling tasks; the gate requires NO new failures
   *   here, and they never count toward improvement (a task most models
   *   pass carries ~no information — item response theory, metabench).
   * - "capability" (default for grown tasks): tasks the incumbent
   *   sometimes fails; the sign-test promotion signal lives here.
   */
  suite?: "regression" | "capability";
}

export interface TaskCorpus {
  tasks: CorpusTask[];
  /** SHA-1 of the corpus file; verdicts are comparable only within one version. */
  version: string;
}

export function corpusPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), CORPUS_FILENAME);
}

function parseChecker(value: unknown): TaskChecker | null {
  const c = value as Record<string, unknown>;
  if (
    (c?.kind === "contains" || c?.kind === "regex" || c?.kind === "exact" || c?.kind === "final") &&
    typeof c.value === "string" &&
    c.value.length > 0
  ) {
    if (c.kind === "regex") {
      try {
        // Validate the pattern up front so a bad corpus line cannot throw
        // at scoring time.
        new RegExp(c.value, "i");
      } catch {
        return null;
      }
    }
    return { kind: c.kind, value: c.value };
  }
  return null;
}

/**
 * Parse corpus JSONL into tasks. Malformed/duplicate lines are skipped with
 * a log, never fatal. Shared by the node's grown corpus and the embedded
 * canonical corpus (canonical-corpus.ts).
 */
export function parseCorpusTasks(raw: string, opts: { maxTasks?: number } = {}): CorpusTask[] {
  const maxTasks = opts.maxTasks ?? MAX_CORPUS_TASKS;
  const tasks: CorpusTask[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
      const checker = parseChecker(entry.checker);
      if (!id || !prompt || !checker || seen.has(id)) {
        log.debug(`skipping malformed/duplicate corpus line: ${trimmed.slice(0, 80)}`);
        continue;
      }
      seen.add(id);
      tasks.push({
        id,
        prompt,
        checker,
        ...(typeof entry.timeoutMs === "number" && entry.timeoutMs > 0
          ? { timeoutMs: entry.timeoutMs }
          : {}),
        ...(Array.isArray(entry.tags)
          ? { tags: entry.tags.filter((t) => typeof t === "string") }
          : {}),
        ...(entry.suite === "regression" || entry.suite === "capability"
          ? { suite: entry.suite }
          : {}),
      });
      if (tasks.length >= maxTasks) {
        break;
      }
    } catch {
      log.debug(`skipping unparseable corpus line: ${trimmed.slice(0, 80)}`);
    }
  }
  return tasks;
}

/** Load the node's grown corpus. Absent or empty corpus returns null. */
export async function loadTaskCorpus(opts: ImpactTrailOptions = {}): Promise<TaskCorpus | null> {
  let raw: string;
  try {
    raw = await fs.readFile(corpusPath(opts), "utf-8");
  } catch {
    return null;
  }
  const tasks = parseCorpusTasks(raw);
  if (tasks.length === 0) {
    return null;
  }
  return { tasks, version: createHash("sha1").update(raw).digest("hex").slice(0, 12) };
}

/** Longest FINAL-line value accepted before the checker refuses (anti-enumeration cap). */
export const MAX_FINAL_ANSWER_CHARS = 400;

/** Deterministic binary scoring of an answer against a task's checker. */
export function scoreTaskAnswer(task: CorpusTask, answer: string): 0 | 1 {
  const a = answer ?? "";
  switch (task.checker.kind) {
    case "exact":
      return a.trim() === task.checker.value.trim() ? 1 : 0;
    case "contains":
      return a.toLowerCase().includes(task.checker.value.toLowerCase()) ? 1 : 0;
    case "regex":
      try {
        return new RegExp(task.checker.value, "i").test(a) ? 1 : 0;
      } catch {
        return 0;
      }
    case "final": {
      // Last `FINAL: <value>` line wins; missing line = fail; over-long
      // captured value = fail (an enumeration cannot smuggle the gold
      // string past an exact compare, and cannot pad the line either).
      const matches = [...a.matchAll(/^[ 	]*FINAL:[ 	]*(.*)$/gim)];
      const last = matches.at(-1)?.[1];
      if (typeof last !== "string") {
        return 0;
      }
      const value = last.trim();
      if (value.length === 0 || value.length > MAX_FINAL_ANSWER_CHARS) {
        return 0;
      }
      return value === task.checker.value.trim() ? 1 : 0;
    }
  }
}
