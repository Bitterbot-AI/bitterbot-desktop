import { performance } from "node:perf_hooks";
import {
  learningHash,
  LearningScopeSchema,
  type LearningAdapter,
  type LearningScope,
} from "./procedural-learning-contract.js";
import { ProceduralLearning, type LearningRunRequest } from "./procedural-learning.js";

export type WorkflowContract = {
  adapter: LearningAdapter;
  /** Host-owned, synchronous, pure input validation. No probing or model calls here. */
  accepts(input: unknown): boolean;
  inputContractHash: string;
};

export type WorkflowReuseResult = {
  requestId: string;
  disposition: "verified-output" | "fallback" | "stopped";
  reason: string;
  candidate?: string;
  runId?: string;
  output?: unknown;
};

/** Opt-in host capability for isolated shadow workflows. Ordinary agent tools,
 * dreams and peer packages cannot bypass qualification by calling this facade.
 * A miss returns control to the caller; it never starts an implicit repair. */
export class VerifiedWorkflowReuse {
  private readonly contracts = new Map<string, WorkflowContract>();

  constructor(readonly learning: ProceduralLearning) {
    if (learning.store.config.mode !== "shadow")
      throw new Error("Workflow reuse is available only in shadow");
    learning.store.db.exec(`CREATE TABLE IF NOT EXISTS workflow_reuse (
      id TEXT PRIMARY KEY, scope_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
      candidate TEXT, verifier TEXT, request TEXT NOT NULL, result TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER, overhead_ms REAL)`);
  }

  register(contract: WorkflowContract): void {
    if (contract.adapter.isolation !== "sandbox") throw new Error("Sandbox required");
    if (!/^[a-f0-9]{64}$/.test(contract.inputContractHash))
      throw new Error("Input contract fingerprint required");
    const key = learningHash(LearningScopeSchema.parse(contract.adapter.scope));
    if (this.contracts.has(key)) throw new Error("Workflow scope already registered");
    // A changed applicability contract invalidates qualification even when the
    // output checker and procedure scope have not otherwise changed.
    const adapter = {
      ...contract.adapter,
      verifierHash: learningHash({
        verifier: contract.adapter.verifierHash,
        inputContract: contract.inputContractHash,
      }),
    };
    this.learning.registerAdapter(adapter);
    this.contracts.set(
      key,
      Object.freeze({
        ...contract,
        adapter: Object.freeze({
          ...adapter,
          scope: Object.freeze({ ...contract.adapter.scope }),
          qualificationCases: structuredClone(contract.adapter.qualificationCases),
        }),
      }),
    );
  }

  private qualified(candidate: string, contract: WorkflowContract): boolean {
    const { store } = this.learning;
    const entry = store.get(candidate);
    if (
      !entry ||
      entry.state !== "verified" ||
      !store.usable(candidate) ||
      entry.candidate.adapter !== contract.adapter.id ||
      store.verifierBlocked(candidate, contract.adapter.verifierHash)
    )
      return false;
    // "Verified" under an old oracle is not qualification under a new oracle.
    return contract.adapter.qualificationCases.every((input) =>
      Boolean(
        store.db
          .prepare(`
      SELECT 1 FROM learning_runs r JOIN learning_verdicts v ON v.run_id=r.id
      WHERE r.candidate=? AND r.verifier=? AND r.input_hash=?
        AND r.partition='acquisition' AND r.status='settled' AND r.passed=1
        AND v.category='pass' LIMIT 1`)
          .get(candidate, contract.adapter.verifierHash, learningHash(input)),
      ),
    );
  }

  available(scope: LearningScope): string[] {
    const parsed = LearningScopeSchema.parse(scope);
    const contract = this.contracts.get(learningHash(parsed));
    return contract
      ? this.learning.store
          .retrieve(parsed, true)
          .filter((e) => this.qualified(e.hash, contract))
          .map((e) => e.hash)
      : [];
  }

  async reuse(
    params: Omit<LearningRunRequest, "candidate" | "shadowEvaluation"> & {
      requestId: string;
      candidate?: string;
      shadowEvaluation: true;
    },
  ): Promise<WorkflowReuseResult> {
    if (params.shadowEvaluation !== true) throw new Error("Explicit shadow execution required");
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(params.requestId)) throw new Error("Invalid request ID");
    const start = performance.now();
    const scope = LearningScopeSchema.parse(params.scope),
      scopeHash = learningHash(scope);
    // Snapshot before yielding: callers cannot change the checked input during execution.
    const input = structuredClone(params.input),
      inputHash = learningHash(input);
    const { store } = this.learning;
    const prior = store.db
      .prepare("SELECT request FROM workflow_reuse WHERE id=?")
      .get(params.requestId);
    if (prior)
      throw new Error(
        "Workflow request already recorded; inspect receipt, never implicitly replay",
      );
    const contract = this.contracts.get(scopeHash);
    const candidates = this.available(scope);
    const candidate = params.candidate ?? candidates[0];
    let reason = !contract
      ? "scope-unavailable"
      : !candidate || !candidates.includes(candidate)
        ? "no-qualified-workflow"
        : "ready";
    if (reason === "ready" && !contract!.accepts(structuredClone(input)))
      reason = "input-contract-mismatch";
    const request = {
      scope,
      inputHash,
      partition: params.partition,
      predictedSuccess: params.predictedSuccess,
      inputContractHash: contract?.inputContractHash ?? null,
    };
    store.db
      .prepare("INSERT INTO workflow_reuse VALUES (?,?,?,?,?,?,NULL,?,NULL,NULL)")
      .run(
        params.requestId,
        scopeHash,
        inputHash,
        candidate ?? null,
        contract?.adapter.verifierHash ?? null,
        JSON.stringify(request),
        store.now(),
      );
    const finish = (result: WorkflowReuseResult, executionMs = 0) => {
      // Keep output content out of the audit store; retain its digest and provenance.
      const { output, ...receipt } = result;
      store.db
        .prepare("UPDATE workflow_reuse SET result=?,finished_at=?,overhead_ms=? WHERE id=?")
        .run(
          JSON.stringify({
            ...receipt,
            outputHash: output === undefined ? null : learningHash(output),
          }),
          store.now(),
          Math.max(0, performance.now() - start - executionMs),
          params.requestId,
        );
      return result;
    };
    if (reason !== "ready")
      return finish({ requestId: params.requestId, disposition: "fallback", reason });
    const executionStart = performance.now();
    try {
      const result = await this.learning.run({
        ...params,
        scope,
        input,
        candidate: candidate!,
        shadowEvaluation: true,
      });
      if (
        result.classification === "candidate-failure" ||
        result.classification === "verifier-invalid"
      ) {
        // Pause availability without revoking the lineage. An unchanged panel
        // must not wash away a later counterexample or a broken verifier.
        store.dequalify(candidate!, contract!.adapter.verifierHash);
        store.audit(`workflow-${result.classification}-qualification-withdrawn`, candidate!);
      }
      const stopped =
        result.classification === "verifier-invalid" || result.classification === "interrupted";
      return finish(
        {
          requestId: params.requestId,
          candidate,
          runId: result.runId,
          disposition: result.passed ? "verified-output" : stopped ? "stopped" : "fallback",
          reason: result.classification ?? result.reason ?? "unavailable",
          ...(result.passed ? { output: result.output } : {}),
        },
        performance.now() - executionStart,
      );
    } catch (error) {
      finish(
        {
          requestId: params.requestId,
          candidate,
          disposition: "stopped",
          reason: error instanceof Error ? error.message : "execution-blocked",
        },
        performance.now() - executionStart,
      );
      throw error;
    }
  }
}

export type PracticeOpportunity = {
  id: string;
  expectedUses: number;
  successes: number;
  failures: number;
  /** Quotes include generation, verification and unsuccessful attempts. */
  quotedCost: number;
};

/** Fixed empirical learnability hypothesis. Evidence must be acquisition-only;
 * hormones/embedding novelty never enter this score. No efficacy claim. */
export function prioritizeWorkflowPractice(items: readonly PracticeOpportunity[]): string[] {
  if (new Set(items.map((x) => x.id)).size !== items.length)
    throw new Error("Duplicate opportunity");
  const scored = items.map((x) => {
    if (
      !x.id ||
      ![x.expectedUses, x.successes, x.failures, x.quotedCost].every(Number.isFinite) ||
      x.expectedUses < 0 ||
      x.quotedCost <= 0 ||
      !Number.isInteger(x.successes) ||
      !Number.isInteger(x.failures) ||
      x.successes < 0 ||
      x.failures < 0
    )
      throw new Error("Invalid practice evidence");
    const p = (x.successes + 1) / (x.successes + x.failures + 2);
    return { id: x.id, score: (x.expectedUses * p * (1 - p)) / x.quotedCost };
  });
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((x) => x.id);
}
