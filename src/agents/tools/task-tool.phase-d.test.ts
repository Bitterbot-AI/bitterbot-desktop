import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { startEventJournal, stopEventJournal } from "../../infra/event-journal.js";
import { registerJudgeLlmCall } from "../../tasks/judge.js";
import { startTaskStore, stopTaskStore } from "../../tasks/store.js";

vi.mock("../../cron/active.js", () => ({
  getCronEngine: () => null,
}));

import {
  createTaskCreateTool,
  createTaskJudgeTool,
  createTaskReadHandoffTool,
  createTaskUpdateTool,
} from "./task-tool.js";

type ToolResult = {
  ok: boolean;
  task?: { id: string; status: string };
  handoff?: { intent: string; pending: string[] };
  verdict?: string;
  reasoning?: string;
  missing?: string[];
  judgeRounds?: number;
  maxRounds?: number;
  nextStatus?: string;
  error?: string;
};

async function callTool(
  tool: ReturnType<typeof createTaskCreateTool>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await tool.execute("tc-d-test", params, {
    signal: new AbortController().signal,
  });
  return result.details as ToolResult;
}

describe("PLAN-16 Phase D: task_judge", () => {
  let dir: string;
  let tasksDb: string;
  let journalDb: string;
  let prevJournalEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-phase-d-"));
    tasksDb = path.join(dir, "tasks.sqlite");
    journalDb = path.join(dir, "journal.sqlite");
    prevJournalEnv = process.env.BITTERBOT_EVENT_JOURNAL;
    process.env.BITTERBOT_EVENT_JOURNAL = "1";
    resetAgentRunContextForTest();
    startTaskStore({ dbPath: tasksDb });
    startEventJournal({ dbPath: journalDb });
  });

  afterEach(() => {
    registerJudgeLlmCall(null);
    stopEventJournal();
    stopTaskStore();
    if (prevJournalEnv === undefined) {
      delete process.env.BITTERBOT_EVENT_JOURNAL;
    } else {
      process.env.BITTERBOT_EVENT_JOURNAL = prevJournalEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns error when no judge LLM is registered", async () => {
    const create = createTaskCreateTool({});
    const judge = createTaskJudgeTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    const r = await callTool(judge, { task_id: tid });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/judge LLM call is not registered/);
  });

  it("pass verdict transitions task to completed", async () => {
    registerJudgeLlmCall(async () => "```yaml\nverdict: pass\nreasoning: all criteria met\n```");
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const judge = createTaskJudgeTool();

    const created = await callTool(create, {
      goal: "ship docs",
      done_criteria: "docs/x.md exists",
    });
    const tid = created.task!.id;
    await callTool(update, {
      task_id: tid,
      status: "judging",
      output: "crystal:docs-x",
    });

    const r = await callTool(judge, { task_id: tid });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("pass");
    expect(r.nextStatus).toBe("completed");
    expect(r.task?.status).toBe("completed");
  });

  it("fail verdict writes a feedback handoff and reverts to running (round 1)", async () => {
    registerJudgeLlmCall(
      async () =>
        "```yaml\nverdict: fail\nreasoning: tests not run\nmissing:\n  - pnpm test\n  - sidebar fix\n```",
    );
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const judge = createTaskJudgeTool();
    const readHandoff = createTaskReadHandoffTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "judging", output: "stub-output" });

    const r = await callTool(judge, { task_id: tid });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.missing).toEqual(["pnpm test", "sidebar fix"]);
    expect(r.nextStatus).toBe("running");
    expect(r.judgeRounds).toBe(1);

    const handoff = await callTool(readHandoff, { task_id: tid });
    expect(handoff.ok).toBe(true);
    expect(handoff.handoff?.intent).toMatch(/Judge fail/);
    expect(handoff.handoff?.pending).toEqual(["pnpm test", "sidebar fix"]);
  });

  it("needs_more verdict reverts to running with feedback", async () => {
    registerJudgeLlmCall(
      async () =>
        "```yaml\nverdict: needs_more\nreasoning: cannot verify the test output reference\nmissing:\n  - attach pnpm test stdout\n```",
    );
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const judge = createTaskJudgeTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "judging", output: "x" });
    const r = await callTool(judge, { task_id: tid });
    expect(r.verdict).toBe("needs_more");
    expect(r.nextStatus).toBe("running");
  });

  it("fail at round cap transitions to terminal 'failed'", async () => {
    registerJudgeLlmCall(async () => "```yaml\nverdict: fail\nreasoning: still incomplete\n```");
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const judge = createTaskJudgeTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "judging", output: "out" });

    // Run with max_rounds=2 so we hit the cap quickly.
    const r1 = await callTool(judge, { task_id: tid, max_rounds: 2 });
    expect(r1.judgeRounds).toBe(1);
    expect(r1.nextStatus).toBe("running");

    await callTool(update, { task_id: tid, status: "judging" });
    const r2 = await callTool(judge, { task_id: tid, max_rounds: 2 });
    expect(r2.judgeRounds).toBe(2);
    expect(r2.nextStatus).toBe("failed");
    expect(r2.task?.status).toBe("failed");
  });

  it("returns parse error when LLM returns garbage", async () => {
    registerJudgeLlmCall(async () => "not yaml at all {{");
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const judge = createTaskJudgeTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "judging", output: "x" });
    const r = await callTool(judge, { task_id: tid });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unparseable/);
  });

  it("refuses to judge terminal tasks", async () => {
    registerJudgeLlmCall(async () => "```yaml\nverdict: pass\nreasoning: ok\n```");
    const create = createTaskCreateTool({});
    const update = createTaskUpdateTool();
    const judge = createTaskJudgeTool();
    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;
    await callTool(update, { task_id: tid, status: "completed", output: "x" });
    const r = await callTool(judge, { task_id: tid });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/terminal/);
  });
});
