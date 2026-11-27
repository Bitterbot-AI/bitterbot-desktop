// PLAN-64 Phase 6: the durable trial-turn ledger for harness replay.
//
// Same discipline as the failure-experiment coordinator
// (src/memory/failure-experiments.ts): a trial agent turn is reserved in
// SQLite BEFORE it is dispatched, the reservation is never refunded, and a
// crash between reservation and completion leaves the turn counted. Reopening
// the same cycle after a restart sees what was already spent, so a cycle can
// never dispatch more than its ceiling no matter how often the process dies.
//
// The coordinator's own tables are bound to the procedural-learning store and
// its cadence claim, so this is a small equivalent rather than a shared class.
// The ledger holds ids, hashes and verdicts only: no prompts, no answers.
//
// These are dispatch counts, not dollars. Model usage of a trial turn is
// recorded by the usage ledger under `skills/evolution` (the validation
// session flavor), like every other scratch-workspace trial.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LearningDispatchStopped } from "../learning-dispatch-stopped.js";

const BOOT_ID = randomUUID();
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type ReplayArm = "baseline" | "candidate";
export type ReplayTrialState = "reserved" | "passed" | "failed" | "error" | "held" | "interrupted";

export interface ReplayTrialRow {
  id: string;
  cycle: string;
  comparison: string;
  execution_id: string;
  task_id: string;
  arm: ReplayArm;
  policy_hash: string;
  state: ReplayTrialState;
  run_id: string | null;
  created_at: number;
  ended_at: number | null;
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

export interface HarnessReplayLedgerOptions {
  now?: () => number;
  /** Identity of this process lifetime (tests simulate a restart with a new one). */
  bootId?: string;
}

export class HarnessReplayLedger {
  private readonly now: () => number;
  private readonly bootId: string;

  constructor(
    private readonly db: DatabaseSync,
    options: HarnessReplayLedgerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.bootId = options.bootId ?? BOOT_ID;
    db.exec(`
      CREATE TABLE IF NOT EXISTS harness_replay_cycles (
        id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, max_turns INTEGER NOT NULL,
        agent_turns INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS harness_replay_trials (
        id TEXT PRIMARY KEY, cycle TEXT NOT NULL, comparison TEXT NOT NULL,
        execution_id TEXT NOT NULL, task_id TEXT NOT NULL, arm TEXT NOT NULL,
        policy_hash TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT,
        pid INTEGER NOT NULL, boot TEXT NOT NULL,
        created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS harness_replay_trials_cycle ON harness_replay_trials(cycle);
    `);
  }

  /**
   * Open (or reopen) a cycle. Reopening keeps the turns already reserved: the
   * ceiling is per cycle, not per process lifetime. Reservations left behind by
   * a dead owner are labelled `interrupted` and stay counted.
   */
  openCycle(cycleId: string, maxTurns: number): void {
    const now = this.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO harness_replay_cycles(id,started_at,max_turns) VALUES (?,?,?)",
      )
      .run(cycleId, now, Math.max(0, Math.floor(maxTurns)));
    const stale = this.db
      .prepare("SELECT id, pid, boot FROM harness_replay_trials WHERE state='reserved'")
      .all() as unknown as Array<{ id: string; pid: number; boot: string }>;
    for (const row of stale) {
      // Our own live reservations are not stale. Another boot under our pid is
      // a restart (or pid reuse); another pid is stale only once it is gone.
      const ownerAlive =
        row.boot === this.bootId || (row.pid !== process.pid && processAlive(row.pid));
      if (!ownerAlive) {
        this.db
          .prepare(
            "UPDATE harness_replay_trials SET state='interrupted',ended_at=? WHERE id=? AND state='reserved'",
          )
          .run(now, row.id);
      }
    }
    // Bounded: receipts older than the retention window are dropped.
    const cutoff = now - RETENTION_MS;
    this.db.prepare("DELETE FROM harness_replay_trials WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM harness_replay_cycles WHERE started_at < ?").run(cutoff);
  }

  /** Turns already reserved in this cycle (settled or not). */
  reserved(cycleId: string): number {
    const row = this.db
      .prepare("SELECT agent_turns AS n FROM harness_replay_cycles WHERE id=?")
      .get(cycleId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** The ceiling for a cycle: the smaller of what it was opened with and `maxTurns`. */
  private ceiling(cycleId: string, maxTurns: number): number {
    const row = this.db
      .prepare("SELECT max_turns AS n FROM harness_replay_cycles WHERE id=?")
      .get(cycleId) as { n: number } | undefined;
    return Math.max(0, Math.min(row?.n ?? 0, Math.floor(maxTurns)));
  }

  remaining(cycleId: string, maxTurns: number): number {
    return Math.max(0, this.ceiling(cycleId, maxTurns) - this.reserved(cycleId));
  }

  /**
   * Reserve one trial agent turn. Must be called before the turn is
   * dispatched. Throws `LearningDispatchStopped` when the cycle's ceiling is
   * reached; the count and the trial row commit together or not at all.
   */
  reserve(
    cycleId: string,
    maxTurns: number,
    trial: {
      comparison: string;
      executionId: string;
      taskId: string;
      arm: ReplayArm;
      policyHash: string;
    },
  ): string {
    const id = `hr_${randomUUID()}`;
    const ceiling = this.ceiling(cycleId, maxTurns);
    // A savepoint, not BEGIN: it is atomic on its own and also safe if some
    // caller already holds a transaction on this connection.
    this.db.exec("SAVEPOINT harness_replay_reserve");
    try {
      const r = this.db
        .prepare(
          "UPDATE harness_replay_cycles SET agent_turns=agent_turns+1 WHERE id=? AND agent_turns<?",
        )
        .run(cycleId, ceiling);
      if (Number(r.changes) !== 1) {
        throw new LearningDispatchStopped("agent_turns-budget");
      }
      this.db
        .prepare(
          `INSERT INTO harness_replay_trials
             (id,cycle,comparison,execution_id,task_id,arm,policy_hash,state,pid,boot,created_at)
           VALUES (?,?,?,?,?,?,?,'reserved',?,?,?)`,
        )
        .run(
          id,
          cycleId,
          trial.comparison,
          trial.executionId,
          trial.taskId,
          trial.arm,
          trial.policyHash,
          process.pid,
          this.bootId,
          this.now(),
        );
      this.db.exec("RELEASE harness_replay_reserve");
    } catch (error) {
      this.db.exec("ROLLBACK TO harness_replay_reserve");
      this.db.exec("RELEASE harness_replay_reserve");
      throw error;
    }
    return id;
  }

  /** Record how a reserved turn ended. The reservation itself is never refunded. */
  settle(trialId: string, state: Exclude<ReplayTrialState, "reserved">, runId?: string): void {
    this.db
      .prepare(
        "UPDATE harness_replay_trials SET state=?,run_id=?,ended_at=? WHERE id=? AND state='reserved'",
      )
      .run(state, runId ?? null, this.now(), trialId);
  }

  trials(cycleId: string): ReplayTrialRow[] {
    return this.db
      .prepare(
        `SELECT id,cycle,comparison,execution_id,task_id,arm,policy_hash,state,run_id,created_at,ended_at
           FROM harness_replay_trials WHERE cycle=? ORDER BY created_at, rowid`,
      )
      .all(cycleId) as unknown as ReplayTrialRow[];
  }
}
