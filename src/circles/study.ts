/**
 * PLAN-36 Phase 4b: the study loop — the per-member half of §2.5 ("circle =
 * commons; agent = personal lens"). This module owns the member's OWN mastery
 * state for a study-guide card's sections and the spaced-repetition schedule
 * over it.
 *
 * Trust shape (§5.2 memory taint holds by construction):
 *  - Every row here is derived ONLY from this human's own quiz results
 *    (recordStudyResult, driven by their taps in the UI). It is member-own
 *    data on member-own hardware — never fanned out, never entering
 *    recall-eligible memory. The shared artifact is PROCESSED per draft;
 *    what accumulates is ours.
 *  - Slot ids land in the TRUSTED prompt frame (buildQuarantinedStudyPrompt),
 *    so they are charset-restricted here exactly like the B2 slice path;
 *    section TITLES are peer content and stay inside the untrusted envelope.
 *
 * Scheduling is a Leitner ladder (boxes 0-4 → review intervals 1d / 3d / 7d /
 * 14d / 30d): a correct answer advances the box, a miss resets it to 0. This
 * applies the PLAN-9 GAP-7 spacing effect (Ebbinghaus; spacing-effect.ts
 * boosts memory chunks by spaced ACCESS) to member mastery: expanding
 * intervals on success are the retention-optimal schedule the same literature
 * prescribes.
 */

import type { DatabaseSync } from "node:sqlite";

/** Review intervals by Leitner box (0-4). */
export const REVIEW_INTERVALS_MS: readonly number[] = [
  1 * 24 * 60 * 60_000,
  3 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  14 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];
export const MAX_BOX = REVIEW_INTERVALS_MS.length - 1;

/** Same charset rule as the B2 slice path: these strings reach the trusted prompt frame. */
const SLOT_RE = /^[a-z0-9_-]+$/i;

export type StudySectionState = {
  circleId: string;
  cardId: string;
  slot: string;
  box: number;
  correctCount: number;
  missCount: number;
  lastResult: "correct" | "missed" | null;
  lastReviewedAt: number | null;
  dueAt: number;
};

type StateRow = {
  circle_id: string;
  card_id: string;
  slot: string;
  box: number;
  correct_count: number;
  miss_count: number;
  last_result: string | null;
  last_reviewed_at: number | null;
  due_at: number;
};

function toState(r: StateRow): StudySectionState {
  return {
    circleId: r.circle_id,
    cardId: r.card_id,
    slot: r.slot,
    box: r.box,
    correctCount: r.correct_count,
    missCount: r.miss_count,
    lastResult: r.last_result === "correct" || r.last_result === "missed" ? r.last_result : null,
    lastReviewedAt: r.last_reviewed_at,
    dueAt: r.due_at,
  };
}

/**
 * A section's slice slot: "sec-" + FNV-1a of the normalized section title.
 * MIRROR of the renderer's StudyGuideCard.sectionSlot — the cross-node
 * contract pinned by golden values in StudyGuideCard.test.ts and study.test.ts
 * ("Glycolysis" → "sec-b9b14b81"). Changing either copy without the other is a
 * breaking change.
 */
export function sectionSlot(section: string): string {
  const s = section.normalize("NFC").trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `sec-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** The card's sections (one per line, deduped by slot) — mirror of the renderer's parseSections. */
export function parseSections(text: string): Array<{ section: string; slot: string }> {
  const seen = new Set<string>();
  const out: Array<{ section: string; slot: string }> = [];
  for (const line of text.split("\n")) {
    const section = line.trim();
    if (!section) continue;
    const slot = sectionSlot(section);
    if (seen.has(slot)) continue;
    seen.add(slot);
    out.push({ section, slot });
  }
  return out;
}

/**
 * Record one quiz result for a section. Correct advances the Leitner box (up
 * to MAX_BOX); a miss resets it to 0. due_at moves to now + the new box's
 * interval. Returns the updated state.
 */
export function recordStudyResult(
  db: DatabaseSync,
  args: { circleId: string; cardId: string; slot: string; correct: boolean; now?: number },
): StudySectionState {
  const now = args.now ?? Date.now();
  const slot = args.slot.slice(0, 32);
  if (!SLOT_RE.test(slot)) {
    throw new Error("slot must be alphanumeric/-/_");
  }
  const prior = db
    .prepare(`SELECT * FROM circle_study_state WHERE circle_id = ? AND card_id = ? AND slot = ?`)
    .get(args.circleId, args.cardId, slot) as StateRow | undefined;
  const box = args.correct ? Math.min((prior?.box ?? -1) + 1, MAX_BOX) : 0;
  const dueAt = now + (REVIEW_INTERVALS_MS[box] ?? REVIEW_INTERVALS_MS[0]!);
  db.prepare(
    `INSERT INTO circle_study_state
       (circle_id, card_id, slot, box, correct_count, miss_count, last_result,
        last_reviewed_at, due_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(circle_id, card_id, slot) DO UPDATE SET
       box = excluded.box,
       correct_count = circle_study_state.correct_count + excluded.correct_count,
       miss_count = circle_study_state.miss_count + excluded.miss_count,
       last_result = excluded.last_result,
       last_reviewed_at = excluded.last_reviewed_at,
       due_at = excluded.due_at,
       updated_at = excluded.updated_at`,
  ).run(
    args.circleId,
    args.cardId,
    slot,
    box,
    args.correct ? 1 : 0,
    args.correct ? 0 : 1,
    args.correct ? "correct" : "missed",
    now,
    dueAt,
    now,
  );
  return {
    circleId: args.circleId,
    cardId: args.cardId,
    slot,
    box,
    correctCount: (prior?.correct_count ?? 0) + (args.correct ? 1 : 0),
    missCount: (prior?.miss_count ?? 0) + (args.correct ? 0 : 1),
    lastResult: args.correct ? "correct" : "missed",
    lastReviewedAt: now,
    dueAt,
  };
}

/** This member's study state, per card or for the whole circle. */
export function listStudyState(
  db: DatabaseSync,
  circleId: string,
  cardId?: string,
): StudySectionState[] {
  const rows = (cardId
    ? db
        .prepare(
          `SELECT * FROM circle_study_state WHERE circle_id = ? AND card_id = ?
              ORDER BY due_at ASC`,
        )
        .all(circleId, cardId)
    : db
        .prepare(`SELECT * FROM circle_study_state WHERE circle_id = ? ORDER BY due_at ASC`)
        .all(circleId)) as unknown as StateRow[];
  return rows.map(toState);
}

/**
 * The TRUSTED-frame mastery summary for the quarantined study prompt. Built
 * exclusively from this member's own rows; slot ids were charset-restricted
 * at write time and are re-filtered here (defense in depth — nothing
 * frame-breaking can appear even if a row was written by a future bug).
 */
export function buildMasterySummary(
  db: DatabaseSync,
  args: { circleId: string; cardId: string; now?: number },
): string {
  const now = args.now ?? Date.now();
  const rows = listStudyState(db, args.circleId, args.cardId).filter((s) => SLOT_RE.test(s.slot));
  if (rows.length === 0) {
    return "No quiz history yet — treat every section as untouched and weight questions evenly.";
  }
  const day = 24 * 60 * 60_000;
  return rows
    .map((s) => {
      const due =
        s.dueAt <= now ? "due NOW" : `due in ~${Math.max(1, Math.round((s.dueAt - now) / day))}d`;
      return `- section ${s.slot}: box ${s.box}/${MAX_BOX}, ${s.correctCount} correct / ${s.missCount} missed, ${due}`;
    })
    .join("\n");
}
