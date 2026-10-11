/**
 * PLAN-55 Phase 2 (G4), consumer 5: open anticipation briefs and task plans
 * that cite a superseded value.
 *
 * "Cites" is the shared matcher (canonical-stale-match.ts): the old value as
 * a whole identifier, not alongside the new one, AND a subject word of the
 * key in the same text.
 *
 * - `dream_briefs` rows still `open` that cite it move to status
 *   `stale_fact`; `stale_fact` holds a JSON list of notes, one per key, so
 *   consumeDreamBrief never voices them.
 * - Open (non-terminal) tasks whose goal, done criteria, plan steps or
 *   latest handoff cite it get a `metadata.staleFacts` entry (per key, written
 *   atomically through TaskStore.updateStaleFacts); task_get returns it.
 * - When anything was flagged, one `stale_reference` epistemic directive
 *   names the change, the affected items and what a yes does. Open
 *   user-answerable directives are the "needs your answer" list: they are
 *   injected into the owner's first-party turns (endocrine-state.ts) and
 *   the extractor's Open Questions block.
 *
 * A pin back to the old value drops that key's notes and flags; a brief
 * reopens only when no stale key remains on it. Idempotent: notes and flags
 * are keyed (key, old value), and the directive engine dedupes a repeated
 * question.
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
import { staleCitationMatcher, yieldToEventLoop } from "./canonical-stale-match.js";
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
  /** False for a project-scoped change: tasks are not tied to a workspace. */
  includeTasks?: boolean;
}): Promise<BriefTaskPropagationResult> {
  const { db, event, directives } = params;
  const taskStore = params.includeTasks === false ? null : params.taskStore;
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
  const matcher = staleCitationMatcher(event);
  if (!matcher) {
    return result;
  }
  const cites = matcher.cites;

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
        `SELECT id, question, answer_sketch, stale_fact FROM dream_briefs
          WHERE status IN ('open', 'stale_fact')
          ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(MAX_BRIEFS_PER_EVENT) as unknown as Array<{
      id: string;
      question: string;
      answer_sketch: string;
      stale_fact: string | null;
    }>;
    const flag = db.prepare(
      `UPDATE dream_briefs SET status = 'stale_fact', stale_fact = ?
        WHERE id = ? AND status IN ('open', 'stale_fact')`,
    );
    for (const row of rows) {
      if (!cites(`${row.question}\n${row.answer_sketch}`)) {
        continue;
      }
      const notes = parseBriefNotes(row.stale_fact);
      if (notes.some((n) => sameNote(n, note))) {
        continue;
      }
      const next = [...notes.filter((n) => n.key !== note.key), note];
      result.briefsFlagged += Number(flag.run(JSON.stringify(next), row.id).changes);
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
      const flag: TaskStaleFactFlag = {
        key: note.key,
        oldValue: note.oldValue,
        newValue: note.newValue,
        factId: note.factId,
        flaggedAt: note.at,
      };
      const oldNorm = normalizeExact(note.oldValue);
      const updated = taskStore.updateStaleFacts(task.id, (current) =>
        current.some(
          (f) =>
            f.key === note.key &&
            normalizeExact(f.oldValue) === oldNorm &&
            f.newValue === note.newValue,
        )
          ? current
          : [...current.filter((f) => f.key !== note.key), flag],
      );
      if (updated) {
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
      .prepare(
        `SELECT id, stale_fact FROM dream_briefs WHERE status = 'stale_fact'
          ORDER BY created_at DESC, id LIMIT 500`,
      )
      .all() as unknown as Array<{ id: string; stale_fact: string | null }>;
    const write = db.prepare(`UPDATE dream_briefs SET status = ?, stale_fact = ? WHERE id = ?`);
    const norm = normalizeExact(value);
    let n = 0;
    for (const row of rows) {
      const notes = parseBriefNotes(row.stale_fact);
      const kept = notes.filter((x) => !(x.key === key && normalizeExact(x.oldValue) === norm));
      if (kept.length === notes.length) {
        continue;
      }
      // Reopen only when no stale key remains on the brief.
      if (kept.length === 0) {
        n += Number(write.run("open", null, row.id).changes);
      } else {
        write.run("stale_fact", JSON.stringify(kept), row.id);
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
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    if (!readTaskStaleFacts(task).some((f) => f.key === key)) {
      continue;
    }
    const updated = store.updateStaleFacts(task.id, (flags) =>
      flags.filter((f) => !(f.key === key && normalizeExact(f.oldValue) === norm)),
    );
    if (updated) {
      cleared++;
    }
    if (i % 25 === 24) {
      await yieldToEventLoop();
    }
  }
  return cleared;
}

/** The brief's stale notes (a list; a single legacy object is accepted). */
export function parseBriefNotes(raw: string | null): BriefStaleNote[] {
  if (!raw) {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    const list = Array.isArray(v) ? v : [v];
    return list.filter(
      (n): n is BriefStaleNote =>
        Boolean(n) &&
        typeof (n as BriefStaleNote).key === "string" &&
        typeof (n as BriefStaleNote).oldValue === "string",
    );
  } catch {
    return [];
  }
}

const sameNote = (a: BriefStaleNote, b: BriefStaleNote): boolean =>
  a.key === b.key &&
  normalizeExact(a.oldValue) === normalizeExact(b.oldValue) &&
  a.newValue === b.newValue;

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
  const fix = event.newValue
    ? `If you say yes I will rewrite them to use "${clip(event.newValue, 60)}"; if not, I will leave them as they are.`
    : "If you say yes I will drop the old value from them; if not, I will leave them as they are.";
  const question =
    `Your correction: you ${change}, but ${items.join(" and ")} still rely on the old value. ` +
    `Should I update them? ${fix}`;
  try {
    const d = directives.createDirective({
      type: "stale_reference",
      question,
      context: `canonical:changed ${event.op} (fact ${event.factId})`,
      priority: 0.6,
      sourceEntityIds: [`stale_fact:${event.key}`],
    });
    return d?.id ?? null;
  } catch (err) {
    log.debug(`stale_reference directive failed: ${String(err)}`);
    return null;
  }
}
