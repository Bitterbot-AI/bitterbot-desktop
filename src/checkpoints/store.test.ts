import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./store.js";

describe("CheckpointStore", () => {
  let dir: string;
  let dbPath: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-checkpoints-"));
    dbPath = path.join(dir, "checkpoints.sqlite");
    store = CheckpointStore.open(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("saves and retrieves a checkpoint with its decompressed state", () => {
    store.save({
      threadId: "t1",
      stepId: "s1",
      kind: "user_message",
      state: { messages: [{ role: "user", content: "hi" }] },
      label: "first message",
    });
    const got = store.get("t1", "s1");
    expect(got).toBeDefined();
    expect(got?.kind).toBe("user_message");
    expect(got?.label).toBe("first message");
    expect(got?.state).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("is idempotent on repeated saves of the same (thread, step)", () => {
    const first = store.save({
      threadId: "t1",
      stepId: "s1",
      kind: "user_message",
      state: { v: 1 },
    });
    const second = store.save({
      threadId: "t1",
      stepId: "s1",
      kind: "user_message",
      state: { v: 999 }, // ignored — first save wins
    });
    expect(second.id).toBe(first.id);
    const got = store.get("t1", "s1");
    expect(got?.state).toEqual({ v: 1 });
  });

  it("walks ancestors back to the root, oldest-first", () => {
    store.save({ threadId: "t1", stepId: "s1", kind: "user_message", state: { v: 1 } });
    store.save({
      threadId: "t1",
      stepId: "s2",
      parentStepId: "s1",
      kind: "assistant_message",
      state: { v: 2 },
    });
    store.save({
      threadId: "t1",
      stepId: "s3",
      parentStepId: "s2",
      kind: "tool_call",
      state: { v: 3 },
    });
    const lineage = store.ancestors("t1", "s3");
    expect(lineage.map((cp) => cp.stepId)).toEqual(["s1", "s2", "s3"]);
  });

  it("forks a thread by copying lineage and adding a fork_root marker", () => {
    store.save({ threadId: "t1", stepId: "s1", kind: "user_message", state: { v: 1 } });
    store.save({
      threadId: "t1",
      stepId: "s2",
      parentStepId: "s1",
      kind: "assistant_message",
      state: { v: 2 },
    });
    store.save({
      threadId: "t1",
      stepId: "s3",
      parentStepId: "s2",
      kind: "tool_call",
      state: { v: 3 },
    });

    const newThread = store.fork("t1", "s2", { newThreadId: "t1-fork" });
    expect(newThread).toBe("t1-fork");

    const checkpoints = store.list("t1-fork");
    // Lineage of s2 (s1 → s2) plus one fork_root marker = 3 rows.
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((cp) => cp.kind)).toEqual([
      "user_message",
      "assistant_message",
      "fork_root",
    ]);
    // The fork_root must reference the source step.
    const forkRoot = checkpoints.find((cp) => cp.kind === "fork_root");
    expect(forkRoot?.parentStepId).toBe("s2");

    // Original thread is untouched.
    expect(store.list("t1")).toHaveLength(3);
  });

  it("listThreads reports thread membership and step counts", () => {
    store.save({ threadId: "a", stepId: "s1", kind: "user_message", state: {} });
    store.save({ threadId: "a", stepId: "s2", parentStepId: "s1", kind: "tool_call", state: {} });
    store.save({ threadId: "b", stepId: "s1", kind: "user_message", state: {} });
    const threads = store.listThreads();
    const map = new Map(threads.map((t) => [t.threadId, t.steps]));
    expect(map.get("a")).toBe(2);
    expect(map.get("b")).toBe(1);
  });

  it("deleteThread removes only the named thread's checkpoints", () => {
    store.save({ threadId: "keep", stepId: "s1", kind: "user_message", state: {} });
    store.save({ threadId: "drop", stepId: "s1", kind: "user_message", state: {} });
    store.save({
      threadId: "drop",
      stepId: "s2",
      parentStepId: "s1",
      kind: "tool_call",
      state: {},
    });

    const removed = store.deleteThread("drop");
    expect(removed).toBe(2);
    expect(store.list("drop")).toHaveLength(0);
    expect(store.list("keep")).toHaveLength(1);
  });
});
