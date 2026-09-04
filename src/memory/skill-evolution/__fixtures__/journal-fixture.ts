/**
 * In-memory event-journal fixture for skill-evolution tests. Builds
 * synthetic runs with the same event shapes the production subscribe
 * handlers emit (see pi-embedded-subscribe.handlers.*).
 */

import { EventJournal } from "../../../infra/event-journal.js";
import { requireNodeSqlite } from "../../sqlite.js";

export function makeFixtureJournal(): EventJournal {
  const { DatabaseSync } = requireNodeSqlite();
  return new EventJournal(new DatabaseSync(":memory:"));
}

export interface FixtureRunOptions {
  runId: string;
  sessionKey?: string;
  taskId?: string;
  /** Steps in emission order. */
  steps?: Array<
    | { kind: "assistant"; texts: string[] }
    | {
        kind: "tool";
        name: string;
        args?: Record<string, unknown>;
        result?: string;
        isError?: boolean;
        /** Emit only the start event (run died mid-call). */
        noResult?: boolean;
      }
  >;
  /** Terminal lifecycle: "end" | "error" | "none". Default "end". */
  terminal?: "end" | "error" | "none";
  errorText?: string;
  completedExplicitly?: boolean;
  tsBase?: number;
  /**
   * PLAN-44 Phase 0: emit a `user` stream event (the task header) right
   * after lifecycle start, like pi-embedded-runner/run.ts does.
   */
  task?: { text: string; isHeartbeat?: boolean; channel?: string };
}

let toolCallCounter = 0;

/** Append one synthetic run to the journal. Returns nothing; seqs are global. */
export function appendFixtureRun(journal: EventJournal, opts: FixtureRunOptions): void {
  let runSeq = 0;
  let ts = opts.tsBase ?? Date.now();
  const emit = (stream: string, data: Record<string, unknown>) => {
    runSeq += 1;
    ts += 10;
    journal.append({
      runId: opts.runId,
      seq: runSeq,
      stream,
      ts,
      data,
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    });
  };

  emit("lifecycle", { phase: "start", startedAt: ts });
  if (opts.task) {
    emit("user", {
      text: opts.task.text,
      chars: opts.task.text.length,
      isHeartbeat: opts.task.isHeartbeat === true,
      ...(opts.task.channel ? { channel: opts.task.channel } : {}),
    });
  }
  for (const step of opts.steps ?? []) {
    if (step.kind === "assistant") {
      // Streamed: cumulative text per event, like the production handler.
      for (const text of step.texts) {
        emit("assistant", { text, delta: text });
      }
    } else {
      toolCallCounter += 1;
      const toolCallId = `call-${toolCallCounter}`;
      emit("tool", { phase: "start", name: step.name, toolCallId, args: step.args ?? {} });
      if (!step.noResult) {
        emit("tool", {
          phase: "result",
          name: step.name,
          toolCallId,
          meta: {},
          isError: step.isError === true,
          result: step.result ?? "ok",
        });
      }
    }
  }
  const terminal = opts.terminal ?? "end";
  if (terminal === "end") {
    emit("lifecycle", {
      phase: "end",
      endedAt: ts,
      completedExplicitly: opts.completedExplicitly === true,
    });
  } else if (terminal === "error") {
    emit("lifecycle", {
      phase: "error",
      error: opts.errorText ?? "LLM request failed.",
      endedAt: ts,
    });
  }
}
