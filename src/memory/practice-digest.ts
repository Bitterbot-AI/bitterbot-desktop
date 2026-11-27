/**
 * PLAN-64 Phase 3: the "What I learned from you" section of the daily owner
 * brief (dream-brief.ts).
 *
 * Read from the practices tables, no model call:
 *  - practices saved or confirmed since the last brief;
 *  - candidates the owner was asked about and has not answered;
 *  - practices that were in a prompt since the last brief and that the owner
 *    never had to say again ("things you no longer have to repeat");
 *  - practices the owner had to say again since the last brief.
 *
 * "Applied" is prompt inclusion, as everywhere else: nothing here claims an
 * answer followed a practice. A repeat is reported as counted, because that
 * is all that happens to it.
 */

import type { DatabaseSync } from "node:sqlite";
import { describePracticeScope } from "./correction-capture.js";
import { practiceScopeRank } from "./practices.js";

export type PracticeDigestItem = {
  statement: string;
  /** The scope in words ("repo stats", "project acme", "everything"). */
  where: string;
};

export type PracticeDigest = {
  saved: PracticeDigestItem[];
  awaiting: PracticeDigestItem[];
  /** `applied` is the lifetime count of runs whose prompt carried the practice. */
  noRepeat: Array<PracticeDigestItem & { applied: number }>;
  /** `times` counts the repeats since the last brief. */
  repeats: Array<PracticeDigestItem & { times: number }>;
};

const MAX_SAVED = 5;
const MAX_AWAITING = 3;
const MAX_NO_REPEAT = 3;
const MAX_REPEATS = 3;

type Row = { id: string; statement: string; scope: string; status: string };

const all = <T>(db: DatabaseSync, sql: string, ...args: Array<number | string>): T[] => {
  try {
    return db.prepare(sql).all(...args) as unknown as T[];
  } catch {
    // A database from before the practices tables.
    return [];
  }
};

const one = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

export function buildPracticeDigest(db: DatabaseSync, sinceMs: number): PracticeDigest {
  const labels = new Map(
    all<{ slug: string; label: string }>(db, "SELECT slug, label FROM task_types").map((t) => [
      t.slug,
      t.label,
    ]),
  );
  const item = (row: Row): PracticeDigestItem => ({
    statement: one(row.statement, 160),
    where: describePracticeScope(
      row.scope,
      row.scope.startsWith("task:") ? labels.get(row.scope.slice("task:".length)) : undefined,
    ),
  });
  const bySpecificity = <T extends Row>(rows: T[]): T[] =>
    rows.toSorted((a, b) => practiceScopeRank(a.scope) - practiceScopeRank(b.scope));

  // Saved or confirmed: a yes to an offer or an un-retire (`confirmed`), or a
  // write that stored or raised the practice as active.
  const saved = all<Row>(
    db,
    `SELECT p.id, p.statement, p.scope, p.status FROM practices p
      WHERE p.status = 'active' AND EXISTS (
        SELECT 1 FROM practice_events e
         WHERE e.practice_id = p.id AND e.ts >= ?
           AND (e.kind = 'confirmed'
             OR (e.kind = 'stored'
                 AND json_extract(e.detail, '$.status') = 'active'
                 AND json_extract(e.detail, '$.op') IN ('add', 'promote'))))
      ORDER BY p.updated_at DESC LIMIT ?`,
    sinceMs,
    MAX_SAVED,
  ).map(item);

  // Asked and not answered. A candidate that was never offered is not
  // announced anywhere, and is not announced here.
  const awaiting = all<Row>(
    db,
    `SELECT id, statement, scope, status FROM practices
      WHERE status = 'candidate' AND offer_count > 0
      ORDER BY updated_at DESC LIMIT ?`,
    MAX_AWAITING,
  ).map(item);

  const noRepeat = bySpecificity(
    all<Row & { applied: number }>(
      db,
      `SELECT p.id, p.statement, p.scope, p.status,
              (SELECT COUNT(*) FROM practice_events a
                WHERE a.practice_id = p.id AND a.kind = 'applied') AS applied
         FROM practices p
        WHERE p.status = 'active'
          AND EXISTS (SELECT 1 FROM practice_events e
                       WHERE e.practice_id = p.id AND e.kind = 'applied' AND e.ts >= ?)
          AND NOT EXISTS (SELECT 1 FROM practice_events r
                           WHERE r.practice_id = p.id AND r.kind = 'repeat')
        ORDER BY applied DESC`,
      sinceMs,
    ),
  )
    .slice(0, MAX_NO_REPEAT)
    .map((row) => ({ ...item(row), applied: Number(row.applied) }));

  const repeats = all<Row & { times: number }>(
    db,
    `SELECT p.id, p.statement, p.scope, p.status, COUNT(*) AS times
       FROM practice_events e JOIN practices p ON p.id = e.practice_id
      WHERE e.kind = 'repeat' AND e.ts >= ?
      GROUP BY p.id ORDER BY times DESC LIMIT ?`,
    sinceMs,
    MAX_REPEATS,
  ).map((row) => ({ ...item(row), times: Number(row.times) }));

  return { saved, awaiting, noRepeat, repeats };
}

export function practiceDigestIsEmpty(d: PracticeDigest): boolean {
  return (
    d.saved.length === 0 &&
    d.awaiting.length === 0 &&
    d.noRepeat.length === 0 &&
    d.repeats.length === 0
  );
}

/**
 * News the owner has not seen: something saved or confirmed, or a repeat.
 * Waiting candidates and practices that were merely in a prompt again are
 * standing state; they ride along with a brief but do not cause one.
 */
export function practiceDigestHasNews(d: PracticeDigest): boolean {
  return d.saved.length > 0 || d.repeats.length > 0;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** The section's lines (no leading blank line), or an empty array when there is nothing to say. */
export function renderPracticeDigest(d: PracticeDigest): string[] {
  if (practiceDigestIsEmpty(d)) {
    return [];
  }
  const lines: string[] = ["What I learned from you:"];
  for (const p of d.saved) {
    lines.push(`- Saved for ${p.where}: "${p.statement}"`);
  }
  for (const p of d.awaiting) {
    lines.push(
      `- Waiting for your yes or no, for ${p.where}: "${p.statement}" (answer on the Memory page)`,
    );
  }
  if (d.noRepeat.length > 0) {
    lines.push("- Things you no longer have to repeat:");
    for (const p of d.noRepeat) {
      lines.push(
        `  - "${p.statement}" for ${p.where}: in my instructions ${times(p.applied)}, and you have not had to say it again`,
      );
    }
  }
  for (const p of d.repeats) {
    lines.push(
      `- You had to tell me again, ${times(p.times)}, for ${p.where}: "${p.statement}". I counted it and changed nothing; you can reword or re-scope it on the Memory page.`,
    );
  }
  return lines;
}
