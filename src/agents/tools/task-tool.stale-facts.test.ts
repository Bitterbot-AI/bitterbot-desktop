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
