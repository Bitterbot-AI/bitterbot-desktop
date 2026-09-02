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

  it("tasks/list is a trusted-caller surface (PLAN-43 R1)", () => {
    const m = manager();
    const denied = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/list", params: {}, id: "1" },
      { taskManager: m },
    );
    expect(denied.error?.code).toBe(A2aErrorCodes.UNAUTHORIZED);

    const allowed = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/list", params: {}, id: "1" },
      { taskManager: m, callerTrusted: true },
    );
    expect(Array.isArray(allowed.result)).toBe(true);
  });

  it("tasks/cancel rejects unknown tasks with TASK_NOT_CANCELABLE (trusted caller)", () => {
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/cancel", params: { id: "missing" }, id: "1" },
      { taskManager: manager(), callerTrusted: true },
    );
    expect(res.error?.code).toBe(A2aErrorCodes.TASK_NOT_CANCELABLE);
  });
});

// PLAN-43 Phase 1 (R1): task reads are scoped to their creator. Under
// a2a.authentication "none", buyer A must not be able to read buyer B's
// paid result — the per-task access token from the create response is the
// only untrusted read capability, and a wrong token is indistinguishable
// from a missing task.
describe("per-task access tokens", () => {
  function createTask(m: A2aTaskManager) {
    const res = handleA2aJsonRpc(
      {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
        id: "1",
      },
      { taskManager: m },
    );
    return res.result as { id: string; accessToken?: string };
  }

  it("the create response carries the token; task reads never do", () => {
    const m = manager();
    const created = createTask(m);
    expect(created.accessToken).toMatch(/^[0-9a-f]{32}$/);

    const read = handleA2aJsonRpc(
      {
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: created.id, accessToken: created.accessToken },
        id: "2",
      },
      { taskManager: m },
    );
    expect((read.result as { id?: string }).id).toBe(created.id);
    expect((read.result as { accessToken?: string }).accessToken).toBeUndefined();
  });

  it("an untrusted caller without the right token gets TASK_NOT_FOUND (no id-probing)", () => {
    const m = manager();
    const created = createTask(m);

    const noToken = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/get", params: { id: created.id }, id: "2" },
      { taskManager: m },
    );
    expect(noToken.error?.code).toBe(A2aErrorCodes.TASK_NOT_FOUND);

    const wrongToken = handleA2aJsonRpc(
      {
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: created.id, accessToken: "0".repeat(32) },
        id: "3",
      },
      { taskManager: m },
    );
    expect(wrongToken.error?.code).toBe(A2aErrorCodes.TASK_NOT_FOUND);
  });

  it("a trusted caller reads any task without a token", () => {
    const m = manager();
    const created = createTask(m);
    const res = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/get", params: { id: created.id }, id: "2" },
      { taskManager: m, callerTrusted: true },
    );
    expect((res.result as { id?: string }).id).toBe(created.id);
  });

  it("tasks/cancel is token-gated the same way", () => {
    const m = manager();
    const created = createTask(m);
    const denied = handleA2aJsonRpc(
      { jsonrpc: "2.0", method: "tasks/cancel", params: { id: created.id }, id: "2" },
      { taskManager: m },
    );
    expect(denied.error?.code).toBe(A2aErrorCodes.TASK_NOT_FOUND);

    const ok = handleA2aJsonRpc(
      {
        jsonrpc: "2.0",
        method: "tasks/cancel",
        params: { id: created.id, accessToken: created.accessToken },
        id: "3",
      },
      { taskManager: m },
    );
    expect((ok.result as { status?: { state?: string } }).status?.state).toBe("canceled");
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
