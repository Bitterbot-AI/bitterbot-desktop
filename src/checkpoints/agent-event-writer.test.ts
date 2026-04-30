import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { startCheckpointWriter, stopCheckpointWriter } from "./agent-event-writer.js";
import { CheckpointStore } from "./store.js";

describe("checkpoint agent-event writer", () => {
  let dir: string;
  let dbPath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cp-writer-"));
    dbPath = path.join(dir, "checkpoints.sqlite");
    prevEnv = process.env.BITTERBOT_CHECKPOINTS;
    process.env.BITTERBOT_CHECKPOINTS = "1";
  });

  afterEach(() => {
    stopCheckpointWriter();
    if (prevEnv === undefined) {
      delete process.env.BITTERBOT_CHECKPOINTS;
    } else {
      process.env.BITTERBOT_CHECKPOINTS = prevEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists tool start + result events as a parented chain", () => {
    expect(startCheckpointWriter({ dbPath })).toBe(true);

    emitAgentEvent({
      runId: "run-A",
      stream: "tool",
      data: { phase: "start", name: "Read", toolCallId: "tc1", args: { path: "/a" } },
    });
    emitAgentEvent({
      runId: "run-A",
      stream: "tool",
      data: {
        phase: "result",
        name: "Read",
        toolCallId: "tc1",
        isError: false,
        result: "abc",
      },
    });

    const store = CheckpointStore.open(dbPath);
    try {
      const list = store.list("run-A");
      expect(list.map((c) => c.kind)).toEqual(["tool_call", "tool_result"]);
      // parent chain: result.parent === call.stepId
      expect(list[1].parentStepId).toBe(list[0].stepId);
      expect(list[0].label).toBe("Read start");
      expect(list[1].label).toBe("Read result");
    } finally {
      store.close();
    }
  });

  it("skips tool 'update' partial frames", () => {
    expect(startCheckpointWriter({ dbPath })).toBe(true);

    emitAgentEvent({
      runId: "run-B",
      stream: "tool",
      data: { phase: "start", name: "Bash", toolCallId: "tc1" },
    });
    emitAgentEvent({
      runId: "run-B",
      stream: "tool",
      data: { phase: "update", name: "Bash", toolCallId: "tc1", partialResult: "..." },
    });
    emitAgentEvent({
      runId: "run-B",
      stream: "tool",
      data: { phase: "result", name: "Bash", toolCallId: "tc1", isError: false, result: "ok" },
    });

    const store = CheckpointStore.open(dbPath);
    try {
      const list = store.list("run-B");
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.kind)).toEqual(["tool_call", "tool_result"]);
    } finally {
      store.close();
    }
  });

  it("returns false when BITTERBOT_CHECKPOINTS is not set", () => {
    delete process.env.BITTERBOT_CHECKPOINTS;
    expect(startCheckpointWriter({ dbPath })).toBe(false);
  });

  it("is idempotent: a second start call is a no-op", () => {
    expect(startCheckpointWriter({ dbPath })).toBe(true);
    expect(startCheckpointWriter({ dbPath })).toBe(true);
  });
});
