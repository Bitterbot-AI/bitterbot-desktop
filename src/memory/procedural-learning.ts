import { randomUUID } from "node:crypto";
import { ExperienceMemory } from "./experience-memory.js";
import { LearningStrategyLab } from "./learning-strategy.js";
import {
  addLearningCost,
  LearningCostSchema,
  LearningScopeSchema,
  LearningVerdictSchema,
  learningHash,
  withinLearningBudget,
  type LearningAdapter,
  type LearningCost,
  type LearningEntry,
  type LearningScope,
  type LearningVerdict,
} from "./procedural-learning-contract.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProcedureAssociationHost } from "./procedure-association-host.js";

/** Host-owned execution boundary. Candidate text, dreams and peer receipts cannot
 * register verifiers or mark a lesson as verified. All spending has a durable intent. */
export class ProceduralLearning {
  private readonly adapters = new Map<string, LearningAdapter>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  readonly experience: ExperienceMemory;
  readonly associations: ProcedureAssociationHost;
  private strategyLab: LearningStrategyLab | null = null;
  /** Explicit host access only. Lazy construction does not enable background learning. */
  get strategies(): LearningStrategyLab {
    return (this.strategyLab ??= new LearningStrategyLab(this.store));
  }
  constructor(readonly store: ProceduralLearningStore) {
    this.experience = new ExperienceMemory(store);
    this.associations = new ProcedureAssociationHost(store);
  }
  registerAdapter(adapter: LearningAdapter): void {
    LearningScopeSchema.parse(adapter.scope);
    if (
      !adapter.id ||
      !/^[a-f0-9]{64}$/.test(adapter.verifierHash) ||
      !["read-only", "sandbox"].includes(adapter.isolation)
    )
      throw new Error("Invalid host adapter");
    if (this.adapters.has(adapter.id)) throw new Error("Adapter already registered");
    if (
      adapter.qualificationCases.length < 2 ||
      adapter.qualificationCases.length > 100 ||
      new Set(adapter.qualificationCases.map(learningHash)).size !==
        adapter.qualificationCases.length
    )
      throw new Error("Invalid qualification panel");
    // Freeze identity; do not allow a caller to silently replace a pinned verifier.
    this.adapters.set(
      adapter.id,
      Object.freeze({
        ...adapter,
        scope: Object.freeze({ ...adapter.scope }),
        qualificationCases: structuredClone(adapter.qualificationCases),
      }),
    );
  }

  run(params: LearningRunRequest): Promise<LearningRunResult> {
    if (this.closing) return Promise.reject(new Error("Learning service is closing"));
    const pending = this.runInternal(params);
    this.inFlight.add(pending);
    void pending.then(
      () => this.inFlight.delete(pending),
      () => this.inFlight.delete(pending),
    );
    return pending;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.inFlight);
    await this.strategyLab?.close();
    this.store.db.close();
  }

  async qualify(params: Omit<LearningRunRequest, "input" | "partition">): Promise<boolean> {
    const entry = this.store.get(params.candidate);
    const adapter = entry && this.adapters.get(entry.candidate.adapter);
    if (!entry || !adapter) throw new Error("Unknown candidate adapter");
    for (const input of adapter.qualificationCases) {
      const result = await this.run({ ...params, input, partition: "acquisition" });
      if (!result.passed) return false;
    }
    if (!this.store.usable(entry.hash)) return false;
    this.store.db
      .prepare("UPDATE learning_entries SET state='verified' WHERE hash=? AND state='candidate'")
      .run(entry.hash);
    this.store.audit("qualified", entry.hash);
    return true;
  }

  private async runInternal(params: LearningRunRequest): Promise<LearningRunResult> {
    if (
      this.store.config.mode === "off" ||
      (this.store.config.mode === "shadow" && !params.shadowEvaluation)
    )
      throw new Error("Procedural execution is disabled in shadow mode");
    const entry = this.store.get(params.candidate);
    if (!entry || !this.store.usable(entry.hash))
      throw new Error("Unavailable, expired or revoked procedure");
    if (
      learningHash(LearningScopeSchema.parse(params.scope)) !== learningHash(entry.candidate.scope)
    )
      throw new Error("Incompatible procedure scope");
    const adapter = this.adapters.get(entry.candidate.adapter);
    if (!adapter || learningHash(adapter.scope) !== learningHash(params.scope))
      throw new Error("No compatible host adapter");
    if (this.store.verifierBlocked(entry.hash, adapter.verifierHash))
      throw new Error("Verifier revision blocked; repair and register a new verifier revision");
    if (
      params.partition === "held-out" &&
      adapter.qualificationCases.some((input) => learningHash(input) === learningHash(params.input))
    )
      throw new Error("Qualification/evaluation overlap");
    if (params.shadowEvaluation && adapter.isolation !== "sandbox")
      throw new Error("Shadow evaluations require a sandbox adapter");
    if (
      !Number.isFinite(params.predictedSuccess) ||
      params.predictedSuccess < 0 ||
      params.predictedSuccess > 1
    )
      throw new Error("Invalid forecast");
    params.signal?.throwIfAborted();
    const budget = LearningCostSchema.parse(params.budget);
    const quote = LearningCostSchema.parse(adapter.quote(entry.candidate.program, params.input));
    const runId = randomUUID();
    this.store.reserve(
      {
        id: runId,
        candidate: entry.hash,
        scope: params.scope,
        inputHash: learningHash(params.input),
        verifier: adapter.verifierHash,
        partition: params.partition,
        quote,
        predicted: params.predictedSuccess,
      },
      budget,
    );
    const start = performance.now();
    // The adapter must cooperatively cancel: do not settle an unobserved in-flight
    // operation as free, and never retry an interrupted operation automatically.
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.ceil(quote.wallMs))));
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    let stage: "execute" | "verify" = "execute";
    try {
      const execution = await adapter.execute(entry.candidate.program, params.input, signal);
      signal.throwIfAborted();
      const executedCost = LearningCostSchema.parse(execution.cost);
      if (!withinLearningBudget(executedCost, quote)) {
        executedCost.wallMs = Math.max(executedCost.wallMs, performance.now() - start);
        this.store.finish(runId, false, executedCost, "resource-exhausted");
        if (params.partition === "acquisition") this.store.dequalify(entry.hash);
        return {
          runId,
          passed: false,
          classification: "resource-exhausted",
          reason: "Adapter exceeded reserved cost",
        };
      }
      stage = "verify";
      const verification = await adapter.verify(params.input, execution.output, signal);
      signal.throwIfAborted();
      const cost = addLearningCost(executedCost, LearningCostSchema.parse(verification.cost));
      cost.wallMs = Math.max(cost.wallMs, performance.now() - start);
      let classification = LearningVerdictSchema.parse(
        verification.classification ?? (verification.passed ? "pass" : "candidate-failure"),
      );
      if (
        typeof verification.passed !== "boolean" ||
        (classification === "pass") !== verification.passed
      )
        classification = "verifier-invalid";
      if (!withinLearningBudget(cost, quote)) classification = "resource-exhausted";
      const valid = classification === "pass" && this.store.usable(entry.hash);
      if (!valid && classification === "pass") classification = "interrupted";
      this.store.finish(runId, valid, cost, classification);
      if (
        this.store.config.experienceMemory.enabled &&
        params.partition === "acquisition" &&
        adapter.describeExperience &&
        (classification === "pass" || classification === "candidate-failure")
      ) {
        try {
          this.experience.attach(runId, adapter.describeExperience(params.input, execution.output));
        } catch {
          // Optional memory must not change an already settled outcome or its accounting.
          this.store.audit("experience-extraction-skipped", runId);
        }
      }
      if (!valid && params.partition === "acquisition") {
        if (classification === "candidate-failure")
          this.store.revoke(entry.hash, "failed-current-outcome-verification");
        else
          this.store.dequalify(
            entry.hash,
            classification === "verifier-invalid" ? adapter.verifierHash : undefined,
          );
      }
      return valid
        ? { runId, passed: true, classification, output: execution.output }
        : { runId, passed: false, classification, reason: classification };
    } catch {
      // An exception does not tell us how much the external operation spent.
      const classification =
        stage === "verify" && !signal.aborted ? "verifier-invalid" : "interrupted";
      this.store.finish(runId, false, null, classification);
      if (params.partition === "acquisition")
        this.store.dequalify(
          entry.hash,
          classification === "verifier-invalid" ? adapter.verifierHash : undefined,
        );
      return {
        runId,
        passed: false,
        classification,
        reason: "interrupted-or-adapter-error; cost requires reconciliation",
      };
    }
  }

  lookup(scope: LearningScope): { mode: string; lessons: LearningEntry[]; shadowMatches: number } {
    const parsed = LearningScopeSchema.parse(scope);
    const shadowMatches = this.store.retrieve(parsed, true).length;
    return { mode: this.store.config.mode, lessons: this.store.retrieve(parsed), shadowMatches };
  }

  /** Replay schedules tests; it never fabricates evidence or promotes memories. */
  replay(): { expired: number; candidates: string[] } {
    const maintenance = this.store.maintain();
    this.experience.maintain();
    const rows = this.store.db
      .prepare(
        "SELECT hash FROM learning_entries WHERE state='candidate' AND expires_at>? ORDER BY created_at,hash LIMIT ?",
      )
      .all(this.store.now(), this.store.config.maxResults) as { hash: string }[];
    return {
      ...maintenance,
      candidates: rows.filter((row) => this.store.usable(row.hash)).map((row) => row.hash),
    };
  }

  status(): Record<string, unknown> {
    const counts = this.store.db
      .prepare("SELECT state,COUNT(*) AS count FROM learning_entries GROUP BY state")
      .all();
    const calibration = this.store.db
      .prepare(`SELECT partition, COUNT(*) AS n,
      AVG((predicted-passed)*(predicted-passed)) AS brier,
      AVG(passed) AS verifiedSuccess FROM learning_runs r JOIN learning_verdicts v ON v.run_id=r.id
      WHERE status='settled' AND v.category IN ('pass','candidate-failure') GROUP BY partition`)
      .all();
    return {
      mode: this.store.config.mode,
      counts,
      costs: this.store.costs(),
      calibration,
      verdicts: this.store.db
        .prepare("SELECT category,COUNT(*) AS n FROM learning_verdicts GROUP BY category")
        .all(),
      recentEpisodes: this.store.db
        .prepare("SELECT id,body FROM learning_episodes ORDER BY created_at DESC LIMIT 20")
        .all(),
      registeredAdapters: [...this.adapters.keys()],
      toolScopes: this.store.config.toolScopes,
      qualificationMeaning:
        "Finite host-authored behavioral checks; explanatory prose is not independently proven",
      efficacyEstablished: false,
    };
  }
}

export type LearningRunRequest = {
  candidate: string;
  input: unknown;
  scope: LearningScope;
  budget: LearningCost;
  partition: "acquisition" | "held-out";
  predictedSuccess: number;
  signal?: AbortSignal;
  shadowEvaluation?: boolean;
};
export type LearningRunResult = {
  runId: string;
  passed: boolean;
  output?: unknown;
  reason?: string;
  classification?: LearningVerdict;
};

/** Transparent scheduling hypothesis. Forecasts are logged, not treated as evidence. */
export function rankLearningInvestigations(
  items: Array<{
    id: string;
    expectedUses: number;
    predictedGain: number;
    valuePerSuccess: number;
    totalCost: number;
  }>,
): Array<{ id: string; expectedNetValue: number }> {
  return items
    .map((item) => {
      if (
        ![item.expectedUses, item.predictedGain, item.valuePerSuccess, item.totalCost].every(
          (v) => Number.isFinite(v) && v >= 0,
        ) ||
        item.predictedGain > 1
      )
        throw new Error("Invalid investigation forecast");
      return {
        id: item.id,
        expectedNetValue:
          item.expectedUses * item.predictedGain * item.valuePerSuccess - item.totalCost,
      };
    })
    .filter((item) => item.expectedNetValue > 0)
    .toSorted((a, b) => b.expectedNetValue - a.expectedNetValue || a.id.localeCompare(b.id));
}
