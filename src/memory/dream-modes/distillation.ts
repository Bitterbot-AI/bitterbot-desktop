/**
 * PLAN-40 Phase 2 — Lane 1: verified-success distillation.
 *
 * The strongest-evidenced offline function (Voyager, AWM +51% rel. WebArena,
 * Anthropic Dreaming): turn what PROVABLY worked into reusable procedural
 * memory. The non-negotiable ingredient is the success gate — no artifact is
 * distilled from anything without a verifiable success signal.
 *
 * v1 product: "what worked" workflow notes (`semantic_type='task_pattern'`,
 * AWM's shape) written through the manager ops callback (embedded + indexed,
 * evidence refs = source execution ids). Diff-shaped skill rewrites remain
 * gated behind the PLAN-15/21 staging machinery and land as a follow-up —
 * a workflow note cannot corrupt a skill; a bad rewrite can.
 *
 * Gates (per the adversarial pass — every v1 input was gameable):
 *  - executions must carry `recorded_by='after_tool_call'` (pre-v58 rows are
 *    unattributable and NEVER qualify — F7),
 *  - the source crystal must have `origin != 'dream'` (no paraphrase
 *    self-distillation — F8) — enforced at credit time AND re-checked here,
 *  - >= MIN_EXECUTIONS completed executions with success rate >=
 *    SUCCESS_RATE_FLOOR; negative `user_feedback` disqualifies outright;
 *    `reward_score` is NEVER consulted (it is a length heuristic — F5),
 *  - cursor over `started_at` (monotonic, indexed), never rowid (F12).
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordDreamArtifact } from "../dream-utility.js";

const log = createSubsystemLogger("memory/dream-distillation");

const CURSOR_KEY = "distillation_cursor_started_at";
/** Completed, attributed executions a skill needs before distillation. */
export const MIN_EXECUTIONS = 3;
/** Success-rate floor over the attributed executions. */
export const SUCCESS_RATE_FLOOR = 0.7;
/** Max workflow notes (= LLM calls) per cycle. */
const NOTES_PER_CYCLE = 2;

export type DistillationOps = {
  /**
   * Write a workflow note as a searchable task_pattern chunk (embedded +
   * indexed, evidence refs persisted). Returns the chunk id or null.
   */
  writeWorkflowNote(params: {
    text: string;
    skillCrystalId: string;
    evidenceExecutionIds: string[];
  }): Promise<string | null>;
};

export type DistillationResult = {
  notes: number;
  skillsConsidered: number;
  llmCalls: number;
  chunksAnalyzed: number;
};

function readCursor(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(CURSOR_KEY) as
      | { value: string }
      | undefined;
    const n = Number(row?.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(db: DatabaseSync, startedAt: number): void {
  try {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(CURSOR_KEY, String(startedAt));
  } catch (err) {
    log.debug(`distillation cursor write failed: ${String(err)}`);
  }
}

export async function runDistillation(params: {
  db: DatabaseSync;
  llmCall: ((prompt: string) => Promise<string>) | null;
  ops: DistillationOps | null;
  llmBudget: number;
  cycleId: string;
}): Promise<DistillationResult> {
  const { db, llmCall, ops, cycleId } = params;
  const result: DistillationResult = {
    notes: 0,
    skillsConsidered: 0,
    llmCalls: 0,
    chunksAnalyzed: 0,
  };
  if (!llmCall || !ops || params.llmBudget <= 0) {
    return result;
  }

  const cursor = readCursor(db);
  // Skills with NEW attributed completions since the cursor — then judged on
  // their FULL attributed history (the cursor finds fresh fuel; the gate
  // evaluates the whole record).
  let candidates: Array<{ skill_crystal_id: string; latest_started: number }>;
  try {
    candidates = db
      .prepare(
        `SELECT se.skill_crystal_id, MAX(se.started_at) AS latest_started
           FROM skill_executions se
           JOIN chunks c ON c.id = se.skill_crystal_id
          WHERE se.recorded_by = 'after_tool_call'
            AND se.completed_at IS NOT NULL
            AND se.started_at > ?
            AND COALESCE(c.origin, '') != 'dream'
          GROUP BY se.skill_crystal_id
          ORDER BY latest_started ASC
          LIMIT 10`,
      )
      .all(cursor) as Array<{ skill_crystal_id: string; latest_started: number }>;
  } catch (err) {
    log.debug(`distillation candidate query failed: ${String(err)}`);
    return result;
  }
  if (candidates.length === 0) {
    return result;
  }

  let maxSeenStartedAt = cursor;
  for (const cand of candidates) {
    maxSeenStartedAt = Math.max(maxSeenStartedAt, cand.latest_started);
    if (result.notes >= NOTES_PER_CYCLE || result.llmCalls >= params.llmBudget) {
      break;
    }
    result.skillsConsidered++;
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN user_feedback IS NOT NULL AND user_feedback < 0 THEN 1 ELSE 0 END) AS negative,
                GROUP_CONCAT(id) AS exec_ids
           FROM skill_executions
          WHERE skill_crystal_id = ?
            AND recorded_by = 'after_tool_call'
            AND completed_at IS NOT NULL`,
      )
      .get(cand.skill_crystal_id) as {
      total: number;
      successes: number;
      negative: number;
      exec_ids: string | null;
    };
    if (
      stats.total < MIN_EXECUTIONS ||
      (stats.negative ?? 0) > 0 ||
      (stats.successes ?? 0) / stats.total < SUCCESS_RATE_FLOOR
    ) {
      continue;
    }
    // One note per skill EVER (one-shot: re-distilling the same skill each
    // cycle is the bounded-rewriting rule again). Existence check by path.
    const already = db
      .prepare(`SELECT id FROM chunks WHERE path = ? LIMIT 1`)
      .get(`distill/workflow/${cand.skill_crystal_id}`) as { id: string } | undefined;
    if (already) {
      continue;
    }
    const skill = db
      .prepare(`SELECT text, skill_category FROM chunks WHERE id = ?`)
      .get(cand.skill_crystal_id) as { text: string; skill_category: string | null } | undefined;
    if (!skill?.text) {
      continue;
    }
    result.llmCalls++;
    result.chunksAnalyzed++;
    let note: string;
    try {
      const raw = await llmCall(
        `A skill has proven itself: ${stats.successes}/${stats.total} successful ` +
          `executions. Write a SHORT procedural "what works" note (3-6 bullet lines) a ` +
          `future agent can follow when doing this kind of task. Base it ONLY on the ` +
          `skill description below — no invented steps. Output only the note.\n\n` +
          `SKILL (${skill.skill_category ?? "uncategorized"}):\n${skill.text.slice(0, 1500)}`,
      );
      note = raw.trim();
    } catch (err) {
      log.debug(`distillation LLM failed: ${String(err)}`);
      continue;
    }
    if (!note || note.length < 30) {
      continue;
    }
    const noteId = await ops.writeWorkflowNote({
      text: `WORKFLOW (distilled from ${stats.successes}/${stats.total} verified successes of ${skill.skill_category ?? cand.skill_crystal_id}):\n${note}`,
      skillCrystalId: cand.skill_crystal_id,
      evidenceExecutionIds: (stats.exec_ids ?? "").split(",").filter(Boolean).slice(0, 20),
    });
    if (noteId) {
      result.notes++;
      recordDreamArtifact(db, {
        lane: "distillation",
        artifactKind: "workflow_note",
        artifactId: noteId,
        cycleId,
      });
    }
  }
  // Cursor advances past everything seen this cycle (started_at is
  // monotonic and indexed — never rowid, which the forgetting engine
  // recycles).
  if (maxSeenStartedAt > cursor) {
    writeCursor(db, maxSeenStartedAt);
  }
  return result;
}
