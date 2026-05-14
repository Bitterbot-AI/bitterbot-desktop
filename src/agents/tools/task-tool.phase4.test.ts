import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEventJournal, stopEventJournal } from "../../infra/event-journal.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { startTaskStore, stopTaskStore, getActiveTaskStore } from "../../tasks/store.js";

vi.mock("../../cron/active.js", () => ({
  getCronEngine: () => null,
}));

import {
  createTaskCreateTool,
  createTaskResumeInlineTool,
  createTaskStopTool,
  createTaskUpdateTool,
  createTaskWriteHandoffTool,
} from "./task-tool.js";

type ToolResult = {
  ok: boolean;
  task?: { id: string; status: string; agentSessionKey?: string };
  taskId?: string;
  handoffId?: number | null;
  sessionKey?: string;
  message?: string;
  error?: string;
};

async function callTool(
  tool: ReturnType<typeof createTaskCreateTool>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await tool.execute("tc-p4", params, {
    signal: new AbortController().signal,
  });
  return result.details as ToolResult;
}

describe("PLAN-17 Phase 4: task_resume_inline", () => {
  let dir: string;
  let prevJournal: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-p4-"));
    prevJournal = process.env.BITTERBOT_EVENT_JOURNAL;
    process.env.BITTERBOT_EVENT_JOURNAL = "1";
    resetSystemEventsForTest();
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
    startEventJournal({ dbPath: path.join(dir, "journal.sqlite") });
  });

  afterEach(() => {
    stopEventJournal();
    stopTaskStore();
    resetSystemEventsForTest();
    if (prevJournal === undefined) {
      delete process.env.BITTERBOT_EVENT_JOURNAL;
    } else {
      process.env.BITTERBOT_EVENT_JOURNAL = prevJournal;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enqueues a resume prompt and transitions the task to running", async () => {
    const create = createTaskCreateTool({ agentSessionKey: "owner-sess" });
    const update = createTaskUpdateTool();
    const write = createTaskWriteHandoffTool();
    const resume = createTaskResumeInlineTool({ agentSessionKey: "current-sess" });

    const created = await callTool(create, {
      goal: "research SOTA on context folding",
      done_criteria: "summary crystal exists with citations",
    });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "waiting_external" });
    await callTool(write, {
      task_id: tid,
      intent: "rest cycle, will resume",
      pending: ["draft intro", "fetch arXiv citations"],
    });

    const r = await callTool(resume, {
      task_id: tid,
      reason: "user wants to drive this in chat now",
    });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe(tid);
    expect(r.sessionKey).toBe("current-sess");
    expect(r.handoffId).toBeGreaterThan(0);
    expect(r.message).toMatch(/Resume task/);
    expect(r.message).toMatch(/task_read_handoff/);

    // System event was enqueued into the current session.
    const events = peekSystemEvents("current-sess");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/Resume task/);

    // The owner-sess session received nothing (the message went to current).
    expect(peekSystemEvents("owner-sess")).toHaveLength(0);

    // Task is now running and rebound to current-sess.
    const store = getActiveTaskStore()!;
    const after = store.get(tid)!;
    expect(after.status).toBe("running");
    expect(after.agentSessionKey).toBe("current-sess");
  });

  it("errors when the task doesn't exist", async () => {
    const resume = createTaskResumeInlineTool({ agentSessionKey: "sess" });
    const r = await callTool(resume, { task_id: "task-missing" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it("refuses terminal tasks", async () => {
    const create = createTaskCreateTool({ agentSessionKey: "owner" });
    const update = createTaskUpdateTool();
    const stop = createTaskStopTool();
    const resume = createTaskResumeInlineTool({ agentSessionKey: "current" });

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "running" });
    await callTool(stop, { task_id: tid, reason: "user cancel" });

    const r = await callTool(resume, { task_id: tid });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/terminal/);
  });

  it("requires an agentSessionKey at the factory", async () => {
    const create = createTaskCreateTool({ agentSessionKey: "owner" });
    const resume = createTaskResumeInlineTool({}); // no session key
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    const r = await callTool(resume, { task_id: tid });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no agentSessionKey/);
  });
});
