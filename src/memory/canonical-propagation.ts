/**
 * PLAN-55 Phase 2 (G4): the `canonical:changed` dispatcher.
 *
 * The ledger emits a change synchronously from pin()/retire()/unretire();
 * this class takes it off the write path. enqueue() only pushes onto a
 * bounded queue and schedules a drain on a later macrotask, so the chat
 * turn (and the caller's SAVEPOINT) finishes first. The drain handles one
 * event at a time, in order, and for each:
 *
 * 1. re-reads the fact row (isCanonicalChangeCommitted): an event whose
 *    write rolled back propagates nothing;
 * 2. runs the consumers in a fixed order, each in its own try/catch so a
 *    failing consumer logs and the others still run:
 *    search marks -> preferences -> knowledge graph -> briefs and tasks ->
 *    dream insights (insights read the marks the first consumer wrote).
 *
 * Every consumer is idempotent and caps its own work per event; the long
 * ones yield to the event loop between windows (heavy synchronous memory
 * loops starve the gateway and show up as UI 1006 disconnects).
 *
 * Before the consumers, restoreForValue() undoes what earlier changes
 * removed for the value that is current again (canonical-propagation-undo.ts).
 *
 * Scope: a `project:<name>` change never reaches the preference or graph
 * consumers (both are global), never touches tasks (not tied to a
 * workspace), and reaches search marks, briefs and insights only when this
 * memory database belongs to that project's workspace.
 *
 * Durability: every change is also in `canonical_change_outbox`, written in
 * the ledger write's own transaction. A row is stamped `propagated_at` when
 * its consumers have run. reconcile() (shortly after start, then on an
 * interval) replays rows left unstamped by a shutdown or a queue overflow,
 * prunes old stamped rows and deletes supersession marks whose chunk is
 * gone. Changes made before migration v78 are not in the outbox and are
 * never replayed.
 */

import type { DatabaseSync } from "node:sqlite";
import { resolveActiveProjectName } from "../agents/canonical-facts-block.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveTaskStore, type TaskStore } from "../tasks/store.js";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { restoreForValue } from "./canonical-propagation-undo.js";
import { changeProject, yieldToEventLoop } from "./canonical-stale-match.js";
import { propagateToBriefsAndTasks } from "./canonical-supersede-briefs.js";
import { propagateToKnowledgeGraph } from "./canonical-supersede-graph.js";
import { propagateToDreamInsights } from "./canonical-supersede-insights.js";
import { propagateToPreferences } from "./canonical-supersede-preferences.js";
import { propagateSupersededChunks } from "./canonical-supersede-search.js";
import type { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import type { KnowledgeGraphManager } from "./knowledge-graph.js";

// One import site for the manager: the consumers it calls outside the queue.
export { CANONICAL_CHANGED_EVENT } from "./canonical-events.js";
export { applySupersededMarks, hasSupersessionMarks } from "./canonical-supersede-search.js";
export {
  loadCanonicalSynthesisContext,
  preserveOwnerSections,
  stripOwnerSections,
} from "./working-memory-canonical.js";

const log = createSubsystemLogger("memory/canonical-propagation");

/** Events waiting beyond this are dropped oldest-first (logged); reconcile replays them. */
export const MAX_QUEUED_EVENTS = 500;
/** Outbox rows replayed per reconcile pass. */
export const RECONCILE_BATCH = 100;
/** Stamped outbox rows older than this are pruned. */
const OUTBOX_RETENTION_MS = 30 * 24 * 3_600_000;
/** Orphan-mark cleanup: rows examined per batch, batches per pass. */
const ORPHAN_BATCH = 500;
const ORPHAN_MAX_BATCHES = 40;
export const RECONCILE_INITIAL_DELAY_MS = 60_000;
export const RECONCILE_INTERVAL_MS = 30 * 60_000;

export type CanonicalPropagationDeps = {
  /** The live memory DB (the manager swaps it on reindex). */
  getDb: () => DatabaseSync;
  getFtsTable?: () => string | null;
  getKnowledgeGraph?: () => KnowledgeGraphManager | null;
  getDirectives?: () => EpistemicDirectiveEngine | null;
  /** Defaults to the gateway's active task store. */
  getTaskStore?: () => TaskStore | null;
  /** The workspace this memory database belongs to (decides project scope). */
  getWorkspaceDir?: () => string | null;
  /** Queue bound (tests). */
  maxQueued?: number;
};

export type ConsumerName =
  | "restore"
  | "search"
  | "preferences"
  | "graph"
  | "briefs_tasks"
  | "insights";

export type PropagationOutcome = {
  event: CanonicalChangeEvent;
  skipped?: "not_committed";
  results: Partial<Record<ConsumerName, unknown>>;
  errors: Partial<Record<ConsumerName, string>>;
};

/**
 * Did the write behind this event land? The emitting statements may have
 * run inside a SAVEPOINT that later rolled back. With an outbox row the
 * answer is that row (written in the same transaction); without one (a
 * pre-v78 database) the fact row is read.
 */
export function isCanonicalChangeCommitted(db: DatabaseSync, event: CanonicalChangeEvent): boolean {
  if (event.outboxId !== undefined) {
    try {
      return Boolean(
        db.prepare(`SELECT 1 FROM canonical_change_outbox WHERE id = ?`).get(event.outboxId),
      );
    } catch {
      return false;
    }
  }
  let row: { value: string; status: string } | undefined;
  try {
    row = db
      .prepare(`SELECT value, status FROM canonical_facts WHERE id = ?`)
      .get(event.factId) as typeof row;
  } catch {
    return false;
  }
  if (!row) {
    return false; // an add or supersede that rolled back leaves no row
  }
  switch (event.op) {
    case "retire":
      return row.status !== "active";
    case "unretire":
    case "reactivate":
      return row.status === "active" || row.status === "superseded";
    default:
      return row.value === event.newValue;
  }
}

export class CanonicalPropagation {
  private readonly deps: CanonicalPropagationDeps;
  private readonly queue: CanonicalChangeEvent[] = [];
  /** Outbox ids queued or being processed, so reconcile never doubles them. */
  private readonly pendingOutbox = new Set<number>();
  private draining: Promise<void> | null = null;
  private closed = false;
  private readonly outcomeListeners = new Set<(o: PropagationOutcome) => void>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private reconciling = false;

  constructor(deps: CanonicalPropagationDeps) {
    this.deps = deps;
  }

  /** Queue an event. Never blocks and never throws into the caller. */
  enqueue(event: CanonicalChangeEvent): void {
    if (this.closed) {
      return;
    }
    if (event.outboxId !== undefined) {
      if (this.pendingOutbox.has(event.outboxId)) {
        return;
      }
      this.pendingOutbox.add(event.outboxId);
    }
    if (this.queue.length >= (this.deps.maxQueued ?? MAX_QUEUED_EVENTS)) {
      const dropped = this.queue.shift()!;
      if (dropped.outboxId !== undefined) {
        this.pendingOutbox.delete(dropped.outboxId);
      }
      log.warn(`canonical propagation queue full; deferred [${dropped.key}] to the reconcile pass`);
    }
    this.queue.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.draining || this.closed) {
      return;
    }
    this.draining = new Promise<void>((resolve) => {
      // A macrotask, not a microtask: the caller's transaction, the tool
      // result and the rest of the turn's synchronous work go first.
      setTimeout(() => {
        void this.drain().finally(() => {
          this.draining = null;
          resolve();
          if (this.queue.length > 0) {
            this.schedule();
          }
        });
      }, 0);
    });
  }

  /** Resolves when every queued event has been handled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
  }

  /**
   * Replay on a timer: once after `initialDelayMs`, then every `intervalMs`.
   * Timers are unref'd so they never hold the process open.
   */
  startReconcile(opts?: { initialDelayMs?: number; intervalMs?: number }): void {
    if (this.closed || this.timers.length > 0) {
      return;
    }
    const run = () => {
      void this.reconcile().catch((err) => log.warn(`canonical reconcile failed: ${String(err)}`));
    };
    const first = setTimeout(run, opts?.initialDelayMs ?? RECONCILE_INITIAL_DELAY_MS);
    const every = setInterval(run, opts?.intervalMs ?? RECONCILE_INTERVAL_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  /**
   * Replay unpropagated outbox rows (oldest first, capped), prune old
   * stamped rows, delete marks whose chunk is gone. Returns how many rows
   * were queued.
   */
  async reconcile(): Promise<{ replayed: number; orphansRemoved: number }> {
    const out = { replayed: 0, orphansRemoved: 0 };
    if (this.closed || this.reconciling) {
      return out;
    }
    this.reconciling = true;
    try {
      const db = this.deps.getDb();
      let rows: Array<{ id: number; event_json: string }> = [];
      try {
        rows = db
          .prepare(
            `SELECT id, event_json FROM canonical_change_outbox
              WHERE propagated_at IS NULL ORDER BY id LIMIT ?`,
          )
          .all(RECONCILE_BATCH) as unknown as typeof rows;
      } catch {
        return out; // pre-v78 database
      }
      for (const row of rows) {
        if (this.pendingOutbox.has(row.id)) {
          continue;
        }
        try {
          const event = JSON.parse(row.event_json) as CanonicalChangeEvent;
          this.enqueue({ ...event, outboxId: row.id });
          out.replayed++;
        } catch {
          // unreadable row: stamp it so it is not retried forever
          this.stampOutbox(db, row.id);
        }
      }
      if (out.replayed > 0) {
        log.info(`canonical reconcile: replaying ${out.replayed} unpropagated change(s)`);
      }
      try {
        db.prepare(
          `DELETE FROM canonical_change_outbox WHERE propagated_at IS NOT NULL AND propagated_at < ?`,
        ).run(Date.now() - OUTBOX_RETENTION_MS);
      } catch {
        // best-effort
      }
      out.orphansRemoved = await this.removeOrphanMarks(db);
      return out;
    } finally {
      this.reconciling = false;
    }
  }

  private async removeOrphanMarks(db: DatabaseSync): Promise<number> {
    let removed = 0;
    let after = 0;
    try {
      const page = db.prepare(
        `SELECT s.rowid AS rid, s.chunk_id AS chunk_id, c.id AS present
           FROM chunk_supersessions s LEFT JOIN chunks c ON c.id = s.chunk_id
          WHERE s.rowid > ? ORDER BY s.rowid LIMIT ?`,
      );
      const del = db.prepare(`DELETE FROM chunk_supersessions WHERE rowid = ?`);
      for (let batch = 0; batch < ORPHAN_MAX_BATCHES; batch++) {
        const rows = page.all(after, ORPHAN_BATCH) as unknown as Array<{
          rid: number;
          chunk_id: string;
          present: string | null;
        }>;
        if (rows.length === 0) {
          break;
        }
        for (const r of rows) {
          if (r.present === null) {
            removed += Number(del.run(r.rid).changes);
          }
        }
        after = rows[rows.length - 1]!.rid;
        await yieldToEventLoop();
      }
    } catch (err) {
      log.debug(`orphan mark cleanup skipped: ${String(err)}`);
    }
    return removed;
  }

  /** Stop accepting events and timers; queued ones stay in the outbox for the next start. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.pendingOutbox.clear();
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  onOutcome(listener: (o: PropagationOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => {
      this.outcomeListeners.delete(listener);
    };
  }

  private stampOutbox(db: DatabaseSync, id: number): void {
    try {
      db.prepare(`UPDATE canonical_change_outbox SET propagated_at = ? WHERE id = ?`).run(
        Date.now(),
        id,
      );
    } catch {
      // pre-v78 database
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      const event = this.queue.shift()!;
      let outcome: PropagationOutcome;
      try {
        outcome = await this.process(event);
      } catch (err) {
        log.warn(`canonical propagation failed for [${event.key}]: ${String(err)}`);
        continue;
      } finally {
        if (event.outboxId !== undefined) {
          this.pendingOutbox.delete(event.outboxId);
        }
      }
      // Fully drained (each consumer ran or logged its failure): stamp it,
      // unless the queue was closed mid-event, which leaves it for reconcile.
      if (event.outboxId !== undefined && !this.closed) {
        this.stampOutbox(this.deps.getDb(), event.outboxId);
      }
      for (const l of this.outcomeListeners) {
        try {
          l(outcome);
        } catch {
          // observers never break the drain
        }
      }
      await yieldToEventLoop();
    }
  }

  /** Run every consumer for one event. */
  async process(event: CanonicalChangeEvent): Promise<PropagationOutcome> {
    const db = this.deps.getDb();
    const outcome: PropagationOutcome = { event, results: {}, errors: {} };
    if (!isCanonicalChangeCommitted(db, event)) {
      outcome.skipped = "not_committed";
      log.debug(`canonical:changed [${event.key}] ${event.op} not committed; nothing propagated`);
      return outcome;
    }
    const project = changeProject(event);
    const activeProject = resolveActiveProjectName(this.deps.getWorkspaceDir?.() ?? null);
    // A project change touches global stores never, and this database's
    // stores only when it is that project's workspace.
    const local = project === null || project === activeProject;
    const global = project === null;
    const run = async (name: ConsumerName, fn: () => unknown): Promise<void> => {
      try {
        outcome.results[name] = await fn();
      } catch (err) {
        outcome.errors[name] = String(err);
        log.warn(`canonical:changed consumer ${name} failed for [${event.key}]: ${String(err)}`);
      }
      await yieldToEventLoop();
    };
    if (event.newValue && global) {
      await run("restore", () =>
        restoreForValue(db, this.deps.getKnowledgeGraph?.() ?? null, event.key, event.newValue!),
      );
    }
    if (local) {
      await run("search", () =>
        propagateSupersededChunks(db, event, { ftsTable: this.deps.getFtsTable?.() ?? null }),
      );
    }
    if (global) {
      await run("preferences", () => propagateToPreferences(db, event));
      await run("graph", () => {
        const kg = this.deps.getKnowledgeGraph?.() ?? null;
        return kg ? propagateToKnowledgeGraph(db, kg, event) : null;
      });
    }
    if (local) {
      await run("briefs_tasks", () =>
        propagateToBriefsAndTasks({
          db,
          event,
          taskStore: (this.deps.getTaskStore ?? getActiveTaskStore)(),
          directives: this.deps.getDirectives?.() ?? null,
          includeTasks: global,
        }),
      );
      await run("insights", () => propagateToDreamInsights(db, event));
    }
    return outcome;
  }
}
