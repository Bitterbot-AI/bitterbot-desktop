/**
 * PLAN-55 Phase 2 (G4), consumer 5: open anticipation briefs and task plans
 * that cite a superseded value.
 *
 * - `dream_briefs` rows still `open` whose question or answer sketch states
 *   the old value move to status `stale_fact` with a `stale_fact` JSON note
 *   (key, old, new, fact id), so consumeDreamBrief never voices them.
 * - Open (non-terminal) tasks whose goal, done criteria, plan steps or
 *   latest handoff state the old value get a `metadata.staleFacts` entry;
 *   task_get returns it.
 * - When anything was flagged, one `stale_fact` epistemic directive names
 *   the change and the affected items. That is the "needs your answer" list
 *   today: open user-answerable directives are injected into the owner's
 *   first-party turns (endocrine-state.ts) and the extractor's Open
 *   Questions block.
 *
 * A pin back to the old value reverses both flags (the brief reopens, the
 * task entry is dropped). Idempotent: a brief already flagged is not
 * re-flagged, a task entry is keyed (key, old value), and the directive
 * engine dedupes a repeated question.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { TaskStore } from "../tasks/store.js";
import {
  isTerminal,
  readTaskStaleFacts,
  type Task,
  type TaskStaleFactFlag,
} from "../tasks/types.js";
import { canonicalChangeMarksStale, type CanonicalChangeEvent } from "./canonical-events.js";
import { staleValueMatcher, yieldToEventLoop } from "./canonical-supersede-search.js";
import type { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { normalizeExact } from "./memory-suppressions.js";

const log = createSubsystemLogger("memory/canonical-propagation");

export const MAX_BRIEFS_PER_EVENT = 200;
export const MAX_TASKS_PER_EVENT = 200;

export type BriefStaleNote = {
  key: string;
  oldValue: string;
  newValue: string | null;
  factId: string;
  at: number;
};

export type BriefTaskPropagationResult = {
  briefsFlagged: number;
  briefsReopened: number;
  tasksFlagged: number;
  tasksCleared: number;
  directiveId: string | null;
};

const OPEN_TASK_STATUSES = [
  "pending",
  "planning",
  "running",
  "waiting_external",
  "judging",
] as const;

/** The text of a task that can cite a fact: goal, criteria, plan, latest handoff. */
export function taskCitableText(task: Task, store: TaskStore): string {
  const parts: string[] = [task.goal, task.doneCriteria];
  for (const step of task.plan?.steps ?? []) {
    parts.push(step.title, step.description ?? "");
  }
  try {
    const handoff = store.latestHandoff(task.id);
    if (handoff) {
      parts.push(handoff.intent, ...handoff.decisions, ...handoff.pending, handoff.context ?? "");
    }
  } catch {
    // No handoff table on this store: plan text alone.
  }
  return parts.join("\n");
}

export async function propagateToBriefsAndTasks(params: {
  db: DatabaseSync;
  event: CanonicalChangeEvent;
  taskStore: TaskStore | null;
  directives: EpistemicDirectiveEngine | null;
}): Promise<BriefTaskPropagationResult> {
  const { db, event, taskStore, directives } = params;
  const result: BriefTaskPropagationResult = {
    briefsFlagged: 0,
    briefsReopened: 0,
    tasksFlagged: 0,
    tasksCleared: 0,
    directiveId: null,
  };

  // The value is current again: undo earlier flags for it.
  if (event.newValue) {
    result.briefsReopened = reopenBriefs(db, event.key, event.newValue);
    if (taskStore) {
      result.tasksCleared = await clearTaskFlags(taskStore, event.key, event.newValue);
    }
  }
  if (!canonicalChangeMarksStale(event)) {
    return result;
  }
  const matchesOld = staleValueMatcher(event.oldValue);
  if (!matchesOld) {
    return result;
  }
  const matchesNew = staleValueMatcher(event.newValue);
  const cites = (text: string): boolean => matchesOld(text) && !matchesNew?.(text);

  const note: BriefStaleNote = {
    key: event.key,
    oldValue: event.oldValue!,
    newValue: event.newValue,
    factId: event.factId,
    at: event.at,
  };

  // Briefs.
  try {
    const rows = db
      .prepare(
        `SELECT id, question, answer_sketch FROM dream_briefs WHERE status = 'open'
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(MAX_BRIEFS_PER_EVENT) as unknown as Array<{
      id: string;
      question: string;
      answer_sketch: string;
    }>;
    const flag = db.prepare(
      `UPDATE dream_briefs SET status = 'stale_fact', stale_fact = ? WHERE id = ? AND status = 'open'`,
    );
    for (const row of rows) {
      if (cites(`${row.question}\n${row.answer_sketch}`)) {
        result.briefsFlagged += Number(flag.run(JSON.stringify(note), row.id).changes);
      }
    }
  } catch (err) {
    log.debug(`brief stale flagging skipped: ${String(err)}`);
  }

  // Tasks.
  const flaggedGoals: string[] = [];
  if (taskStore) {
    let tasks: Task[] = [];
    try {
      tasks = taskStore.list({ status: [...OPEN_TASK_STATUSES], limit: MAX_TASKS_PER_EVENT });
    } catch (err) {
      log.debug(`task listing for stale flags failed: ${String(err)}`);
    }
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      if (isTerminal(task.status) || !cites(taskCitableText(task, taskStore))) {
        continue;
      }
      const existing = readTaskStaleFacts(task);
      const oldNorm = normalizeExact(note.oldValue);
      if (
        existing.some(
          (f) =>
            f.key === note.key &&
            normalizeExact(f.oldValue) === oldNorm &&
            f.newValue === note.newValue,
        )
      ) {
        continue;
      }
      const flag: TaskStaleFactFlag = {
        key: note.key,
        oldValue: note.oldValue,
        newValue: note.newValue,
        factId: note.factId,
        flaggedAt: note.at,
      };
      const next = [
        ...existing.filter((f) => !(f.key === note.key && normalizeExact(f.oldValue) === oldNorm)),
        flag,
      ];
      if (taskStore.setStaleFacts(task.id, next)) {
        result.tasksFlagged++;
        flaggedGoals.push(task.goal);
      }
      if (i % 25 === 24) {
        await yieldToEventLoop();
      }
    }
  }

  if ((result.briefsFlagged > 0 || result.tasksFlagged > 0) && directives) {
    result.directiveId = surfaceStaleQuestion(directives, event, result, flaggedGoals);
  }
  if (result.briefsFlagged + result.tasksFlagged > 0) {
    log.info(
      `canonical:changed [${event.key}] flagged stale_fact on ${result.briefsFlagged} brief(s), ` +
        `${result.tasksFlagged} task(s)`,
    );
  }
  return result;
}

function reopenBriefs(db: DatabaseSync, key: string, value: string): number {
  try {
    const rows = db
      .prepare(`SELECT id, stale_fact FROM dream_briefs WHERE status = 'stale_fact' LIMIT 500`)
      .all() as unknown as Array<{ id: string; stale_fact: string | null }>;
    const reopen = db.prepare(
      `UPDATE dream_briefs SET status = 'open', stale_fact = NULL WHERE id = ?`,
    );
    let n = 0;
    for (const row of rows) {
      const note = parseNote(row.stale_fact);
      if (note && note.key === key && normalizeExact(note.oldValue) === normalizeExact(value)) {
        n += Number(reopen.run(row.id).changes);
      }
    }
    return n;
  } catch {
    return 0;
  }
}

async function clearTaskFlags(store: TaskStore, key: string, value: string): Promise<number> {
  let tasks: Task[] = [];
  try {
    tasks = store.list({ status: [...OPEN_TASK_STATUSES], limit: MAX_TASKS_PER_EVENT });
  } catch {
    return 0;
  }
  const norm = normalizeExact(value);
  let cleared = 0;
  for (const task of tasks) {
    const flags = readTaskStaleFacts(task);
    const kept = flags.filter((f) => !(f.key === key && normalizeExact(f.oldValue) === norm));
    if (kept.length !== flags.length && store.setStaleFacts(task.id, kept)) {
      cleared++;
    }
  }
  if (cleared > 0) {
    await yieldToEventLoop();
  }
  return cleared;
}

function parseNote(raw: string | null): BriefStaleNote | null {
  if (!raw) {
    return null;
  }
  try {
    const v = JSON.parse(raw) as BriefStaleNote;
    return typeof v?.key === "string" && typeof v.oldValue === "string" ? v : null;
  } catch {
    return null;
  }
}

/** One prompt-safe line: control characters dropped (codepoint scan), whitespace collapsed, clipped. */
const clip = (s: string, n: number): string => {
  let out = "";
  for (const ch of s) {
    const cc = ch.codePointAt(0) ?? 0;
    out += cc < 0x20 || cc === 0x7f ? " " : ch;
  }
  const flat = out.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

function surfaceStaleQuestion(
  directives: EpistemicDirectiveEngine,
  event: CanonicalChangeEvent,
  result: BriefTaskPropagationResult,
  goals: string[],
): string | null {
  const change = event.newValue
    ? `changed ${event.key} from "${clip(event.oldValue!, 60)}" to "${clip(event.newValue, 60)}"`
    : `retired ${event.key} ("${clip(event.oldValue!, 60)}")`;
  const items: string[] = [];
  if (result.tasksFlagged > 0) {
    const named = goals
      .slice(0, 2)
      .map((g) => `"${clip(g, 60)}"`)
      .join(", ");
    items.push(`${result.tasksFlagged} open task(s) (${named}${goals.length > 2 ? ", ..." : ""})`);
  }
  if (result.briefsFlagged > 0) {
    items.push(`${result.briefsFlagged} prepared answer(s)`);
  }
  const question =
    `You ${change}, but ${items.join(" and ")} still rely on the old value. ` +
    `Should I update them to the new one?`;
  try {
    const d = directives.createDirective({
      type: "stale_fact",
      question,
      context: `canonical:changed ${event.op} (fact ${event.factId})`,
      priority: 0.6,
      sourceEntityIds: [`stale_fact:${event.key}`],
    });
    return d?.id ?? null;
  } catch (err) {
    log.debug(`stale_fact directive failed: ${String(err)}`);
    return null;
  }
}
