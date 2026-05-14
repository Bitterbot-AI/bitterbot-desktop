import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "./agent-events.js";
import {
  EventJournal,
  isEventJournalEnabled,
  startEventJournal,
  stopEventJournal,
} from "./event-journal.js";

describe("EventJournal", () => {
  let dir: string;
  let dbPath: string;
  let prevEnabled: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-journal-"));
    dbPath = path.join(dir, "journal.sqlite");
    prevEnabled = process.env.BITTERBOT_EVENT_JOURNAL;
    process.env.BITTERBOT_EVENT_JOURNAL = "1";
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    stopEventJournal();
    if (prevEnabled === undefined) {
      delete process.env.BITTERBOT_EVENT_JOURNAL;
    } else {
      process.env.BITTERBOT_EVENT_JOURNAL = prevEnabled;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends and queries events by runId", () => {
    const j = EventJournal.open(dbPath);
    try {
      j.append({
        runId: "run-A",
        seq: 1,
        stream: "tool",
        ts: 1000,
        data: { phase: "start", name: "Read" },
      });
      j.append({
        runId: "run-A",
        seq: 2,
        stream: "tool",
        ts: 1100,
        data: { phase: "result", name: "Read", result: "ok" },
      });
      j.append({
        runId: "run-B",
        seq: 1,
        stream: "lifecycle",
        ts: 1200,
        data: { phase: "start" },
      });

      const aEvents = j.query({ runId: "run-A" });
      expect(aEvents).toHaveLength(2);
      expect(aEvents[0].data).toEqual({ phase: "start", name: "Read" });
      expect(aEvents[1].runSeq).toBe(2);

      const bEvents = j.query({ runId: "run-B" });
      expect(bEvents).toHaveLength(1);
      expect(bEvents[0].stream).toBe("lifecycle");
    } finally {
      j.close();
    }
  });

  it("supports sinceSeq cursor for incremental polling", () => {
    const j = EventJournal.open(dbPath);
    try {
      for (let i = 1; i <= 5; i += 1) {
        j.append({
          runId: "run-X",
          seq: i,
          stream: "assistant",
          ts: 1000 + i,
          data: { chunk: `c${i}` },
        });
      }
      const all = j.query({ runId: "run-X" });
      expect(all).toHaveLength(5);
      const tail = j.query({ runId: "run-X", sinceSeq: all[2].seq });
      expect(tail).toHaveLength(2);
      expect((tail[0].data as { chunk: string }).chunk).toBe("c4");
    } finally {
      j.close();
    }
  });

  it("indexes by taskId and supports task-scoped queries", () => {
    const j = EventJournal.open(dbPath);
    try {
      j.append({
        runId: "run-1",
        taskId: "task-α",
        seq: 1,
        stream: "tool",
        ts: 1000,
        data: { phase: "start", name: "X" },
      });
      j.append({
        runId: "run-2",
        taskId: "task-α",
        seq: 1,
        stream: "tool",
        ts: 1100,
        data: { phase: "start", name: "Y" },
      });
      j.append({
        runId: "run-3",
        taskId: "task-β",
        seq: 1,
        stream: "tool",
        ts: 1200,
        data: { phase: "start", name: "Z" },
      });

      const alpha = j.query({ taskId: "task-α" });
      expect(alpha).toHaveLength(2);
      expect(alpha.map((e) => e.runId).toSorted()).toEqual(["run-1", "run-2"]);
      expect(j.countForTask("task-α")).toBe(2);
      expect(j.countForTask("task-β")).toBe(1);
    } finally {
      j.close();
    }
  });

  it("filters by stream", () => {
    const j = EventJournal.open(dbPath);
    try {
      j.append({ runId: "r", seq: 1, stream: "tool", ts: 1, data: {} });
      j.append({ runId: "r", seq: 2, stream: "assistant", ts: 2, data: {} });
      j.append({ runId: "r", seq: 3, stream: "tool", ts: 3, data: {} });
      j.append({ runId: "r", seq: 4, stream: "error", ts: 4, data: {} });

      const tools = j.query({ runId: "r", streams: ["tool"] });
      expect(tools).toHaveLength(2);

      const toolsOrError = j.query({ runId: "r", streams: ["tool", "error"] });
      expect(toolsOrError).toHaveLength(3);
    } finally {
      j.close();
    }
  });

  it("persists events across reopens (crash-survival)", () => {
    const j1 = EventJournal.open(dbPath);
    j1.append({
      runId: "run-S",
      seq: 1,
      stream: "tool",
      ts: 1000,
      data: { phase: "start", name: "Read" },
    });
    j1.close();

    // Simulated restart: open a fresh handle to the same DB file.
    const j2 = EventJournal.open(dbPath);
    try {
      const events = j2.query({ runId: "run-S" });
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ phase: "start", name: "Read" });
    } finally {
      j2.close();
    }
  });

  it("deleteTask removes only the targeted task", () => {
    const j = EventJournal.open(dbPath);
    try {
      j.append({ runId: "r1", taskId: "ta", seq: 1, stream: "tool", ts: 1, data: {} });
      j.append({ runId: "r1", taskId: "tb", seq: 2, stream: "tool", ts: 2, data: {} });
      j.append({ runId: "r2", taskId: "ta", seq: 1, stream: "tool", ts: 3, data: {} });

      const removed = j.deleteTask("ta");
      expect(removed).toBe(2);
      expect(j.countForTask("ta")).toBe(0);
      expect(j.countForTask("tb")).toBe(1);
    } finally {
      j.close();
    }
  });

  it("startEventJournal subscribes to the global bus", () => {
    const journal = startEventJournal({ dbPath });
    expect(journal).not.toBeNull();

    emitAgentEvent({
      runId: "run-bus",
      stream: "tool",
      data: { phase: "start", name: "Echo" },
    });
    emitAgentEvent({
      runId: "run-bus",
      stream: "tool",
      data: { phase: "result", name: "Echo", result: "ok" },
    });

    const events = journal!.query({ runId: "run-bus" });
    expect(events.map((e) => (e.data as { phase: string }).phase)).toEqual(["start", "result"]);
  });

  it("startEventJournal is idempotent", () => {
    const j1 = startEventJournal({ dbPath });
    const j2 = startEventJournal({ dbPath });
    expect(j1).toBe(j2);
  });

  it("returns null when BITTERBOT_EVENT_JOURNAL=0", () => {
    process.env.BITTERBOT_EVENT_JOURNAL = "0";
    expect(isEventJournalEnabled()).toBe(false);
    expect(startEventJournal({ dbPath })).toBeNull();
  });

  it("propagates taskId from the run context onto every event", () => {
    const journal = startEventJournal({ dbPath })!;
    registerAgentRunContext("run-ctx", { taskId: "task-ctx" });
    emitAgentEvent({ runId: "run-ctx", stream: "tool", data: { phase: "start" } });
    emitAgentEvent({ runId: "run-ctx", stream: "tool", data: { phase: "result" } });
    const events = journal.query({ taskId: "task-ctx" });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.taskId === "task-ctx")).toBe(true);
  });
});
