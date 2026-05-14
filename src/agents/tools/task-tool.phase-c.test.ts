import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronPayloadAgentTurn } from "../../cron/types.js";
import { resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { startEventJournal, stopEventJournal } from "../../infra/event-journal.js";
import { startTaskStore, stopTaskStore } from "../../tasks/store.js";

// Stub the cron runtime so we don't pull the full cron-engine import chain
// (which transitively touches Slack and fails to resolve `axios` under vitest).
// The Phase C schedule_wakeup tool only calls `getCronEngine().upsertJob(job)`
// and `listJobs()`, so a tiny fake is enough.
const fakeJobs: CronJob[] = [];
const fakeCron = {
  upsertJob: vi.fn(async (job: CronJob): Promise<CronJob> => {
    fakeJobs.push({ ...job });
    return { ...job };
  }),
  listJobs: vi.fn((): CronJob[] => fakeJobs.map((j) => ({ ...j }))),
};

vi.mock("../../cron/active.js", () => ({
  getCronEngine: () => fakeCron,
}));

import {
  createTaskCreateTool,
  createTaskReadHandoffTool,
  createTaskScheduleWakeupTool,
  createTaskStopTool,
  createTaskUpdateTool,
  createTaskWriteHandoffTool,
} from "./task-tool.js";

type ToolResult = {
  ok: boolean;
  task?: { id: string; status: string; wakeupCount?: number };
  handoff?: { id: number; intent: string; decisions: string[]; pending: string[] };
  handoffs?: Array<{ id: number; intent: string }>;
  count?: number;
  taskId?: string;
  jobId?: string;
  atIso?: string;
  atMs?: number;
  handoffId?: number;
  wakeupCount?: number;
  wakeupCap?: number;
  error?: string;
};

async function callTool(
  tool: ReturnType<typeof createTaskCreateTool>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await tool.execute("tc-test-c", params, { signal: new AbortController().signal });
  return result.details as ToolResult;
}

describe("PLAN-16 Phase C: handoffs + schedule wakeup", () => {
  let dir: string;
  let tasksDb: string;
  let journalDb: string;
  let prevJournalEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-phase-c-"));
    tasksDb = path.join(dir, "tasks.sqlite");
    journalDb = path.join(dir, "journal.sqlite");
    prevJournalEnv = process.env.BITTERBOT_EVENT_JOURNAL;
    process.env.BITTERBOT_EVENT_JOURNAL = "1";
    fakeJobs.length = 0;
    fakeCron.upsertJob.mockClear();
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

  it("task_write_handoff persists a structured handoff record", async () => {
    const create = createTaskCreateTool({});
    const write = createTaskWriteHandoffTool();
    const read = createTaskReadHandoffTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;

    const handoff = await callTool(write, {
      task_id: tid,
      intent: "context approaching 70%, suspending",
      decisions: ["chose ACON over context-folding", "skipped Phase D for now"],
      pending: ["finalize phase C tests", "write docs"],
      context: "see crystal:abc-123 for citations",
      context_tokens: 145_000,
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.handoff?.intent).toMatch(/70%/);
    expect(handoff.handoff?.decisions).toHaveLength(2);
    expect(handoff.handoff?.pending).toHaveLength(2);

    const readResult = await callTool(read, { task_id: tid });
    expect(readResult.ok).toBe(true);
    expect(readResult.handoff?.id).toBe(handoff.handoff!.id);
  });

  it("task_read_handoff list mode returns history newest-first", async () => {
    const create = createTaskCreateTool({});
    const write = createTaskWriteHandoffTool();
    const read = createTaskReadHandoffTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;

    await callTool(write, { task_id: tid, intent: "first suspend" });
    await callTool(write, { task_id: tid, intent: "second suspend" });
    await callTool(write, { task_id: tid, intent: "third suspend" });

    const list = await callTool(read, { task_id: tid, list: true });
    expect(list.ok).toBe(true);
    expect(list.count).toBe(3);
    expect(list.handoffs?.[0].intent).toBe("third suspend");
    expect(list.handoffs?.[2].intent).toBe("first suspend");
  });

  it("task_read_handoff errors when no handoffs exist", async () => {
    const create = createTaskCreateTool({});
    const read = createTaskReadHandoffTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    const r = await callTool(read, { task_id: tid });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no handoff/);
  });

  it("task_schedule_wakeup creates a cron job pointing at the task", async () => {
    const create = createTaskCreateTool({});
    const write = createTaskWriteHandoffTool();
    const schedule = createTaskScheduleWakeupTool();

    const created = await callTool(create, { goal: "deep research", done_criteria: "d" });
    const tid = created.task!.id;
    const handoff = await callTool(write, {
      task_id: tid,
      intent: "suspend at rest boundary",
    });

    const sched = await callTool(schedule, {
      task_id: tid,
      delay_seconds: 60,
      reason: "approaching context budget",
    });
    expect(sched.ok).toBe(true);
    expect(sched.jobId).toMatch(/^task-wakeup-/);
    expect(sched.handoffId).toBe(handoff.handoff!.id);
    expect(sched.wakeupCount).toBe(1);

    expect(fakeCron.upsertJob).toHaveBeenCalledTimes(1);
    const job = fakeJobs[0];
    expect(job.enabled).toBe(true);
    expect(job.schedule.kind).toBe("at");
    expect(job.payload.kind).toBe("agentTurn");
    const payload = job.payload as CronPayloadAgentTurn;
    expect(payload.taskId).toBe(tid);
    expect(payload.handoffId).toBe(handoff.handoff!.id);
    expect(payload.message).toMatch(/Resume task/);
    expect(payload.message).toMatch(/task_read_handoff/);
    expect(job.deleteAfterRun).toBe(true);
    expect(job.delivery?.mode).toBe("none");
  });

  it("task_schedule_wakeup transitions the task to waiting_external", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const schedule = createTaskScheduleWakeupTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "running" });

    const sched = await callTool(schedule, {
      task_id: tid,
      delay_seconds: 30,
      reason: "rest period",
    });
    expect(sched.ok).toBe(true);

    const fetched = await callTool(update, { task_id: tid });
    expect(fetched.task?.status).toBe("waiting_external");
  });

  it("task_schedule_wakeup rejects when delay_seconds and at_iso are both set", async () => {
    const create = createTaskCreateTool({});
    const schedule = createTaskScheduleWakeupTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    const r = await callTool(schedule, {
      task_id: tid,
      delay_seconds: 60,
      at_iso: new Date(Date.now() + 60_000).toISOString(),
      reason: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/either delay_seconds or at_iso/);
  });

  it("task_schedule_wakeup rejects past at_iso", async () => {
    const create = createTaskCreateTool({});
    const schedule = createTaskScheduleWakeupTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    const r = await callTool(schedule, {
      task_id: tid,
      at_iso: new Date(Date.now() - 60_000).toISOString(),
      reason: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must be in the future/);
  });

  it("task_schedule_wakeup refuses terminal tasks", async () => {
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const stop = createTaskStopTool();
    const schedule = createTaskScheduleWakeupTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "running" });
    await callTool(stop, { task_id: tid, reason: "manual cancel" });
    const r = await callTool(schedule, {
      task_id: tid,
      delay_seconds: 60,
      reason: "should fail",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/terminal/);
  });

  it("task_schedule_wakeup enforces the wakeup cap", async () => {
    const prev = process.env.BITTERBOT_TASKS_MAX_WAKEUPS;
    process.env.BITTERBOT_TASKS_MAX_WAKEUPS = "2";
    try {
      const create = createTaskCreateTool({});
      const schedule = createTaskScheduleWakeupTool();
      const created = await callTool(create, { goal: "g", done_criteria: "d" });
      const tid = created.task!.id;

      const r1 = await callTool(schedule, {
        task_id: tid,
        delay_seconds: 60,
        reason: "first",
      });
      expect(r1.ok).toBe(true);
      const r2 = await callTool(schedule, {
        task_id: tid,
        delay_seconds: 60,
        reason: "second",
      });
      expect(r2.ok).toBe(true);
      const r3 = await callTool(schedule, {
        task_id: tid,
        delay_seconds: 60,
        reason: "third",
      });
      expect(r3.ok).toBe(false);
      expect(r3.error).toMatch(/wakeup cap/);
    } finally {
      if (prev === undefined) {
        delete process.env.BITTERBOT_TASKS_MAX_WAKEUPS;
      } else {
        process.env.BITTERBOT_TASKS_MAX_WAKEUPS = prev;
      }
    }
  });
});
