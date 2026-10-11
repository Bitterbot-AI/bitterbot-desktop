/**
 * PLAN-55 Phase 2: task_get returns the stale-fact flags memory propagation
 * wrote on a task whose plan cites a value the owner since corrected.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { getActiveTaskStore, startTaskStore, stopTaskStore } from "../../tasks/store.js";
import { createTaskGetTool } from "./task-tool.js";

type GetResult = { ok: boolean; staleFacts?: unknown[]; task?: { lastSeenAt: number } };

async function get(taskId: string): Promise<GetResult> {
  const result = await createTaskGetTool().execute(
    "tc-stale",
    { task_id: taskId, include_recent_events: false },
    { signal: new AbortController().signal },
  );
  return result.details as GetResult;
}

describe("task_get staleFacts", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-task-stale-"));
    resetAgentRunContextForTest();
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is absent without flags and present once flagged; flagging is not activity", async () => {
    const store = getActiveTaskStore()!;
    const task = store.create({ goal: "Deploy to api.acme.com", doneCriteria: "live" });
    expect((await get(task.id)).staleFacts).toBeUndefined();

    const flag = {
      key: "infra.deploy_endpoint",
      oldValue: "api.acme.com",
      newValue: "api2.acme.com",
      factId: "f",
      flaggedAt: 1,
    };
    store.setStaleFacts(task.id, [flag]);
    const res = await get(task.id);
    expect(res.ok).toBe(true);
    expect(res.staleFacts).toEqual([flag]);
    expect(res.task!.lastSeenAt).toBe(task.lastSeenAt);

    store.setStaleFacts(task.id, []);
    expect((await get(task.id)).staleFacts).toBeUndefined();
    expect(store.get(task.id)!.metadata).toBeNull();
  });
});

describe("TaskStore.updateStaleFacts", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-task-stale2-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("applies the mutation to the stored list, so two writers never lose each other's flags", () => {
    const store = getActiveTaskStore()!;
    const task = store.create({ goal: "g", doneCriteria: "d" });
    const stale = store.get(task.id)!; // a reader's snapshot, taken before either write
    const flag = (key: string) => ({
      key,
      oldValue: "v",
      newValue: "w",
      factId: key,
      flaggedAt: 1,
    });
    store.updateStaleFacts(task.id, (cur) => [...cur, flag("a.one")]);
    store.updateStaleFacts(task.id, (cur) => [...cur, flag("b.two")]);
    expect(stale.metadata).toBeNull();
    expect(
      (store.get(task.id)!.metadata!.staleFacts as Array<{ key: string }>).map((f) => f.key),
    ).toEqual(["a.one", "b.two"]);
    // A no-op mutation writes nothing.
    expect(store.updateStaleFacts(task.id, (cur) => cur)).toBeUndefined();
  });
});
