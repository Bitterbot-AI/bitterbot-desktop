/**
 * PLAN-40 Phase 3 — Lane 3: anticipatory briefs.
 *
 * Letta's sleep-time result (arXiv 2504.13171): precomputing inferences over
 * PREDICTABLE context amortizes cost and improves answers. For a personal
 * agent, predictable = the user's demonstrably-active contexts, never
 * open-ended musing.
 *
 * Product: at most one brief per cycle, at most MAX_OPEN_BRIEFS open, each
 * grounded in >= 2 cited source rows that must actually exist. Briefs are
 * NOT chunks (adversarial F6-r2: retrieval-eligible briefs leaked
 * cross-session synthesis into group prompts) — they live in `dream_briefs`
 * and exit ONLY through the owner-gated surfacing drain (limit 1/session).
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordDreamArtifact } from "../dream-utility.js";

const log = createSubsystemLogger("memory/dream-anticipation");

export const MAX_OPEN_BRIEFS = 5;
/** Active-context window: facts/chunks touched within this window qualify. */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type AnticipationResult = {
  briefs: number;
  llmCalls: number;
  chunksAnalyzed: number;
};

export async function runAnticipation(params: {
  db: DatabaseSync;
  llmCall: ((prompt: string) => Promise<string>) | null;
  llmBudget: number;
  cycleId: string;
  now?: number;
}): Promise<AnticipationResult> {
  const { db, llmCall, cycleId } = params;
  const now = params.now ?? Date.now();
  const result: AnticipationResult = { briefs: 0, llmCalls: 0, chunksAnalyzed: 0 };
  if (!llmCall || params.llmBudget <= 0) {
    return result;
  }
  try {
    const open = (
      db.prepare(`SELECT COUNT(*) AS c FROM dream_briefs WHERE status = 'open'`).get() as {
        c: number;
      }
    ).c;
    if (open >= MAX_OPEN_BRIEFS) {
      return result;
    }
  } catch {
    return result;
  }

  // Active context: recently-confirmed canonical facts + recently-updated
  // first-party episodes/preferences. Both are things the user demonstrably
  // touched — the predictability requirement.
  let sources: Array<{ id: string; kind: string; text: string }> = [];
  try {
    const facts = db
      .prepare(
        `SELECT id, COALESCE(statement, key || ': ' || value) AS text
           FROM canonical_facts
          WHERE status = 'active' AND COALESCE(last_confirmed_at, first_seen_at) >= ?
          ORDER BY last_confirmed_at DESC LIMIT 6`,
      )
      .all(now - ACTIVE_WINDOW_MS) as Array<{ id: string; text: string }>;
    const chunks = db
      .prepare(
        `SELECT id, substr(text, 1, 400) AS text FROM chunks
          WHERE COALESCE(semantic_type, 'general') IN ('episode', 'preference', 'goal')
            AND COALESCE(origin, '') != 'dream'
            AND COALESCE(session_trust, 'first_party') = 'first_party'
            AND updated_at >= ?
          ORDER BY updated_at DESC LIMIT 6`,
      )
      .all(now - ACTIVE_WINDOW_MS) as Array<{ id: string; text: string }>;
    sources = [
      ...facts.map((f) => ({ id: `fact:${f.id}`, kind: "canonical", text: f.text })),
      ...chunks.map((c) => ({ id: `chunk:${c.id}`, kind: "chunk", text: c.text })),
    ];
  } catch (err) {
    log.debug(`anticipation context query failed: ${String(err)}`);
    return result;
  }
  if (sources.length < 2) {
    return result;
  }

  result.llmCalls++;
  result.chunksAnalyzed = sources.length;
  let parsed: { question: string; answer: string; sources: number[] } | null = null;
  try {
    const raw = await llmCall(
      `Below are the user's currently-active facts and recent context. Predict ONE ` +
        `question they are likely to ask soon, and sketch the answer from the sources ` +
        `alone. Respond as STRICT JSON: {"question": "...", "answer": "...", ` +
        `"sources": [<1-based indexes of the sources you used, at least 2>]}. If ` +
        `nothing is predictable, respond {"question": ""}.\n\n` +
        sources.map((s, i) => `${i + 1}. [${s.kind}] ${s.text}`).join("\n"),
    );
    const jsonStart = raw.indexOf("{");
    parsed = JSON.parse(raw.slice(jsonStart)) as {
      question: string;
      answer: string;
      sources: number[];
    };
  } catch (err) {
    log.debug(`anticipation LLM/parse failed: ${String(err)}`);
    return result;
  }
  // Mechanical validation (the gate's ungameable legs): non-empty product,
  // >= 2 DISTINCT cited sources, every citation resolving to an offered row.
  if (!parsed?.question?.trim() || !parsed.answer?.trim()) {
    return result;
  }
  const cited = [...new Set(parsed.sources ?? [])].filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= sources.length,
  );
  if (cited.length < 2) {
    return result;
  }
  const evidence = cited.map((n) => sources[n - 1]!.id);
  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO dream_briefs (id, context_kind, context_ref, question, answer_sketch,
         evidence_json, status, created_at)
       VALUES (?, 'active_context', NULL, ?, ?, ?, 'open', ?)`,
    ).run(
      id,
      parsed.question.trim().slice(0, 400),
      parsed.answer.trim().slice(0, 1200),
      JSON.stringify(evidence),
      now,
    );
    result.briefs++;
    recordDreamArtifact(db, {
      lane: "anticipation",
      artifactKind: "brief",
      artifactId: id,
      cycleId,
    });
  } catch (err) {
    log.debug(`anticipation brief insert failed: ${String(err)}`);
  }
  return result;
}
