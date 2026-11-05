import { z } from "zod";
import type { ProceduralLearningStore } from "./procedural-learning-store.js";
import {
  learningHash,
  LearningScopeSchema,
  type LearningScope,
} from "./procedural-learning-contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), z.string().min(1).max(200))
  .refine((value) => Object.keys(value).length <= 16, "Too many context features");
export const ExperienceDescriptionSchema = z
  .object({
    cue: z.string().trim().min(1).max(600),
    context: contextSchema,
    action: z.string().trim().min(1).max(2000),
    check: z.string().trim().min(1).max(600),
    detail: z.string().max(6000),
  })
  .strict();
export const ExperienceLessonSchema = z
  .object({
    scope: LearningScopeSchema,
    cue: z.string().trim().min(1).max(600),
    when: contextSchema,
    lesson: z.string().trim().min(1).max(1600),
    check: z.string().trim().min(1).max(600),
    avoid: z.array(z.string().min(1).max(400)).min(1).max(8),
    sources: z.array(hash).min(2).max(16),
  })
  .strict();
export const ExperienceRecallSchema = z
  .object({
    scope: LearningScopeSchema,
    query: z.string().trim().min(1).max(4000),
    context: contextSchema.default({}),
    kind: z.enum(["lessons", "episodes"]).default("lessons"),
  })
  .strict();
export type ExperienceDescription = z.infer<typeof ExperienceDescriptionSchema>;
export type ExperienceLesson = z.infer<typeof ExperienceLessonSchema>;
type Evidence = ExperienceDescription & {
  id: string;
  runId: string;
  candidate: string;
  inputHash: string;
  scope: LearningScope;
  outcome: "pass" | "candidate-failure";
  occurredAt: number;
  expiresAt: number;
};
type StoredLesson = ExperienceLesson & { id: string; createdAt: number };
type Receipt = {
  candidate: string;
  input_hash: string;
  scope: string;
  partition: string;
  status: string;
  category: string;
  finished_at: number;
};

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
/** BM25 is a transparent lexical control, not a learned embedding or success probability. */
export function rankExperienceText<T>(
  items: T[],
  query: string,
  describe: (item: T) => string,
): T[] {
  const documents = items.map((item) => words(describe(item)));
  const terms = [...new Set(words(query))];
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, items.length);
  const documentFrequency = new Map<string, number>();
  const frequencies = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const word of document) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of counts.keys())
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    return counts;
  });
  return items
    .map((item, index) => {
      const document = documents[index];
      const score = terms.reduce((total, term) => {
        const count = frequencies[index].get(term) ?? 0;
        const df = documentFrequency.get(term) ?? 0;
        return (
          total +
          (Math.log(1 + (items.length - df + 0.5) / (df + 0.5)) * count * 2.2) /
            (count + 1.2 * (0.25 + (0.75 * document.length) / Math.max(1, average)))
        );
      }, 0);
      return { item, score, index };
    })
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.item);
}

/** Advisory memory in the existing per-agent evidence database. No method executes,
 * qualifies, shares, or expands permissions. Only settled host receipts can be attached. */
export class ExperienceMemory {
  constructor(readonly store: ProceduralLearningStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS experience_evidence (
      id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL, scope TEXT NOT NULL,
      body TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS experience_evidence_scope ON experience_evidence(scope,expires_at);
      CREATE TABLE IF NOT EXISTS experience_lessons (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS experience_forgotten (id TEXT PRIMARY KEY)`);
  }
  private enabled(shadowEvaluation = false): boolean {
    return (
      this.store.config.experienceMemory.enabled &&
      (this.store.config.mode === "active" ||
        (shadowEvaluation && this.store.config.mode === "shadow"))
    );
  }
  /** Host-only. Metadata is explicitly redacted by the registered adapter. */
  attach(runId: string, description: unknown): string | null {
    if (!this.store.config.experienceMemory.enabled || this.store.config.mode === "off")
      return null;
    const parsed = ExperienceDescriptionSchema.parse(description);
    const receipt = this.store.db
      .prepare(`SELECT r.*,v.category FROM learning_runs r
      JOIN learning_verdicts v ON v.run_id=r.id WHERE r.id=?`)
      .get(runId) as Receipt | undefined;
    if (
      !receipt ||
      receipt.partition !== "acquisition" ||
      receipt.status !== "settled" ||
      !["pass", "candidate-failure"].includes(receipt.category)
    )
      throw new Error("Experience requires a settled acquisition outcome");
    const candidate = this.store.get(receipt.candidate);
    if (!candidate || candidate.candidate.expiresAt <= this.store.now())
      throw new Error("Expired experience");
    const id = learningHash({ runId, description: parsed });
    if (
      this.store.db
        .prepare("SELECT id FROM experience_forgotten WHERE id IN (?,?)")
        .get(id, `run:${runId}`)
    )
      return null;
    const prior = this.store.db
      .prepare("SELECT id FROM experience_evidence WHERE run_id=?")
      .get(runId) as { id: string } | undefined;
    if (prior) {
      if (prior.id !== id) throw new Error("Immutable experience receipt");
      return id;
    }
    this.maintain();
    this.capacity("experience_evidence", this.store.config.maxEntries * 16);
    const evidence: Evidence = {
      ...parsed,
      id,
      runId,
      candidate: receipt.candidate,
      inputHash: receipt.input_hash,
      scope: candidate.candidate.scope,
      outcome: receipt.category as Evidence["outcome"],
      occurredAt: receipt.finished_at,
      expiresAt: candidate.candidate.expiresAt,
    };
    this.store.db
      .prepare("INSERT INTO experience_evidence VALUES (?,?,?,?,?)")
      .run(id, runId, receipt.scope, JSON.stringify(evidence), evidence.expiresAt);
    this.store.audit("experience-attached", id);
    return id;
  }
  private capacity(table: "experience_evidence" | "experience_lessons", limit: number): void {
    const { n } = this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    if (n >= limit) throw new Error("Experience capacity reached");
  }
  private evidence(id: string): Evidence | null {
    const row = this.store.db
      .prepare("SELECT body FROM experience_evidence WHERE id=? AND expires_at>?")
      .get(id, this.store.now()) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Evidence) : null;
  }
  /** Model-authored explanatory text remains advisory even when sources passed. */
  consolidate(input: unknown): string {
    if (!this.store.config.experienceMemory.enabled || this.store.config.mode === "off")
      throw new Error("Experience disabled");
    const lesson = ExperienceLessonSchema.parse(input);
    if (new Set(lesson.sources).size !== lesson.sources.length) throw new Error("Duplicate source");
    const sources = lesson.sources.map((id) => this.evidence(id));
    if (
      sources.some((source) => !source || learningHash(source.scope) !== learningHash(lesson.scope))
    )
      throw new Error("Missing, expired or incompatible evidence");
    const observed = sources as Evidence[];
    if (
      new Set(observed.map((source) => source.inputHash)).size <
        this.store.config.experienceMemory.minSupport ||
      !observed.some((source) => source.outcome === "pass")
    )
      throw new Error("Insufficient independent support");
    if (
      !observed.every((source) =>
        Object.entries(lesson.when).every(([key, value]) => source.context[key] === value),
      )
    )
      throw new Error("Applicability is not observed in cited evidence");
    const id = learningHash(lesson);
    if (this.store.db.prepare("SELECT id FROM experience_forgotten WHERE id=?").get(id))
      throw new Error("This lesson was explicitly forgotten");
    if (this.store.db.prepare("SELECT id FROM experience_lessons WHERE id=?").get(id)) return id;
    this.maintain();
    this.capacity("experience_lessons", this.store.config.maxEntries);
    const body: StoredLesson = { ...lesson, id, createdAt: this.store.now() };
    this.store.db
      .prepare("INSERT INTO experience_lessons VALUES (?,?,?,?)")
      .run(id, learningHash(lesson.scope), JSON.stringify(body), body.createdAt);
    this.store.audit("experience-consolidated-advisory", id);
    return id;
  }
  recall(
    input: unknown,
    shadowEvaluation = false,
  ): { mode: string; items: unknown[]; characters: number } {
    const request = ExperienceRecallSchema.parse(input);
    const empty = { mode: this.store.config.mode, items: [], characters: 2 };
    if (!this.enabled(shadowEvaluation)) return empty;
    const scopeHash = learningHash(request.scope);
    const evidenceRows = this.store.db
      .prepare("SELECT body FROM experience_evidence WHERE scope=? AND expires_at>? ORDER BY id")
      .all(scopeHash, this.store.now()) as { body: string }[];
    const allEvidence = evidenceRows.map((row) => JSON.parse(row.body) as Evidence);
    const matches = (conditions: Record<string, string>) =>
      Object.entries(conditions).every(
        ([key, value]) => request.context[key] === undefined || request.context[key] === value,
      );
    let pool: Array<Record<string, unknown>> = [];
    if (request.kind === "lessons") {
      const rows = this.store.db
        .prepare("SELECT body FROM experience_lessons WHERE scope=? ORDER BY id")
        .all(scopeHash) as { body: string }[];
      pool = rows
        .map((row) => JSON.parse(row.body) as StoredLesson)
        .filter(
          (lesson) =>
            matches(lesson.when) &&
            lesson.sources.every((id) => allEvidence.some((source) => source.id === id)),
        )
        .map(({ createdAt: _createdAt, ...lesson }) => ({
          ...lesson,
          status: "advisory-derived-not-verified",
          applicability: Object.keys(lesson.when).every((key) => request.context[key] !== undefined)
            ? "matched"
            : "check-conditions",
          outcomes: lesson.sources.map(
            (id) => allEvidence.find((source) => source.id === id)!.outcome,
          ),
          contradictions: allEvidence
            .filter(
              (source) =>
                source.outcome === "candidate-failure" &&
                lesson.sources.some(
                  (id) => allEvidence.find((e) => e.id === id)?.candidate === source.candidate,
                ),
            )
            .map((source) => source.id),
        }));
    }
    // Cold-start fallback retains concrete experience; no model call or fabricated lesson.
    if (!pool.length)
      pool = allEvidence
        .filter((source) => matches(source.context))
        .map(({ detail: _detail, ...source }) => ({
          ...source,
          status: "observed-outcome-explanation-unverified",
        }));
    const ranked = rankExperienceText(pool, request.query, (item) => JSON.stringify(item));
    const items: unknown[] = [];
    for (const item of ranked) {
      if (items.length >= this.store.config.maxResults) break;
      if (
        JSON.stringify([...items, item]).length <= this.store.config.experienceMemory.maxPromptChars
      )
        items.push(item);
    }
    return { mode: this.store.config.mode, items, characters: JSON.stringify(items).length };
  }
  expand(id: string, shadowEvaluation = false): Evidence | null {
    if (!this.enabled(shadowEvaluation)) return null;
    return this.evidence(hash.parse(id));
  }
  forget(id: string): void {
    hash.parse(id);
    const source = this.evidence(id);
    if (source)
      this.store.db
        .prepare("INSERT OR IGNORE INTO experience_forgotten VALUES (?)")
        .run(`run:${source.runId}`);
    this.store.db.prepare("INSERT OR IGNORE INTO experience_forgotten VALUES (?)").run(id);
    this.store.db.prepare("DELETE FROM experience_evidence WHERE id=?").run(id);
    this.store.db.prepare("DELETE FROM experience_lessons WHERE id=?").run(id);
    this.maintain();
    this.store.audit("experience-forgotten", id);
  }
  maintain(): void {
    this.store.db
      .prepare("DELETE FROM experience_evidence WHERE expires_at<=?")
      .run(this.store.now());
    const rows = this.store.db.prepare("SELECT id,body FROM experience_lessons").all() as {
      id: string;
      body: string;
    }[];
    for (const row of rows)
      if ((JSON.parse(row.body) as StoredLesson).sources.some((id) => !this.evidence(id)))
        this.store.db.prepare("DELETE FROM experience_lessons WHERE id=?").run(row.id);
  }
}
