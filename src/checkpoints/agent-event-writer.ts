/**
 * Bridge from the agent-events bus to the checkpoint store.
 *
 * Subscribes to onAgentEvent and persists each meaningful event as a
 * checkpoint, using runId as the thread id and the per-run monotonic
 * `seq` as the step id. Skips text deltas and other high-frequency
 * streams so the resulting timeline stays at the granularity a human
 * (or `bitterbot checkpoints fork`) actually wants to navigate.
 *
 * Phase 1 of PLAN-14 Pillar 6 #2 integration: the persisted state is
 * the event payload itself, which produces a forkable, queryable
 * transcript. Phase 2 will dump full session snapshots from the runner
 * at compaction/turn boundaries to enable true replay (see PLAN-14).
 *
 * Gated by BITTERBOT_CHECKPOINTS=1 so the default install path remains
 * cost-free; checkpoint writes are SQLite inserts, not zero overhead.
 */

import os from "node:os";
import path from "node:path";
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { CheckpointKind } from "./store.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CheckpointStore } from "./store.js";

const log = createSubsystemLogger("checkpoints/agent-event-writer");

type WriterState = {
  store: CheckpointStore;
  unsubscribe: () => void;
  lastStepByRun: Map<string, string>;
};

let state: WriterState | null = null;

export function isCheckpointWriterEnabled(): boolean {
  const v = process.env.BITTERBOT_CHECKPOINTS;
  return v === "1" || v === "true";
}

export function defaultCheckpointDbPath(): string {
  return (
    process.env.BITTERBOT_CHECKPOINT_DB ??
    path.join(os.homedir(), ".bitterbot", "checkpoints.sqlite")
  );
}

/**
 * Start the checkpoint writer. Idempotent; second call is a no-op.
 * Returns true when the writer is now active, false when disabled.
 */
export function startCheckpointWriter(opts?: { dbPath?: string }): boolean {
  if (state) return true;
  if (!isCheckpointWriterEnabled()) return false;
  const dbPath = opts?.dbPath ?? defaultCheckpointDbPath();
  let store: CheckpointStore;
  try {
    store = CheckpointStore.open(dbPath);
  } catch (err) {
    log.warn(
      `failed to open checkpoint DB at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  const lastStepByRun = new Map<string, string>();
  const unsubscribe = onAgentEvent((evt) => {
    try {
      writeOne(store, lastStepByRun, evt);
    } catch (err) {
      log.warn(`checkpoint write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  state = { store, unsubscribe, lastStepByRun };
  log.info(`checkpoint writer active dbPath=${dbPath}`);
  return true;
}

export function stopCheckpointWriter(): void {
  if (!state) return;
  state.unsubscribe();
  state.store.close();
  state = null;
}

function writeOne(
  store: CheckpointStore,
  lastStepByRun: Map<string, string>,
  evt: AgentEventPayload,
): void {
  const kind = mapKind(evt);
  if (!kind) return;
  const stepId = String(evt.seq);
  const parent = lastStepByRun.get(evt.runId) ?? null;
  store.save({
    threadId: evt.runId,
    stepId,
    parentStepId: parent,
    ts: evt.ts,
    kind,
    state: evt.data,
    label: deriveLabel(evt),
    metadata: {
      stream: evt.stream,
      sessionKey: evt.sessionKey,
    },
  });
  lastStepByRun.set(evt.runId, stepId);
}

/**
 * Map a bus event to a checkpoint kind. Returns null for events we
 * intentionally skip (assistant text deltas, low-signal frames). Only
 * events on coarse boundaries get persisted to keep the timeline
 * navigable and fork-friendly.
 */
function mapKind(evt: AgentEventPayload): CheckpointKind | null {
  const phase = (evt.data?.phase as string | undefined) ?? "";
  if (evt.stream === "tool") {
    if (phase === "start") return "tool_call";
    if (phase === "result") return "tool_result";
    return null; // skip "update" partials
  }
  if (evt.stream === "lifecycle") {
    // Lifecycle start/end frame each turn — useful checkpoints to fork
    // around, but we tag both as "compaction" only when phase signals so;
    // otherwise call it a custom marker.
    if (phase === "end" || phase === "start") return "custom";
    return null;
  }
  return null;
}

function deriveLabel(evt: AgentEventPayload): string | undefined {
  const data = evt.data ?? {};
  if (evt.stream === "tool") {
    const name = (data.name as string | undefined) ?? "tool";
    const phase = (data.phase as string | undefined) ?? "";
    return `${name} ${phase}`.trim();
  }
  if (evt.stream === "lifecycle") {
    const phase = (data.phase as string | undefined) ?? "";
    return `run ${phase}`.trim();
  }
  return undefined;
}
