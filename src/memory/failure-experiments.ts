import { randomUUID } from "node:crypto";
import { LearningDispatchStopped } from "./learning-dispatch-stopped.js";
import { learningHash } from "./procedural-learning-contract.js";
import type { ProceduralLearningStore } from "./procedural-learning-store.js";
import type { EvolutionPassDeps, EvolutionPassResult } from "./skill-evolution/evolution-pass.js";
import type { ApplyProposalResult } from "./skill-evolution/proposal-apply.js";
import { classifyRunOrigin, isLearnableOrigin } from "./skill-evolution/run-origin.js";
import { isRunHeldOut } from "./skill-evolution/sampler.js";
import type { LabeledTrace } from "./skill-evolution/types.js";
import type { ValidationGateOutcome } from "./skill-evolution/validation-gate.js";

const BOOT_ID = randomUUID();
type Cycle = { id: string; pid: number; started_at: number; status: string };
export interface FailureExperimentRecorder {
  begin(samples: LabeledTrace[]): string | null;
  proposal(id: string, result: ApplyProposalResult): void;
  verdict(this: void, hash: string, result: ValidationGateOutcome): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures are not proof that another owner died.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Host-only orchestration over the existing production proposer and task gate.
 * The journal is the durable input queue. This ledger holds references and hashes,
 * never raw user traces, peer exports, self-reported success, or a promotion API. */
export class FailureExperiments {
  private pending: Promise<EvolutionPassResult | null> | null = null;
  private closing = false;

  constructor(readonly store: ProceduralLearningStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS failure_learning_cycles (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, boot TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
        llm_calls INTEGER NOT NULL DEFAULT 0, agent_turns INTEGER NOT NULL DEFAULT 0,
        limits TEXT NOT NULL, summary TEXT);
      CREATE TABLE IF NOT EXISTS failure_experiments (
        id TEXT PRIMARY KEY, cycle TEXT NOT NULL, sources TEXT NOT NULL,
        created_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
        skill TEXT, candidate_hash TEXT, result TEXT);
      CREATE INDEX IF NOT EXISTS failure_experiment_candidate ON failure_experiments(candidate_hash,skill);
      CREATE TABLE IF NOT EXISTS failure_experiment_verdicts (
        id INTEGER PRIMARY KEY, experiment TEXT NOT NULL, cycle TEXT NOT NULL,
        at INTEGER NOT NULL, result TEXT NOT NULL);
    `);
  }

  run(
    deps: EvolutionPassDeps,
    options: { cadenceMs: number; canDispatch: () => boolean },
  ): Promise<EvolutionPassResult | null> {
    if (this.pending) return this.pending;
    const pending = this.runInner(deps, options);
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      })
      .catch(() => {});
    return pending;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.pending?.catch(() => {});
  }

  private claim(cadenceMs: number): string | null {
    const db = this.store.db,
      now = this.store.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const running = db
        .prepare("SELECT * FROM failure_learning_cycles WHERE status='running'")
        .all() as Cycle[];
      if (running.some((row) => processAlive(row.pid))) return null;
      // Recover only a demonstrably dead owner. Never steal a slow live run.
      for (const row of running) {
        db.prepare(
          "UPDATE failure_learning_cycles SET status='interrupted',ended_at=? WHERE id=?",
        ).run(now, row.id);
        db.prepare(
          "UPDATE failure_experiments SET state='interrupted' WHERE cycle=? AND state='proposing'",
        ).run(row.id);
      }
      const last = db
        .prepare("SELECT MAX(started_at) AS at FROM failure_learning_cycles")
        .get() as { at: number | null };
      if (last.at !== null && now - last.at < Math.max(3_600_000, cadenceMs)) return null;
      const count = db.prepare("SELECT COUNT(*) AS n FROM failure_learning_cycles").get() as {
        n: number;
      };
      if (count.n >= this.store.config.maxEntries * 10)
        throw new Error("Failure-learning cycle capacity reached");
      const id = randomUUID();
      db.prepare(
        "INSERT INTO failure_learning_cycles(id,pid,boot,started_at,status,limits) VALUES (?,?,?,?,'running',?)",
      ).run(id, process.pid, BOOT_ID, now, JSON.stringify(this.store.config.automation));
      return id;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      if (db.isTransaction) {
        db.exec("COMMIT");
      }
    }
  }

  private recorder(cycle: string): FailureExperimentRecorder {
    return {
      begin: (samples) => {
        const failures = samples.filter(
          (s) =>
            s.label.label === "fail" &&
            s.trace.isComplete &&
            !isRunHeldOut(s.trace.runId) &&
            isLearnableOrigin(classifyRunOrigin(s.trace.sessionKey)),
        );
        if (!failures.length) return null;
        const id = learningHash({ failures: failures.map((s) => s.trace.runId).toSorted() });
        const previous = this.store.db
          .prepare("SELECT state,attempts,candidate_hash FROM failure_experiments WHERE id=?")
          .get(id) as
          | { state: string; attempts: number; candidate_hash: string | null }
          | undefined;
        if (previous) {
          // Only unfinished proposal generation may retry, at most three times.
          // Staged candidates resume through the gate, never through reproposal.
          if (
            previous.candidate_hash ||
            !["held", "interrupted"].includes(previous.state) ||
            previous.attempts >= 3
          )
            return null;
          this.store.db
            .prepare(
              "UPDATE failure_experiments SET cycle=?,state='proposing',attempts=attempts+1 WHERE id=?",
            )
            .run(cycle, id);
          return id;
        }
        const count = this.store.db
          .prepare("SELECT COUNT(*) AS n FROM failure_experiments")
          .get() as { n: number };
        if (count.n >= this.store.config.maxEntries)
          throw new Error("Failure experiment capacity reached");
        const sources = failures.map((s) => ({
          runId: s.trace.runId,
          traceHash: learningHash(s.formattedLog),
          origin: classifyRunOrigin(s.trace.sessionKey),
          evidenceLevel: s.label.evidenceLevel ?? null,
          signature: s.label.signature?.key ?? null,
        }));
        this.store.db
          .prepare(
            "INSERT INTO failure_experiments(id,cycle,sources,created_at,state) VALUES (?,?,?,?,'proposing')",
          )
          .run(id, cycle, JSON.stringify(sources), this.store.now());
        return id;
      },
      proposal: (id, result) => {
        this.store.db
          .prepare(
            "UPDATE failure_experiments SET state=?,skill=?,candidate_hash=?,result=? WHERE id=? AND cycle=? AND state='proposing'",
          )
          .run(
            result.outcome,
            result.stagedName ?? null,
            result.contentHash ?? null,
            JSON.stringify({ outcome: result.outcome }),
            id,
            cycle,
          );
      },
      verdict: (hash, result) => {
        const rows = this.store.db
          .prepare("SELECT id FROM failure_experiments WHERE candidate_hash=? AND skill=?")
          .all(hash, result.skillName) as { id: string }[];
        // Only a host gate receipt bound to the exact staged content can settle this record.
        const body = JSON.stringify({
          outcome: result.outcome,
          detail: result.detail.slice(0, 500),
        });
        for (const row of rows) {
          this.store.db
            .prepare(
              "INSERT INTO failure_experiment_verdicts(experiment,cycle,at,result) VALUES (?,?,?,?)",
            )
            .run(row.id, cycle, this.store.now(), body);
          this.store.db
            .prepare("UPDATE failure_experiments SET state=?,result=? WHERE id=?")
            .run(result.outcome, body, row.id);
        }
      },
    };
  }

  private async runInner(
    deps: EvolutionPassDeps,
    options: { cadenceMs: number; canDispatch: () => boolean },
  ): Promise<EvolutionPassResult | null> {
    if (
      this.closing ||
      this.store.config.mode !== "shadow" ||
      !this.store.config.automation.enabled ||
      !deps.journal ||
      !deps.llmCall ||
      !options.canDispatch()
    )
      return null;
    if (!Number.isFinite(options.cadenceMs) || options.cadenceMs < 0)
      throw new Error("Invalid learning cadence");
    const cycle = this.claim(options.cadenceMs);
    if (!cycle) return null;
    const started = this.store.now(),
      limits = this.store.config.automation;
    let stopped: string | null = null;
    const ready = () => {
      if (this.closing || !options.canDispatch()) stopped ??= "paused";
      if (this.store.now() - started >= limits.maxWallMinutes * 60_000) stopped ??= "wall-budget";
      if (stopped) throw new LearningDispatchStopped(stopped);
    };
    const reserve = (kind: "llm_calls" | "agent_turns", max: number) => {
      ready();
      const r = this.store.db
        .prepare(`UPDATE failure_learning_cycles SET ${kind}=${kind}+1
        WHERE id=? AND status='running' AND ${kind}<?`)
        .run(cycle, max);
      if (Number(r.changes) !== 1) {
        stopped = `${kind}-budget`;
        throw new LearningDispatchStopped(stopped);
      }
    };
    const wrapLlm = (fn: NonNullable<EvolutionPassDeps["llmCall"]>) => async (prompt: string) => {
      reserve("llm_calls", limits.maxLlmCalls);
      try {
        return await fn(prompt);
      } catch (error) {
        if (error instanceof Error && error.name === "UsageBudgetPausedError") {
          stopped = "usage-budget";
          throw new LearningDispatchStopped(stopped);
        }
        throw error;
      }
    };
    const wrapTurn =
      (
        fn: NonNullable<EvolutionPassDeps["agentTurn"]>,
      ): NonNullable<EvolutionPassDeps["agentTurn"]> =>
      async (...args) => {
        reserve("agent_turns", limits.maxAgentTurns);
        try {
          return await fn(...args);
        } catch (error) {
          if (error instanceof Error && error.name === "UsageBudgetPausedError") {
            stopped = "usage-budget";
            throw new LearningDispatchStopped(stopped);
          }
          throw error;
        }
      };
    let result: EvolutionPassResult | null = null;
    try {
      const { runEvolutionIteration } = await import("./skill-evolution/evolution-pass.js");
      result = await runEvolutionIteration({
        ...deps,
        cycleId: cycle,
        llmCall: wrapLlm(deps.llmCall),
        ...(deps.judgeCall ? { judgeCall: wrapLlm(deps.judgeCall) } : {}),
        ...(deps.proposerLlmCall ? { proposerLlmCall: wrapLlm(deps.proposerLlmCall) } : {}),
        ...(deps.agentTurn ? { agentTurn: wrapTurn(deps.agentTurn) } : {}),
        ...(deps.peerAgentTurn ? { peerAgentTurn: wrapTurn(deps.peerAgentTurn) } : {}),
        failureExperiments: this.recorder(cycle),
        assertCanValidate: ready,
      });
      return result;
    } finally {
      const state = stopped
        ? "held"
        : result?.reason === "error" || !result
          ? "interrupted"
          : "complete";
      this.store.db
        .prepare("UPDATE failure_learning_cycles SET status=?,ended_at=?,summary=? WHERE id=?")
        .run(
          state,
          this.store.now(),
          JSON.stringify({
            reason: stopped ?? result?.reason ?? null,
            validation:
              result?.validation?.map((v) => ({ skill: v.skillName, outcome: v.outcome })) ?? [],
            usageAccounting: "usage-ledger; dispatch counts are not USD or provider-call counts",
          }),
          cycle,
        );
      this.store.db
        .prepare("UPDATE failure_experiments SET state=? WHERE cycle=? AND state='proposing'")
        .run(state === "complete" ? "no-proposal" : state, cycle);
    }
  }

  status(): { cycles: unknown[]; experiments: unknown[] } {
    return {
      cycles: this.store.db
        .prepare("SELECT * FROM failure_learning_cycles ORDER BY started_at DESC LIMIT 20")
        .all(),
      experiments: this.store.db
        .prepare("SELECT * FROM failure_experiments ORDER BY created_at DESC LIMIT 20")
        .all(),
    };
  }
}
