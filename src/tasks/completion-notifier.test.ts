import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "./store.js";
import {
  isCompletionNotifierEnabled,
  startCompletionNotifier,
  stopCompletionNotifier,
} from "./completion-notifier.js";
import { startTaskStore, stopTaskStore, getActiveTaskStore } from "./store.js";

/** B4: `completed` is reachable only through a passing verification. */
function completeVerified(
  store: TaskStore,
  id: string,
  opts: { output?: string; reasoning?: string } = {},
) {
  if (opts.output !== undefined) {
    store.update(id, { output: opts.output });
  }
  return store.recordVerification(
    id,
    {
      verdict: "pass",
      level: 2,
      checks: [],
      judgeModel: "test/judge",
      reasoning: opts.reasoning ?? "criteria verified",
      missing: [],
      round: 0,
      at: 0,
      runId: null,
    },
    "completed",
  );
}

type EnqueueArgs = [string, { sessionKey: string; contextKey?: string }];

describe("completion-notifier", () => {
  let dir: string;
  let prevEnv: string | undefined;
  const enqueue = vi.fn();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-completion-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
    enqueue.mockReset();
    prevEnv = process.env.BITTERBOT_TASKS_COMPLETION_NOTIFY;
  });

  afterEach(() => {
    stopCompletionNotifier();
    stopTaskStore();
    if (prevEnv === undefined) {
      delete process.env.BITTERBOT_TASKS_COMPLETION_NOTIFY;
    } else {
      process.env.BITTERBOT_TASKS_COMPLETION_NOTIFY = prevEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fires on completed transition for tasks with an agentSessionKey", () => {
    expect(startCompletionNotifier({ enqueue })).toBe(true);
    const store = getActiveTaskStore()!;
    const t = store.create({
      goal: "ship docs",
      doneCriteria: "x",
      agentSessionKey: "sess-abc",
    });
    store.update(t.id, { status: "running" });
    expect(enqueue).not.toHaveBeenCalled();
    completeVerified(store, t.id, { output: "crystal:docs-1" });
    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0] as EnqueueArgs;
    expect(text).toMatch(/\[task completed\]/);
    expect(text).toMatch(/Task task-/);
    expect(text).toMatch(/Output: crystal:docs-1/);
    expect(opts.sessionKey).toBe("sess-abc");
    expect(opts.contextKey).toBe(`task-complete:${t.id}`);
  });

  it("fires on failed transition", () => {
    startCompletionNotifier({ enqueue });
    const store = getActiveTaskStore()!;
    const t = store.create({
      goal: "g",
      doneCriteria: "x",
      agentSessionKey: "sess-fail",
    });
    store.update(t.id, { status: "failed" });
    expect(enqueue).toHaveBeenCalledOnce();
    const [text] = enqueue.mock.calls[0] as EnqueueArgs;
    expect(text).toMatch(/\[task failed\]/);
  });

  it("does not fire on intermediate status changes", () => {
    startCompletionNotifier({ enqueue });
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "g", doneCriteria: "x", agentSessionKey: "s" });
    store.update(t.id, { status: "planning" });
    store.update(t.id, { status: "running" });
    store.update(t.id, { status: "waiting_external" });
    store.update(t.id, { status: "judging" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not fire when the task has no agentSessionKey", () => {
    startCompletionNotifier({ enqueue });
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "g", doneCriteria: "x" });
    completeVerified(store, t.id);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("includes the judge reasoning from the verification record", () => {
    startCompletionNotifier({ enqueue });
    const store = getActiveTaskStore()!;
    const t = store.create({
      goal: "g",
      doneCriteria: "x",
      agentSessionKey: "s",
    });
    completeVerified(store, t.id, { reasoning: "all criteria verified" });
    const [text] = enqueue.mock.calls[0] as EnqueueArgs;
    expect(text).toMatch(/Judge \(L2\): all criteria verified/);
  });

  it("is disabled when BITTERBOT_TASKS_COMPLETION_NOTIFY=0", () => {
    process.env.BITTERBOT_TASKS_COMPLETION_NOTIFY = "0";
    expect(isCompletionNotifierEnabled()).toBe(false);
    expect(startCompletionNotifier({ enqueue })).toBe(false);
  });

  it("returns false when no task store is active", () => {
    stopTaskStore();
    expect(startCompletionNotifier({ enqueue })).toBe(false);
  });

  it("start is idempotent", () => {
    expect(startCompletionNotifier({ enqueue })).toBe(true);
    expect(startCompletionNotifier({ enqueue })).toBe(true);
  });

  it("survives a listener throwing", () => {
    const badEnqueue = vi.fn(() => {
      throw new Error("downstream failure");
    });
    startCompletionNotifier({ enqueue: badEnqueue });
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "g", doneCriteria: "x", agentSessionKey: "s" });
    // Should not throw out of the store call.
    expect(() => completeVerified(store, t.id)).not.toThrow();
  });
});
