import { randomUUID } from "node:crypto";
import type { LearningCost } from "../../../memory/procedural-learning-contract.js";
import { ProceduralLearningStore } from "../../../memory/procedural-learning-store.js";
import { compatibilityIssues } from "./compatibility.js";
import {
  EnvironmentSchema,
  learningHash,
  lineageId,
  ReceiptSchema,
  sha256,
  LearningCostSchema,
  type PackageSnapshot,
  type SkillEnvironment,
  type SkillExecutionReceipt,
  type SkillOutcome,
  type SkillRelease,
} from "./contracts.js";
import type { PublicTaskContract } from "./proposal-context.js";
import type { CollectiveSkillStore } from "./store.js";

export type ValidationTask = { id: string; family: string; input: unknown; regression: boolean };
export type TrialResult = {
  outcome: SkillOutcome;
  accessedFiles: string[];
  cost: LearningCost | null;
};
/** Host capability: tasks, reset, tool permissions, oracle and cost accounting never come from a peer. */
export interface PackageExecutionHost {
  readonly node: string;
  /** Public task requirements only; never verifier code or held-out instances. */
  readonly publicContract?: PublicTaskContract;
  readonly environment: SkillEnvironment;
  readonly tasks: readonly ValidationTask[];
  readonly acquisitionTaskHashes: ReadonlySet<string>;
  /** Fresh selection instances for each attempt, with an unchanged regression panel. */
  selectionTasks?(): readonly ValidationTask[];
  quote(task: ValidationTask): LearningCost;
  execute(
    task: ValidationTask,
    snapshot: PackageSnapshot | null,
    signal: AbortSignal,
  ): Promise<TrialResult>;
}
export type PairedVerdict = {
  passed: boolean;
  reason: string;
  pairs: number;
  wins: number;
  losses: number;
  pValue: number;
  alpha: number;
  attempt: number;
};

export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (!n || wins <= losses) return 1;
  // Sum the smaller binomial tail in log space to avoid underflow for large panels.
  let logChoose = 0;
  let total = 0;
  for (let i = 0; i <= losses; i++) {
    if (i) logChoose += Math.log(n - i + 1) - Math.log(i);
    total += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, total);
}
export const isCanaryExposed = (runId: string, hash: string): boolean =>
  parseInt(sha256(`${hash}:${runId}`).slice(0, 8), 16) % 2 === 0;

export class PackageValidator {
  readonly ledger: ProceduralLearningStore;
  constructor(
    readonly store: CollectiveSkillStore,
    readonly host: PackageExecutionHost,
    readonly budget: LearningCost,
  ) {
    EnvironmentSchema.parse(host.environment);
    LearningCostSchema.parse(budget);
    this.ledger = new ProceduralLearningStore(store.db, {}, store.now);
  }
  async validate(
    release: SkillRelease,
    incumbentHash: string | null,
    signal: AbortSignal,
  ): Promise<PairedVerdict> {
    const { store, host } = this;
    store.assertAncestry(release);
    const lineage = lineageId(release);
    const environment = learningHash(host.environment);
    const pkg = store.get(release.packageHash);
    if (!pkg || !["screened", "blocked", "stale"].includes(pkg.state))
      throw new Error("Screen package before validation");
    const incompatible = compatibilityIssues(pkg.manifest, host.environment);
    if (incompatible.length) {
      store.state(release.packageHash, "blocked", incompatible.join(","));
      throw new Error(`Compatibility waiting: ${incompatible.join(",")}`);
    }
    const tasks = [...(host.selectionTasks?.() ?? host.tasks)];
    if (
      tasks.length > 1000 ||
      tasks.filter((t) => !t.regression).length < 20 ||
      !tasks.some((t) => t.regression)
    )
      throw new Error("Need at least 20 selection cases and a regression panel");
    const hashes = tasks.map((t) => learningHash({ family: t.family, input: t.input }));
    if (
      new Set(hashes).size !== hashes.length ||
      hashes.some((h) => host.acquisitionTaskHashes.has(h))
    )
      throw new Error("Acquisition/selection overlap or duplicate task");
    const candidate = await store.read(release.packageHash);
    // A blocked static screen must never become eligible merely by retrying validation.
    const { screenPackage } = await import("./package.js");
    screenPackage(candidate);
    const incumbent = incumbentHash ? await store.read(incumbentHash) : null;
    if (incumbentHash === release.packageHash) throw new Error("Candidate equals incumbent");
    const job = randomUUID();
    const attempt = store.transaction(() => {
      if (
        store.db
          .prepare("SELECT 1 FROM collective_jobs WHERE lineage=? AND state='running'")
          .get(lineage)
      )
        throw new Error("Validation already running");
      for (let i = 0; i < tasks.length; i++) {
        if (
          !tasks[i].regression &&
          store.db
            .prepare(
              "SELECT 1 FROM collective_trials t JOIN collective_jobs j ON j.id=t.job WHERE j.lineage=? AND t.task_hash=? AND t.partition='selection'",
            )
            .get(lineage, hashes[i])
        )
          throw new Error("Selection task already used by this lineage");
      }
      const row = store.db
        .prepare(
          "SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM collective_jobs WHERE lineage=?",
        )
        .get(lineage) as { attempt: number };
      store.db
        .prepare("INSERT INTO collective_jobs VALUES (?,?,?,?,?,'running',NULL,?)")
        .run(job, lineage, release.packageHash, environment, row.attempt, store.now());
      tasks.forEach((t, i) =>
        store.db
          .prepare("INSERT INTO collective_trials VALUES (?,?,?,NULL)")
          .run(job, hashes[i], t.regression ? "regression" : "selection"),
      );
      return row.attempt;
    });
    let wins = 0,
      losses = 0,
      pairs = 0,
      regression = false;
    let reason = "insufficient-improvement";
    try {
      for (let index = 0; index < tasks.length; index++) {
        signal.throwIfAborted();
        const task = tasks[index];
        const results: SkillExecutionReceipt[] = [];
        // Alternate order; each host execution must independently reset the environment.
        const order = index % 2 ? [candidate, incumbent] : [incumbent, candidate];
        for (const snapshot of order) {
          const id = randomUUID();
          const quote = LearningCostSchema.parse(host.quote(task));
          this.ledger.reserve(
            {
              id,
              candidate: release.packageHash,
              scope: {
                tool: "skill-package",
                operation: "paired-validation",
                version: "1",
                contractHash: environment,
              },
              inputHash: hashes[index],
              verifier: host.environment.checkerHash,
              partition: "acquisition",
              quote,
              predicted: 0,
            },
            this.budget,
          );
          let result: TrialResult;
          try {
            result = await host.execute(structuredClone(task), snapshot, signal);
          } catch {
            result = {
              outcome: signal.aborted ? "interrupted" : "infrastructure",
              accessedFiles: [],
              cost: null,
            };
          }
          const receipt = ReceiptSchema.parse({
            id,
            packageHash: snapshot?.packageHash ?? null,
            node: host.node,
            runId: id,
            taskHash: hashes[index],
            family: task.family,
            environment: host.environment,
            partition: task.regression ? "held-out" : "selection",
            ...result,
            occurredAt: store.now(),
          });
          if (receipt.accessedFiles.some((name) => !snapshot?.files.has(name)))
            throw new Error("Host reported an unknown package file");
          const overBudget =
            receipt.cost &&
            (receipt.cost.providerUsd > quote.providerUsd ||
              receipt.cost.toolCalls > quote.toolCalls ||
              receipt.cost.wallMs > quote.wallMs);
          this.ledger.finish(
            id,
            receipt.outcome === "pass" && !!receipt.cost && !overBudget,
            receipt.cost,
            overBudget
              ? "resource-exhausted"
              : receipt.outcome === "pass" && receipt.cost
                ? "pass"
                : receipt.outcome === "task-failure"
                  ? "candidate-failure"
                  : receipt.outcome === "checker-invalid"
                    ? "verifier-invalid"
                    : "interrupted",
          );
          store.db
            .prepare("INSERT INTO collective_receipts VALUES (?,?,?)")
            .run(id, receipt.packageHash, JSON.stringify(receipt));
          results.push(receipt);
          if (!receipt.cost || overBudget || !["pass", "task-failure"].includes(receipt.outcome))
            throw new Error(overBudget ? "resource-exhausted" : "unresolved-trial");
        }
        const baseline = results.find((r) => r.packageHash === incumbentHash)!;
        const proposed = results.find((r) => r.packageHash === candidate.packageHash)!;
        const used = proposed.accessedFiles.includes("SKILL.md");
        const won = used && baseline.outcome === "task-failure" && proposed.outcome === "pass";
        const lost = baseline.outcome === "pass" && proposed.outcome === "task-failure";
        if (task.regression) regression ||= lost;
        else {
          pairs++;
          if (won) wins++;
          if (lost) losses++;
        }
        store.db
          .prepare("UPDATE collective_trials SET body=? WHERE job=? AND task_hash=?")
          .run(
            JSON.stringify({ baseline: baseline.id, candidate: proposed.id, used, won, lost }),
            job,
            hashes[index],
          );
      }
    } catch (error) {
      reason = signal.aborted ? "interrupted" : String(error);
    }
    const pValue = signTest(wins, losses);
    const alpha = 0.05 / 2 ** attempt;
    const complete = !store.db
      .prepare("SELECT 1 FROM collective_trials WHERE job=? AND body IS NULL")
      .get(job);
    const passed = complete && pairs >= 20 && wins > losses && pValue < alpha && !regression;
    if (passed) reason = "paired-improvement";
    else if (regression) reason = "regression-panel-failure";
    const verdict = { passed, reason, pairs, wins, losses, pValue, alpha, attempt };
    store.db
      .prepare("UPDATE collective_jobs SET state=?,verdict=? WHERE id=?")
      .run(passed ? "passed" : "blocked", JSON.stringify(verdict), job);
    store.state(release.packageHash, passed ? "locally-validated" : "blocked", reason, environment);
    return verdict;
  }
  /** Host-only runtime receipt. Peer reports cannot call this through RPC. */
  async runCanary(
    agent: string,
    release: SkillRelease,
    signal: AbortSignal,
    localAdaptationOf?: string,
  ): Promise<void> {
    const lineage = localAdaptationOf ?? lineageId(release);
    const active = this.store.active(agent, lineage);
    if (
      !active ||
      active.hash !== release.packageHash ||
      this.store.get(active.hash)?.state !== "canary"
    )
      throw new Error("No active canary");
    const candidate = await this.store.read(active.hash);
    const baseline = active.previous ? await this.store.read(active.previous) : null;
    const tasks = (this.host.selectionTasks?.() ?? this.host.tasks).filter((t) => !t.regression);
    let exposed = 0;
    for (const task of tasks) {
      signal.throwIfAborted();
      const runId = randomUUID();
      if (!isCanaryExposed(runId, active.hash)) continue;
      const execute = async (snapshot: PackageSnapshot | null): Promise<SkillExecutionReceipt> => {
        const id = randomUUID(),
          quote = LearningCostSchema.parse(this.host.quote(task));
        this.ledger.reserve(
          {
            id,
            candidate: active.hash,
            scope: {
              tool: "skill-package",
              operation: "canary",
              version: "1",
              contractHash: learningHash(this.host.environment),
            },
            inputHash: learningHash(task.input),
            verifier: this.host.environment.checkerHash,
            partition: "acquisition",
            quote,
            predicted: 0,
          },
          this.budget,
        );
        let outcome: TrialResult;
        try {
          outcome = await this.host.execute(structuredClone(task), snapshot, signal);
        } catch {
          outcome = { outcome: "interrupted", accessedFiles: [], cost: null };
        }
        const receipt = ReceiptSchema.parse({
          id,
          runId,
          packageHash: snapshot?.packageHash ?? null,
          node: this.host.node,
          taskHash: learningHash({ family: task.family, input: task.input }),
          family: task.family,
          environment: this.host.environment,
          partition: "canary",
          occurredAt: this.store.now(),
          ...outcome,
        });
        const excess =
          receipt.cost &&
          (receipt.cost.providerUsd > quote.providerUsd ||
            receipt.cost.toolCalls > quote.toolCalls ||
            receipt.cost.wallMs > quote.wallMs);
        this.ledger.finish(
          id,
          receipt.outcome === "pass" && !excess,
          receipt.cost,
          excess ? "resource-exhausted" : receipt.outcome === "pass" ? "pass" : "candidate-failure",
        );
        this.store.db
          .prepare("INSERT INTO collective_receipts VALUES (?,?,?)")
          .run(id, receipt.packageHash, JSON.stringify(receipt));
        if (!receipt.cost || excess || !["pass", "task-failure"].includes(receipt.outcome))
          throw new Error("Canary execution unresolved");
        return receipt;
      };
      const result = await execute(candidate);
      let confirmedRegression = false;
      if (result.outcome === "task-failure") {
        const control = await execute(baseline);
        if (control.outcome === "pass") {
          const repeated = await execute(candidate);
          confirmedRegression = repeated.outcome === "task-failure";
        }
      }
      this.observeCanary(agent, lineage, result, confirmedRegression);
      exposed++;
      if (this.store.get(active.hash)?.state !== "canary" || exposed >= 20) return;
    }
  }

  /** Host-only runtime receipt. Peer reports cannot call this through RPC. */
  observeCanary(agent: string, lineage: string, input: unknown, baselinePassed: boolean): void {
    const receipt = ReceiptSchema.parse(input);
    const active = this.store.active(agent, lineage);
    if (
      !active ||
      receipt.packageHash !== active.hash ||
      receipt.node !== this.host.node ||
      receipt.partition !== "canary" ||
      learningHash(receipt.environment) !== learningHash(this.host.environment) ||
      !isCanaryExposed(receipt.runId, active.hash)
    )
      throw new Error("Canary receipt does not match exposure");
    const prior = this.store.db
      .prepare("SELECT body FROM collective_canary_runs WHERE agent=? AND lineage=? AND run=?")
      .get(agent, lineage, receipt.runId) as { body: string } | undefined;
    if (prior) {
      if (learningHash(JSON.parse(prior.body)) !== learningHash(receipt))
        throw new Error("Conflicting canary receipt");
      return;
    }
    this.store.db
      .prepare("INSERT INTO collective_canary_runs VALUES (?,?,?,?)")
      .run(agent, lineage, receipt.runId, JSON.stringify(receipt));
    if (
      receipt.outcome === "task-failure" &&
      baselinePassed &&
      receipt.accessedFiles.includes("SKILL.md")
    )
      this.store.rollback(
        agent,
        lineage,
        learningHash(this.host.environment),
        "confirmed-runtime-regression",
      );
    else this.maintain(agent);
  }
  maintain(agent?: string): void {
    const rows = this.store.db.prepare("SELECT * FROM collective_canary").all() as Array<{
      agent: string;
      lineage: string;
      hash: string;
      started_at: number;
    }>;
    for (const row of rows) {
      if (agent && row.agent !== agent) continue;
      const pkg = this.store.get(row.hash)!;
      if (["revoked", "rolled-back", "blocked", "stale"].includes(pkg.state)) {
        this.store.rollback(
          row.agent,
          row.lineage,
          learningHash(this.host.environment),
          pkg.reason ?? pkg.state,
        );
        continue;
      }
      if (pkg.environment !== learningHash(this.host.environment)) {
        this.store.state(row.hash, "stale", "environment-changed");
        continue;
      }
      const receipts = (
        this.store.db
          .prepare("SELECT body FROM collective_canary_runs WHERE agent=? AND lineage=?")
          .all(row.agent, row.lineage) as { body: string }[]
      )
        .map((r) => ReceiptSchema.parse(JSON.parse(r.body)))
        .filter(
          (r) =>
            r.packageHash === row.hash &&
            r.cost &&
            r.accessedFiles.includes("SKILL.md") &&
            ["pass", "task-failure"].includes(r.outcome),
        );
      if (receipts.length >= 20 && receipts.every((r) => r.outcome === "pass"))
        this.store.state(row.hash, "stable");
      else if (this.store.now() - row.started_at >= 14 * 86400000)
        this.store.state(row.hash, "blocked", "canary-insufficient-evidence");
    }
  }
}
