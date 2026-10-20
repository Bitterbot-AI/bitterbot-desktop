/**
 * PLAN-45 Phase 3.2/3.3: the canary-runs ledger.
 *
 * One row per (run, canary skill) for every run whose index the exposure
 * filter touched (stream `skills` in the journal): exposed or withheld,
 * read or not, the run's grounded label, and whether the run looked like a
 * task the skill is FOR (the eligibility proxy). skill-reads.jsonl keeps
 * only reads; this ledger is what makes the control cohort observable.
 *
 * Eligibility is lexical: content words of the description's positive
 * clause (as frozen at canary start) against the task header. It is a
 * proxy, applied identically to both cohorts, so it cannot favor either.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { contentWords, positiveClause } from "../../agents/skills/description-overlap.js";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";

export const CANARY_RUNS_FILENAME = "canary-runs.jsonl";
/** Share of the description's content words the task must contain. */
export const ELIGIBILITY_MIN_SHARE = 0.3;
/** ...and at least this many of them. */
export const ELIGIBILITY_MIN_WORDS = 2;

export interface CanaryRunRow {
  runId: string;
  skill: string;
  ts: number;
  exposed: boolean;
  read: boolean;
  /** Task header overlapped the description at canary start (lexical; identical on both cohorts). */
  eligible: boolean;
  label: string;
  outcomeLevel: number;
  model: string | null;
  origin: string;
  /** First-party, non-heartbeat run (the only runs the monitor counts). */
  credited: boolean;
  sessionKey: string | null;
}

export function canaryRunsPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), CANARY_RUNS_FILENAME);
}

export function isEligibleTask(description: string, taskText: string | null | undefined): boolean {
  if (!taskText) {
    return false;
  }
  const desc = new Set(contentWords(positiveClause(description)));
  if (desc.size === 0) {
    return false;
  }
  const task = new Set(contentWords(taskText));
  let inter = 0;
  for (const w of desc) {
    if (task.has(w)) {
      inter += 1;
    }
  }
  return inter >= ELIGIBILITY_MIN_WORDS && inter / desc.size >= ELIGIBILITY_MIN_SHARE;
}

export async function appendCanaryRuns(
  rows: CanaryRunRow[],
  opts: ImpactTrailOptions = {},
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const file = canaryRunsPath(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
}

export async function readCanaryRuns(opts: ImpactTrailOptions = {}): Promise<CanaryRunRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(canaryRunsPath(opts), "utf-8");
  } catch {
    return [];
  }
  const out: CanaryRunRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const row = JSON.parse(line) as Partial<CanaryRunRow>;
      if (
        typeof row.runId === "string" &&
        typeof row.skill === "string" &&
        typeof row.ts === "number" &&
        typeof row.exposed === "boolean"
      ) {
        out.push({
          runId: row.runId,
          skill: row.skill,
          ts: row.ts,
          exposed: row.exposed,
          read: row.read === true,
          eligible: row.eligible === true,
          label: typeof row.label === "string" ? row.label : "unknown",
          outcomeLevel: typeof row.outcomeLevel === "number" ? row.outcomeLevel : 0,
          model: typeof row.model === "string" ? row.model : null,
          origin: typeof row.origin === "string" ? row.origin : "unknown",
          credited: row.credited === true,
          sessionKey: typeof row.sessionKey === "string" ? row.sessionKey : null,
        });
      }
    } catch {
      // malformed line
    }
  }
  return out;
}
