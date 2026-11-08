import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";
import type { ImpactTrailOptions } from "../agents/skills/impact-trail.js";
import { skillPriorLedgerPath } from "../agents/skills/skill-prior-runtime.js";
import { resolveSkillPriorWriterMode as resolvePriorWriterMode } from "../agents/skills/skill-prior.js";
import type { BitterbotConfig } from "../config/config.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { getActiveEventJournal, type EventJournal } from "../infra/event-journal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readRunFeedback } from "./skill-evolution/run-feedback.js";
import {
  selectSkillPriorOutcome,
  type SkillPriorCredit,
  type SkillPriorExecution,
} from "./skill-prior-outcome.js";
import {
  applySkillPriorCredits,
  readLivePriorCredits,
  writerOptions,
  type WriterMode,
} from "./skill-prior-writer.js";

const log = createSubsystemLogger("skills/prior-writer");
const HISTORY_LIMIT = 500;
const BATCH_SIZE = 100;
const RECONCILE_LIMIT = 10_000;

export function resolveSkillPriorWriterMode(cfg?: BitterbotConfig): WriterMode {
  return resolvePriorWriterMode(cfg?.skills?.prior);
}

/** Gateway-owned worker. Event listeners enqueue only; all I/O runs after yielding. */
export class SkillPriorWriterService {
  private readonly pending = new Set<string>();
  private readonly reported = new Map<string, string>();
  private readonly warnings = new Set<string>();
  private scheduled: NodeJS.Immediate | undefined;
  private active: Promise<void> = Promise.resolve();
  private busy = false;
  private closed = false;
  private reconcileRequested = false;
  private readonly unsubscribe: () => void;
  private readonly interval: NodeJS.Timeout;

  constructor(
    private readonly deps: {
      db: () => DatabaseSync;
      config: () => BitterbotConfig;
      journal?: () => EventJournal | null;
      feedbackOptions?: ImpactTrailOptions;
    },
  ) {
    this.unsubscribe = onAgentEvent((event) => {
      if (event.stream === "lifecycle" && ["end", "error"].includes(String(event.data.phase)))
        this.enqueue(event.runId);
      else if (
        event.stream === "task" &&
        event.data.phase === "judged" &&
        typeof event.data.runId === "string"
      )
        this.enqueue(event.data.runId);
      else if (event.stream === "skills" && event.data.phase === "run-feedback")
        this.enqueue(event.runId);
    });
    this.interval = setInterval(() => this.reconcile(), 30 * 60_000);
    this.interval.unref();
    this.reconcile();
  }

  enqueue(runId: string): void {
    if (this.closed) return;
    if (this.pending.size < RECONCILE_LIMIT) this.pending.add(runId);
    else this.warnOnce("queue-capacity", "Pending run limit reached; reconciliation will retry.");
    this.schedule();
  }

  reconcile(): void {
    if (this.closed) return;
    this.reconcileRequested = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.busy || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.busy = true;
      this.active = this.drain()
        .catch((err: unknown) => {
          this.warnOnce(String(err), "Verified outcome writer skipped: " + String(err));
        })
        .finally(() => {
          this.busy = false;
          if (!this.closed && (this.pending.size || this.reconcileRequested)) this.schedule();
        });
    });
    this.scheduled.unref();
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnings.has(key)) return;
    if (this.warnings.size >= 100) return;
    this.warnings.add(key);
    log.warn(message);
    emitAgentEvent({
      runId: "skill-prior-writer",
      stream: "skills",
      data: { phase: "prior-writer-warning", reason: message },
    });
  }

  private report(runId: string, data: Record<string, unknown>): void {
    const fingerprint = JSON.stringify(data);
    if (this.reported.get(runId) === fingerprint) return;
    this.reported.set(runId, fingerprint);
    if (this.reported.size > RECONCILE_LIMIT)
      this.reported.delete(this.reported.keys().next().value!);
    emitAgentEvent({ runId, stream: "skills", data: { phase: "prior-writer", ...data } });
  }

  private async drain(): Promise<void> {
    const cfg = this.deps.config();
    const mode = resolveSkillPriorWriterMode(cfg);
    if (mode === "off") {
      this.pending.clear();
      this.reconcileRequested = false;
      return;
    }
    const journal = (this.deps.journal ?? getActiveEventJournal)();
    if (!journal) {
      this.pending.clear();
      this.reconcileRequested = false;
      return;
    }
    const file = skillPriorLedgerPath(cfg),
      options = writerOptions(cfg.skills?.prior);
    // Validate scope before considering any proposed writes, including in shadow.
    let saved: SkillPriorCredit[];
    try {
      saved = await readLivePriorCredits(file, options);
    } catch (err) {
      this.pending.clear();
      this.reconcileRequested = false;
      this.warnOnce("ledger:" + file, "Ledger " + file + " refused: " + String(err));
      return;
    }
    const feedback = await readRunFeedback(this.deps.feedbackOptions, { ownerOnly: true });
    const credits: SkillPriorCredit[] = [];
    // Already credited runs retain their owner/read provenance even after journal retention.
    for (const old of saved) {
      const human = feedback.get(old.runId);
      if (
        human?.eventId &&
        Number.isFinite(human.ts) &&
        human.ts >= old.startedAt &&
        (old.source !== "owner-feedback" || human.eventId !== old.revision)
      ) {
        credits.push({
          ...old,
          outcome: human.verdict === "confirmed" ? 1 : 0,
          source: "owner-feedback",
          revision: human.eventId,
          signalOrder: human.sequence ?? 0,
          author: "operator",
        });
      }
    }
    if (this.reconcileRequested) {
      this.reconcileRequested = false;
      const runs = this.deps
        .db()
        .prepare(
          `SELECT run_id FROM skill_executions WHERE run_id IS NOT NULL AND context_json IS NOT NULL
         GROUP BY run_id ORDER BY MAX(started_at) DESC LIMIT ?`,
        )
        .all(RECONCILE_LIMIT) as Array<{ run_id: string }>;
      for (const row of runs) this.pending.add(row.run_id);
      for (const id of feedback.keys()) {
        if (this.pending.size < RECONCILE_LIMIT) this.pending.add(id);
      }
    }
    const runs = [...this.pending].slice(0, BATCH_SIZE);
    for (const runId of runs) this.pending.delete(runId);
    for (const runId of runs) {
      try {
        const query = { runId, streams: ["tool", "user", "lifecycle"], limit: HISTORY_LIMIT + 1 };
        const meta = journal.queryMeta(query);
        const events = meta.length <= HISTORY_LIMIT ? journal.query(query) : [];
        const taskId = events.find((e) => e.taskId)?.taskId;
        const taskQuery = {
          taskId: taskId ?? undefined,
          streams: ["task"],
          limit: HISTORY_LIMIT + 1,
        };
        const taskMeta = taskId ? journal.queryMeta(taskQuery) : [];
        const taskEvents =
          taskId && taskMeta.length <= HISTORY_LIMIT ? journal.query(taskQuery) : [];
        const executions = this.deps
          .db()
          .prepare(
            `SELECT run_id, tool_call_id, recorded_by, completed_at, success, context_json
           FROM skill_executions WHERE run_id = ? LIMIT 3`,
          )
          .all(runId) as unknown as SkillPriorExecution[];
        const selected = selectSkillPriorOutcome({
          runId,
          events,
          taskEvents,
          executions,
          feedback: feedback.get(runId),
          completeHistory:
            meta.length === events.length &&
            meta.length <= HISTORY_LIMIT &&
            taskMeta.length === taskEvents.length &&
            taskMeta.length <= HISTORY_LIMIT,
        });
        if (selected.credit) credits.push(selected.credit);
        else this.report(runId, { mode, status: "skipped", reason: selected.reason });
      } catch (err) {
        log.debug("Run outcome skipped: " + runId + ": " + String(err));
      }
      await yieldLoop();
    }
    if (credits.length) {
      const result = await applySkillPriorCredits({ file, mode, options, credits });
      for (let i = 0; i < result.changes.length; i++) {
        const change = result.changes[i],
          credit = credits[i];
        if (change.action === "capacity")
          this.warnOnce(
            "capacity",
            "Verified outcome capacity (10000) reached; keeping all dedupe history.",
          );
        if (change.action === "duplicate" || change.action === "stale") continue;
        this.report(change.runId, {
          mode,
          status:
            change.action === "capacity" ? "skipped" : mode === "shadow" ? "proposed" : "recorded",
          ...(change.action === "capacity" ? { reason: "capacity" } : {}),
          action: change.action,
          skill: credit.skill.name,
          hash: credit.skill.hash,
          outcome: credit.outcome,
          source: credit.source,
          author: credit.author,
          revision: credit.revision,
        });
      }
    }
  }

  /** For shutdown/tests only. Never awaited by a run callback. */
  async flush(): Promise<void> {
    do {
      if (this.scheduled) {
        clearImmediate(this.scheduled);
        this.scheduled = undefined;
        this.busy = true;
        this.active = this.drain()
          .catch((err: unknown) => {
            this.warnOnce(String(err), "Verified outcome writer skipped: " + String(err));
          })
          .finally(() => {
            this.busy = false;
          });
      }
      await this.active;
      if (!this.closed && (this.pending.size || this.reconcileRequested)) this.schedule();
    } while (this.scheduled || this.busy);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    clearInterval(this.interval);
    await this.flush();
    this.closed = true;
  }
}
