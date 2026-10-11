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
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveTaskStore, type TaskStore } from "../tasks/store.js";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { propagateToBriefsAndTasks } from "./canonical-supersede-briefs.js";
import { propagateToKnowledgeGraph } from "./canonical-supersede-graph.js";
import { propagateToDreamInsights } from "./canonical-supersede-insights.js";
import { propagateToPreferences } from "./canonical-supersede-preferences.js";
import { propagateSupersededChunks, yieldToEventLoop } from "./canonical-supersede-search.js";
import type { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import type { KnowledgeGraphManager } from "./knowledge-graph.js";

// One import site for the manager: the consumers it calls outside the queue.
export { CANONICAL_CHANGED_EVENT } from "./canonical-events.js";
export { applySupersededMarks } from "./canonical-supersede-search.js";
export {
  loadCanonicalSynthesisContext,
  preserveOwnerSections,
} from "./working-memory-canonical.js";

const log = createSubsystemLogger("memory/canonical-propagation");

/** Events waiting beyond this are dropped oldest-first (logged). */
export const MAX_QUEUED_EVENTS = 500;

export type CanonicalPropagationDeps = {
  /** The live memory DB (the manager swaps it on reindex). */
  getDb: () => DatabaseSync;
  getFtsTable?: () => string | null;
  getKnowledgeGraph?: () => KnowledgeGraphManager | null;
  getDirectives?: () => EpistemicDirectiveEngine | null;
  /** Defaults to the gateway's active task store. */
  getTaskStore?: () => TaskStore | null;
};

export type ConsumerName = "search" | "preferences" | "graph" | "briefs_tasks" | "insights";

export type PropagationOutcome = {
  event: CanonicalChangeEvent;
  skipped?: "not_committed";
  results: Partial<Record<ConsumerName, unknown>>;
  errors: Partial<Record<ConsumerName, string>>;
};

/**
 * Did the write behind this event land? The emitting statements may have
 * run inside a SAVEPOINT that later rolled back; the row is the truth.
 */
export function isCanonicalChangeCommitted(db: DatabaseSync, event: CanonicalChangeEvent): boolean {
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
      // Rolled back = still active. A later supersede/re-pin moved it on,
      // which is a newer event of its own; this retire still happened.
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
  private draining: Promise<void> | null = null;
  private closed = false;
  private readonly outcomeListeners = new Set<(o: PropagationOutcome) => void>();

  constructor(deps: CanonicalPropagationDeps) {
    this.deps = deps;
  }

  /** Queue an event. Never blocks and never throws into the caller. */
  enqueue(event: CanonicalChangeEvent): void {
    if (this.closed) {
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      const dropped = this.queue.shift();
      log.warn(`canonical propagation queue full; dropped event for [${dropped?.key}]`);
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
          // An event that arrived between the last shift and here.
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

  /** Stop accepting events; queued ones are dropped. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  onOutcome(listener: (o: PropagationOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => {
      this.outcomeListeners.delete(listener);
    };
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

  /** Run every consumer for one event (exported for tests via the instance). */
  async process(event: CanonicalChangeEvent): Promise<PropagationOutcome> {
    const db = this.deps.getDb();
    const outcome: PropagationOutcome = { event, results: {}, errors: {} };
    if (!isCanonicalChangeCommitted(db, event)) {
      outcome.skipped = "not_committed";
      log.debug(`canonical:changed [${event.key}] ${event.op} not committed; nothing propagated`);
      return outcome;
    }
    const run = async (name: ConsumerName, fn: () => unknown): Promise<void> => {
      try {
        outcome.results[name] = await fn();
      } catch (err) {
        outcome.errors[name] = String(err);
        log.warn(`canonical:changed consumer ${name} failed for [${event.key}]: ${String(err)}`);
      }
      await yieldToEventLoop();
    };
    await run("search", () =>
      propagateSupersededChunks(db, event, { ftsTable: this.deps.getFtsTable?.() ?? null }),
    );
    await run("preferences", () => propagateToPreferences(db, event));
    await run("graph", () => {
      const kg = this.deps.getKnowledgeGraph?.() ?? null;
      return kg ? propagateToKnowledgeGraph(db, kg, event) : null;
    });
    await run("briefs_tasks", () =>
      propagateToBriefsAndTasks({
        db,
        event,
        taskStore: (this.deps.getTaskStore ?? getActiveTaskStore)(),
        directives: this.deps.getDirectives?.() ?? null,
      }),
    );
    await run("insights", () => propagateToDreamInsights(db, event));
    return outcome;
  }
}
