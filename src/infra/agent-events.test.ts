import { describe, expect, test } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  emitUserTurnEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
  USER_TURN_EVENT_MAX_CHARS,
} from "./agent-events.js";

describe("agent-events sequencing", () => {
  test("stores and clears run context", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });
});

// PLAN-44 Phase 0: the `user` stream (what a run was asked), once per run.
describe("emitUserTurnEvent", () => {
  test("emits one capped user event per runId, deduping retries", () => {
    const seen: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "user-turn-run") {
        seen.push({ stream: evt.stream, data: evt.data });
      }
    });
    try {
      const text = "x".repeat(USER_TURN_EVENT_MAX_CHARS + 50);
      emitUserTurnEvent({ runId: "user-turn-run", text, isHeartbeat: true, channel: "whatsapp" });
      emitUserTurnEvent({ runId: "user-turn-run", text: "retry attempt, same run" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.stream).toBe("user");
      expect(String(seen[0]?.data.text).length).toBe(USER_TURN_EVENT_MAX_CHARS);
      expect(seen[0]?.data.chars).toBe(USER_TURN_EVENT_MAX_CHARS + 50);
      expect(seen[0]?.data.isHeartbeat).toBe(true);
      expect(seen[0]?.data.channel).toBe("whatsapp");
    } finally {
      stop();
    }
  });
});
