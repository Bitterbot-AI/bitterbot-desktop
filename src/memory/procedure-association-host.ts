import type { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ExperienceDescriptionSchema } from "./experience-memory.js";
import {
  learningHash,
  LearningScopeSchema,
  type LearningScope,
} from "./procedural-learning-contract.js";
import {
  ProcedureAssociation,
  type AssociationContext,
  type AssociationOptions,
} from "./procedure-association.js";

/** Explicit host-only experiment. Reconstructs weights from live, scoped acquisition
 * receipts so forgetting/expiry takes effect without unlearning a second database.
 * Caller supplies already authorized candidates; this only narrows/ranks that pool.
 * No execution, random live exploration, qualification, or default activation. */
export class ProcedureAssociationHost {
  constructor(readonly store: ProceduralLearningStore) {}

  rank(params: {
    scope: LearningScope;
    verifierHash: string;
    candidates: readonly string[];
    context: AssociationContext;
    shadowEvaluation: true;
    options?: AssociationOptions;
  }): {
    status: string;
    observations: number;
    ranked: Array<{ candidate: string; score: number }>;
  } {
    const empty = { status: "unavailable", observations: 0, ranked: [] };
    if (
      this.store.config.mode !== "shadow" ||
      // Retain the literal-true runtime check for JavaScript/plugin callers.
      // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare
      params.shadowEvaluation !== true ||
      !this.store.config.experienceMemory.enabled
    )
      return empty;
    if (!/^[a-f0-9]{64}$/.test(params.verifierHash)) throw new Error("Pinned verifier required");
    const scope = LearningScopeSchema.parse(params.scope),
      scopeHash = learningHash(scope);
    if (
      params.candidates.length > 32 ||
      new Set(params.candidates).size !== params.candidates.length
    )
      throw new Error("Invalid association candidate pool");
    const allowed = params.candidates.filter((id) => {
      const entry = this.store.get(id);
      return (
        entry &&
        learningHash(entry.candidate.scope) === scopeHash &&
        this.store.usable(id) &&
        !this.store.verifierBlocked(id, params.verifierHash)
      );
    });
    if (!allowed.length) return empty;
    const model = new ProcedureAssociation(allowed, params.options);
    const rows = this.store.db
      .prepare(`SELECT e.body, r.candidate, r.input_hash, r.id, v.category
      FROM experience_evidence e JOIN learning_runs r ON r.id=e.run_id
      JOIN learning_verdicts v ON v.run_id=r.id
      WHERE e.scope=? AND r.scope=? AND r.verifier=? AND e.expires_at>?
        AND r.partition='acquisition' AND r.status='settled'
        AND v.category IN ('pass','candidate-failure')
      ORDER BY r.finished_at DESC, r.rowid DESC LIMIT ?`)
      .all(
        scopeHash,
        scopeHash,
        params.verifierHash,
        this.store.now(),
        model.options.maxObservations,
      ) as Array<{
      body: string;
      candidate: string;
      input_hash: string;
      id: string;
      category: string;
    }>;
    // Exact repeated inputs for one procedure count once. Keep the newest receipt.
    const seen = new Set<string>();
    const distinct = rows
      .filter((r) => {
        const key = `${r.candidate}:${r.input_hash}`;
        if (!allowed.includes(r.candidate) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .toReversed();
    for (const row of distinct) {
      const body = JSON.parse(row.body) as Record<string, unknown>;
      const description = ExperienceDescriptionSchema.parse({
        cue: body.cue,
        context: body.context,
        action: body.action,
        check: body.check,
        detail: body.detail,
      });
      model.observe({
        id: row.id,
        candidate: row.candidate,
        context: description.context,
        reward: row.category === "pass" ? 1 : 0,
      });
    }
    if (!model.observations) return { ...empty, status: "no-eligible-evidence" };
    return {
      status: "shadow-advisory-unqualified",
      observations: model.observations,
      ranked: model.rank(params.context),
    };
  }
}
