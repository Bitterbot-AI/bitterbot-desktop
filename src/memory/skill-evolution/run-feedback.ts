/**
 * Run feedback ledger (2026-09-05 harness review, B8): level-4 evidence.
 *
 * A human saying "that was right" or "that was wrong" about a specific run
 * is the strongest outcome signal the harness can get, and until now it was
 * inferred by regexes over the next message and fanned out to whatever
 * records happened to be pending. This ledger links one explicit verdict to
 * one run id. Consumers (the trace labeler, skill-read crediting) read it
 * by run id; nothing infers it.
 *
 * Append-only JSONL under the skill wiki dir; the newest entry per run wins.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type ImpactTrailOptions, resolveWikiDir } from "../../agents/skills/impact-trail.js";

export const RUN_FEEDBACK_FILENAME = "run-feedback.jsonl";
const MAX_NOTE_CHARS = 500;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type RunFeedbackVerdict = "confirmed" | "rejected";

export interface RunFeedbackEntry {
  runId: string;
  verdict: RunFeedbackVerdict;
  /** Free text from the human (capped, stored verbatim; treated as data downstream). */
  note: string | null;
  /** Who recorded it: "operator" (RPC/CLI) or a channel/user label. */
  by: string;
  ts: number;
}

export function runFeedbackPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), RUN_FEEDBACK_FILENAME);
}

export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

export async function appendRunFeedback(
  entry: { runId: string; verdict: RunFeedbackVerdict; note?: string | null; by?: string },
  opts: ImpactTrailOptions = {},
): Promise<RunFeedbackEntry> {
  if (!isValidRunId(entry.runId)) {
    throw new Error(`invalid run id: ${entry.runId}`);
  }
  if (entry.verdict !== "confirmed" && entry.verdict !== "rejected") {
    throw new Error(`verdict must be confirmed or rejected`);
  }
  const record: RunFeedbackEntry = {
    runId: entry.runId,
    verdict: entry.verdict,
    note: entry.note ? entry.note.slice(0, MAX_NOTE_CHARS) : null,
    by: entry.by?.trim() || "operator",
    ts: Date.now(),
  };
  const file = runFeedbackPath(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

/** Newest verdict per run id. Missing file = empty map; a corrupt line is skipped. */
export async function readRunFeedback(
  opts: ImpactTrailOptions = {},
): Promise<Map<string, RunFeedbackEntry>> {
  const out = new Map<string, RunFeedbackEntry>();
  let raw: string;
  try {
    raw = await fs.readFile(runFeedbackPath(opts), "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as RunFeedbackEntry;
      if (
        typeof parsed.runId === "string" &&
        (parsed.verdict === "confirmed" || parsed.verdict === "rejected")
      ) {
        out.set(parsed.runId, parsed);
      }
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
