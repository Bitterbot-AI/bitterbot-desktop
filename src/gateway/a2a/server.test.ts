import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { handleA2aJsonRpc, isStreamingMethod } from "./server.js";
import { A2aTaskManager } from "./task-manager.js";
import { A2aErrorCodes } from "./types.js";

function manager() {
  const db = new DatabaseSync(":memory:");
  return new A2aTaskManager(db, {} as never);
}

describe("handleA2aJsonRpc", () => {
  it("rejects requests missing jsonrpc=2.0", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "1.0" as never, method: "tasks/get", id: "1" },
      { taskManager: manager() },
    );
    expect(res.error?.code).toBe(A2aErrorCodes.INVALID_REQUEST);
  });

  it("returns METHOD_NOT_FOUND for unknown method", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/nope", id: "1" },
      { taskManager: manager() },
    );
    expect(res.error?.code).toBe(A2aErrorCodes.METHOD_NOT_FOUND);
  });

  it("dispatches message/send and creates a working task", () => {
    const m = manager();
    const res = handleA2aJsonRpc(
      {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
        id: 7,
      },
      { taskManager: m },
    );
    const task = res.result as { id?: string; status?: { state?: string } };
    expect(task.id).toBeTruthy();
    expect(task.status?.state).toBe("working");
    expect(res.id).toBe(7);
  });

  it("preserves numeric id 0 in the response (regression for !id falsy bug)", () => {
    const res = handleA2aJsonRpc(
      {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "x" }] } },
        id: 0,
      },
      { taskManager: manager() },
    );
    expect(res.id).toBe(0);
  });

  it("returns INVALID_PARAMS when message is missing", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "message/send", params: {}, id: "1" },
      { taskManager: manager() },
    );
    expect(res.error?.code).toBe(A2aErrorCodes.INVALID_PARAMS);
  });

  it("returns TASK_NOT_FOUND for tasks/get with missing id", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/get", params: { id: "non-existent" }, id: "1" },
      { taskManager: manager() },
    );
    expect(res.error?.code).toBe(A2aErrorCodes.TASK_NOT_FOUND);
  });

  it("tasks/list returns an array (empty when no tasks)", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/list", params: {}, id: "1" },
      { taskManager: manager() },
    );
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("tasks/cancel rejects unknown tasks with TASK_NOT_CANCELABLE", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/cancel", params: { id: "missing" }, id: "1" },
      { taskManager: manager() },
    );
    expect(res.error?.code).toBe(A2aErrorCodes.TASK_NOT_CANCELABLE);
  });
});

describe("isStreamingMethod", () => {
  it("returns true for message/stream", () => {
    expect(isStreamingMethod({ jsonrpc: "2.0", method: "message/stream", id: "1" })).toBe(true);
  });

  it("returns false for message/send", () => {
    expect(isStreamingMethod({ jsonrpc: "2.0", method: "message/send", id: "1" })).toBe(false);
  });
});
