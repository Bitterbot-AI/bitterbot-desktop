import { randomUUID } from "node:crypto";
import { LearningStrategyArchive } from "./learning-strategy-archive.js";
import {
  StrategyEditSchema,
  StrategyAppendSchema,
  StrategyConditionalEditSchema,
  type LearningStrategy,
  type StrategyPanel,
  type StrategyEvaluation,
} from "./learning-strategy-contract.js";
import {
  addLearningCost,
  LearningCostSchema,
  learningHash,
  withinLearningBudget,
  type LearningCost,
} from "./procedural-learning-contract.js";
import type { ProceduralLearningStore } from "./procedural-learning-store.js";

/** Host-only research capability. No background work, model tool, or live activation. */
export class LearningStrategyLab {
  readonly archive: LearningStrategyArchive;
  private readonly panels = new Map<string, StrategyPanel>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(readonly store: ProceduralLearningStore) {
    this.archive = new LearningStrategyArchive(store);
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Strategy lab closing"));
    const promise = work();
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending);
  }
  registerPanel(panel: StrategyPanel): void {
    this.archive.requireShadow();
    if (
      !panel.id ||
      panel.id.length > 200 ||
      !panel.model ||
      !/^[a-f0-9]{64}$/.test(panel.verifierHash) ||
      panel.isolation !== "sandbox" ||
      (panel.reminderFacts !== undefined &&
        (!panel.reminderFacts.length ||
          panel.reminderFacts.length > 64 ||
          new Set(panel.reminderFacts).size !== panel.reminderFacts.length ||
          panel.reminderFacts.some((fact) => !/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(fact)))) ||
      (panel.feedbackLimit !== undefined &&
        (!Number.isInteger(panel.feedbackLimit) ||
          panel.feedbackLimit < 1 ||
          panel.feedbackLimit > 32000)) ||
      !["development", "held-out"].includes(panel.partition) ||
      panel.cases.length < 2 ||
      panel.cases.length > 100 ||
      new Set(panel.cases.map((c) => c.id)).size !== panel.cases.length
    )
      throw new Error("Invalid pinned strategy panel");
    const cases = panel.cases.map((item) => ({ id: item.id, inputHash: learningHash(item.input) }));
    if (new Set(cases.map((item) => item.inputHash)).size !== cases.length)
      throw new Error("Duplicate panel inputs");
    const body = JSON.stringify({
      id: panel.id,
      scope: panel.scope,
      partition: panel.partition,
      model: panel.model,
      verifierHash: panel.verifierHash,
      sharing: panel.sharing ?? "private",
      ...(panel.feedbackLimit === undefined ? {} : { feedbackLimit: panel.feedbackLimit }),
      ...(panel.reminderFacts === undefined ? {} : { reminderFacts: panel.reminderFacts }),
      cases,
    });
    const prior = this.store.db
      .prepare("SELECT body FROM strategy_panels WHERE id=?")
      .get(panel.id) as { body: string } | undefined;
    if (prior && prior.body !== body) throw new Error("Panel identity changed");
    if (this.panels.has(panel.id)) throw new Error("Panel already registered");
    for (const item of cases)
      if (
        this.store.db
          .prepare("SELECT 1 FROM strategy_cases WHERE input_hash=? AND partition!=?")
          .get(item.inputHash, panel.partition)
      )
        throw new Error("Development/held-out overlap");
    this.store.db.exec("SAVEPOINT strategy_panel");
    try {
      this.store.db
        .prepare("INSERT OR IGNORE INTO strategy_panels VALUES (?,?)")
        .run(panel.id, body);
      for (const item of cases)
        this.store.db
          .prepare("INSERT OR IGNORE INTO strategy_cases VALUES (?,?,?,?)")
          .run(panel.id, item.id, item.inputHash, panel.partition);
      this.store.db.exec("RELEASE strategy_panel");
    } catch (error) {
      this.store.db.exec("ROLLBACK TO strategy_panel; RELEASE strategy_panel");
      throw error;
    }
    this.panels.set(
      panel.id,
      Object.freeze({
        ...panel,
        scope: Object.freeze({ ...panel.scope }),
        ...(panel.reminderFacts === undefined ? {} : { reminderFacts: [...panel.reminderFacts] }),
        cases: structuredClone(panel.cases),
      }),
    );
  }
  evaluate(hash: string, panelId: string, budget: LearningCost): Promise<StrategyEvaluation> {
    return this.track(async () => {
      this.archive.requireShadow();
      const strategy = this.archive.get(hash),
        panel = this.panels.get(panelId);
      if (!strategy || !panel || learningHash(strategy.scope) !== learningHash(panel.scope))
        throw new Error("Unavailable or incompatible strategy panel");
      if (
        strategy.reminders?.length &&
        (!panel.reminderFacts ||
          strategy.reminders.some((r) =>
            [...r.when, ...(r.unless ?? [])].some((p) => !panel.reminderFacts!.includes(p.fact)),
          ))
      )
        throw new Error("Panel does not support this reminder vocabulary");
      const seal = this.store.db
        .prepare("SELECT candidates FROM strategy_seals WHERE scope=?")
        .get(learningHash(strategy.scope)) as { candidates: string } | undefined;
      if (panel.partition === "development" && seal) throw new Error("Search is sealed");
      if (
        panel.partition === "held-out" &&
        (!seal || !(JSON.parse(seal.candidates) as string[]).includes(hash))
      )
        throw new Error("Held-out evaluation requires a frozen candidate");
      const batch = randomUUID();
      if (
        panel.partition === "held-out" &&
        this.store.db
          .prepare("SELECT 1 FROM strategy_batches WHERE strategy=? AND panel=?")
          .get(hash, panelId)
      )
        throw new Error("Held-out candidate already evaluated; no implicit retries");
      this.store.db
        .prepare("INSERT INTO strategy_batches VALUES (?,?,?,NULL,?)")
        .run(batch, hash, panelId, this.store.now());
      let successes = 0,
        cost: LearningCost = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
      for (const item of panel.cases) {
        if (!this.archive.get(hash)) throw new Error("Strategy withdrawn");
        const quote = LearningCostSchema.parse(
            panel.quote(structuredClone(strategy), structuredClone(item.input)),
          ),
          runId = randomUUID();
        this.store.reserve(
          {
            id: runId,
            candidate: hash,
            scope: strategy.scope,
            inputHash: learningHash(item.input),
            verifier: panel.verifierHash,
            partition: panel.partition === "development" ? "acquisition" : "held-out",
            quote,
            predicted: 0.5,
          },
          LearningCostSchema.parse(budget),
        );
        this.store.db
          .prepare("INSERT INTO strategy_trials VALUES (?,?,?,NULL)")
          .run(runId, batch, item.id);
        const start = performance.now(),
          signal = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.ceil(quote.wallMs))));
        let stage = "execute",
          settled = false;
        try {
          const execution = await panel.execute(
            structuredClone(strategy),
            structuredClone(item.input),
            signal,
          );
          signal.throwIfAborted();
          stage = "verify";
          const verdict = await panel.verify(structuredClone(item.input), execution.output);
          signal.throwIfAborted();
          const spent = addLearningCost(
            LearningCostSchema.parse(execution.cost),
            LearningCostSchema.parse(verdict.cost),
          );
          spent.wallMs = Math.max(spent.wallMs, performance.now() - start);
          if (typeof verdict.passed !== "boolean" || typeof verdict.feedback !== "string")
            throw new Error("Invalid host verification");
          const overrun = !withinLearningBudget(spent, quote);
          this.store.finish(
            runId,
            !overrun && verdict.passed,
            spent,
            overrun ? "resource-exhausted" : verdict.passed ? "pass" : "candidate-failure",
          );
          settled = true;
          cost = addLearningCost(cost, spent);
          this.store.db
            .prepare("UPDATE strategy_trials SET feedback=? WHERE run_id=?")
            .run(
              panel.partition === "development"
                ? verdict.feedback.slice(0, panel.feedbackLimit ?? 6000)
                : "held-out: unavailable for learning",
              runId,
            );
          if (overrun) throw new Error("Strategy evaluation exceeded its reservation");
          successes += Number(verdict.passed);
        } catch (error) {
          if (!settled)
            this.store.finish(
              runId,
              false,
              null,
              stage === "verify" && !signal.aborted ? "verifier-invalid" : "interrupted",
            );
          throw error;
        }
      }
      const result = {
        batch,
        strategy: hash,
        panel: panelId,
        successes,
        total: panel.cases.length,
        score: successes / panel.cases.length,
        cost,
      };
      this.store.db
        .prepare("UPDATE strategy_batches SET result=? WHERE id=?")
        .run(JSON.stringify(result), batch);
      return result;
    });
  }
  propose(params: {
    parent: string;
    panel: string;
    evolveProposer: boolean;
    /** Append accepts {append}, preserves existing actor text, and requires a fixed proposer. */
    editMode?: "replace" | "append" | "conditional";
    fixedProposer: string;
    quote: LearningCost;
    budget: LearningCost;
    generate: (
      context: { parent: LearningStrategy; instructions: string; feedback: string[] },
      signal: AbortSignal,
    ) => Promise<{ edit: unknown; cost: LearningCost }>;
  }): Promise<string> {
    return this.track(async () => {
      this.archive.requireShadow();
      if (
        (params.editMode !== undefined &&
          !["replace", "append", "conditional"].includes(params.editMode)) ||
        (["append", "conditional"].includes(params.editMode ?? "") && params.evolveProposer)
      )
        throw new Error("Invalid strategy edit mode; bounded edits require a fixed proposer");
      const parent = this.archive.get(params.parent);
      if (!parent || this.archive.isSealed(parent.scope))
        throw new Error("Unavailable or sealed parent");
      const feedback = this.archive.feedback(params.panel, params.parent);
      const runId = randomUUID(),
        quote = LearningCostSchema.parse(params.quote);
      const instructions = params.evolveProposer
        ? parent.proposer
        : StrategyEditSchema.shape.proposer.parse(params.fixedProposer);
      this.store.reserve(
        {
          id: runId,
          candidate: params.parent,
          scope: parent.scope,
          inputHash: learningHash({
            feedback,
            instructions,
            ...(params.editMode === undefined ? {} : { editMode: params.editMode }),
          }),
          verifier: learningHash(
            params.editMode === "conditional"
              ? "strategy-conditional-schema-only-v1"
              : params.editMode === "append"
                ? "strategy-append-schema-only-v1"
                : "strategy-schema-only-v1",
          ),
          partition: "acquisition",
          quote,
          predicted: 0.5,
        },
        LearningCostSchema.parse(params.budget),
      );
      this.store.db
        .prepare("INSERT INTO strategy_proposals VALUES (?,?,NULL)")
        .run(runId, params.parent);
      const start = performance.now(),
        signal = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.ceil(quote.wallMs))));
      let settled = false;
      try {
        const result = await params.generate(
          { parent: structuredClone(parent), instructions, feedback },
          signal,
        );
        signal.throwIfAborted();
        const cost = LearningCostSchema.parse(result.cost);
        cost.wallMs = Math.max(cost.wallMs, performance.now() - start);
        const overrun = !withinLearningBudget(cost, quote);
        // Generating a valid edit is not behavioral success. Preserve its cost separately.
        this.store.finish(
          runId,
          false,
          cost,
          overrun ? "resource-exhausted" : "legacy-unclassified",
        );
        settled = true;
        if (overrun) throw new Error("Strategy proposal exceeded its reservation");
        const conditional =
          params.editMode === "conditional"
            ? StrategyConditionalEditSchema.parse(result.edit)
            : undefined;
        const edit = StrategyEditSchema.parse(
          conditional
            ? { actor: parent.actor, proposer: params.fixedProposer }
            : params.editMode === "append"
              ? {
                  actor: parent.actor + "\n\n" + StrategyAppendSchema.parse(result.edit).append,
                  proposer: params.fixedProposer,
                }
              : result.edit,
        );
        if (!this.archive.get(params.parent)) throw new Error("Parent withdrawn during generation");
        const child = this.archive.add(
          {
            ...parent,
            ...conditional,
            actor: edit.actor,
            proposer: params.evolveProposer ? edit.proposer : params.fixedProposer,
            parents: [params.parent],
            sharing:
              this.panels.get(params.panel)?.sharing === "shareable" ? parent.sharing : "private",
          },
          "proposal",
        );
        this.store.db
          .prepare("UPDATE strategy_proposals SET child=? WHERE run_id=?")
          .run(child, runId);
        return child;
      } catch (error) {
        if (!settled) this.store.finish(runId, false, null, "interrupted");
        throw error;
      }
    });
  }
}
