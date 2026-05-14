import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { startEventJournal, stopEventJournal } from "../../infra/event-journal.js";
import { startTaskStore, stopTaskStore } from "../../tasks/store.js";
import {
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskMonitorTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskUpdateTool,
} from "./task-tool.js";

type ToolResult = {
  ok: boolean;
  task?: { id: string; status: string; plan?: { steps: Array<{ id: string; status: string }> } };
  tasks?: Array<{ id: string }>;
  error?: string;
  events?: unknown[];
  recentEvents?: unknown[];
  count?: number;
  nextSinceSeq?: number;
  output?: string;
  taskId?: string;
};

async function callTool(
  tool: ReturnType<typeof createTaskCreateTool>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await tool.execute("tc-test", params, { signal: new AbortController().signal });
  return result.details as ToolResult;
}

describe("task_* agent tools", () => {
  let dir: string;
  let tasksDb: string;
  let journalDb: string;
  let prevJournalEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-task-tools-"));
    tasksDb = path.join(dir, "tasks.sqlite");
    journalDb = path.join(dir, "journal.sqlite");
    prevJournalEnv = process.env.BITTERBOT_EVENT_JOURNAL;
    process.env.BITTERBOT_EVENT_JOURNAL = "1";
    resetAgentRunContextForTest();
    startTaskStore({ dbPath: tasksDb });
    startEventJournal({ dbPath: journalDb });
  });

  afterEach(() => {
    stopEventJournal();
    stopTaskStore();
    if (prevJournalEnv === undefined) {
      delete process.env.BITTERBOT_EVENT_JOURNAL;
    } else {
      process.env.BITTERBOT_EVENT_JOURNAL = prevJournalEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("task_create persists a task and emits a creation event", async () => {
    const create = createTaskCreateTool({ agentSessionKey: "sess-1" });
    const monitor = createTaskMonitorTool();

    const created = await callTool(create, {
      goal: "Draft a blog post",
      done_criteria: "post.md exists and lints cleanly",
      plan: [
        { id: "s1", title: "outline" },
        { id: "s2", title: "draft" },
      ],
      source: "user",
    });
    expect(created.ok).toBe(true);
    expect(created.task?.id).toMatch(/^task-/);
    expect(created.task?.status).toBe("pending");
    expect(created.task?.plan?.steps).toHaveLength(2);

    const tid = created.task!.id;
    const monitored = await callTool(monitor, { task_id: tid });
    expect(monitored.ok).toBe(true);
    expect(monitored.count).toBeGreaterThan(0);
  });

  it("task_create rejects missing goal", async () => {
    const create = createTaskCreateTool({});
    const result = await callTool(create, { done_criteria: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/goal/i);
  });

  it("task_create errors when parent_task_id is unknown", async () => {
    const create = createTaskCreateTool({});
    const result = await callTool(create, {
      goal: "child",
      done_criteria: "x",
      parent_task_id: "task-missing",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parent task .* not found/);
  });

  it("task_update step_update advances plan steps", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const created = await callTool(create, {
      goal: "g",
      done_criteria: "d",
      plan: [
        { id: "s1", title: "outline" },
        { id: "s2", title: "draft" },
        { id: "s3", title: "polish" },
      ],
    });
    const tid = created.task!.id;

    const r1 = await callTool(update, {
      task_id: tid,
      step_update: { step_id: "s1", status: "completed", output: "outline-crystal" },
    });
    expect(r1.ok).toBe(true);
    expect(r1.task?.plan?.steps[0].status).toBe("completed");

    const r2 = await callTool(update, {
      task_id: tid,
      step_update: { step_id: "s2", status: "in_progress" },
    });
    expect(r2.ok).toBe(true);
    expect(r2.task?.plan?.steps[1].status).toBe("in_progress");
  });

  it("task_update blocks transitions out of terminal status", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;

    await callTool(update, { task_id: tid, status: "completed", output: "crystal-1" });
    const reattempt = await callTool(update, { task_id: tid, status: "running" });
    expect(reattempt.ok).toBe(false);
    expect(reattempt.error).toMatch(/terminal/);
  });

  it("task_get includes recent events from the journal", async () => {
    const create = createTaskCreateTool({});
    const get = createTaskGetTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;

    const fetched = await callTool(get, { task_id: tid });
    expect(fetched.ok).toBe(true);
    expect(Array.isArray(fetched.recentEvents)).toBe(true);
    expect((fetched.recentEvents ?? []).length).toBeGreaterThan(0);
  });

  it("task_get with include_recent_events:false skips journal lookup", async () => {
    const create = createTaskCreateTool({});
    const get = createTaskGetTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    const fetched = await callTool(get, { task_id: tid, include_recent_events: false });
    expect(fetched.ok).toBe(true);
    expect(fetched.recentEvents).toEqual([]);
  });

  it("task_list filters by status", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const list = createTaskListTool();

    const a = await callTool(create, { goal: "a", done_criteria: "x" });
    const b = await callTool(create, { goal: "b", done_criteria: "x" });
    const c = await callTool(create, { goal: "c", done_criteria: "x" });
    await callTool(update, { task_id: b.task!.id, status: "running" });
    await callTool(update, { task_id: c.task!.id, status: "running" });

    const running = await callTool(list, { status: "running" });
    expect(running.ok).toBe(true);
    expect(running.tasks).toHaveLength(2);

    const pending = await callTool(list, { status: "pending" });
    expect(pending.tasks).toHaveLength(1);
    expect(pending.tasks?.[0].id).toBe(a.task!.id);
  });

  it("task_stop transitions running -> stopped with reason", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const stop = createTaskStopTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "running" });
    const stopped = await callTool(stop, { task_id: tid, reason: "user cancelled" });
    expect(stopped.ok).toBe(true);
    expect(stopped.task?.status).toBe("stopped");

    // Cannot stop a terminal task.
    const retry = await callTool(stop, { task_id: tid, reason: "again" });
    expect(retry.ok).toBe(false);
    expect(retry.error).toMatch(/terminal/);
  });

  it("task_output returns output for completed tasks", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const output = createTaskOutputTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;

    const before = await callTool(output, { task_id: tid });
    expect(before.ok).toBe(false);
    expect(before.error).toMatch(/no output/);

    await callTool(update, {
      task_id: tid,
      status: "completed",
      output: "crystal:abc-123",
    });
    const after = await callTool(output, { task_id: tid });
    expect(after.ok).toBe(true);
    expect(after.output).toBe("crystal:abc-123");
  });

  it("task_monitor sinceSeq cursor advances on subsequent polls", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const monitor = createTaskMonitorTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    // Drive several updates so we have multiple events.
    await callTool(update, { task_id: tid, status: "running" });
    await callTool(update, { task_id: tid, status: "waiting_external" });
    await callTool(update, { task_id: tid, status: "running" });

    const first = await callTool(monitor, { task_id: tid });
    expect(first.ok).toBe(true);
    expect(first.count).toBeGreaterThan(0);
    const cursor = first.nextSinceSeq!;

    // No new events emitted since the cursor; second poll returns 0.
    const second = await callTool(monitor, { task_id: tid, since_seq: cursor });
    expect(second.ok).toBe(true);
    expect(second.count).toBe(0);
    expect(second.nextSinceSeq).toBe(cursor);
  });

  it("returns store-unavailable when no store is active", async () => {
    stopTaskStore();
    const create = createTaskCreateTool({});
    const result = await callTool(create, { goal: "g", done_criteria: "d" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/task store is not active/);
  });
});
