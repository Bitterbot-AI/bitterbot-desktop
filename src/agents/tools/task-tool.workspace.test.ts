/**
 * Tests for the per-task machine-readable workspace (durable state that
 * survives handoffs/wakeups) — TaskStore.getWorkspace/mergeWorkspace and the
 * task_workspace_get / task_workspace_merge tools.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { startEventJournal, stopEventJournal } from "../../infra/event-journal.js";
import { startTaskStore, stopTaskStore, TaskStore, getActiveTaskStore } from "../../tasks/store.js";
import {
  createTaskCreateTool,
  createTaskReadHandoffTool,
  createTaskWorkspaceGetTool,
  createTaskWorkspaceMergeTool,
  createTaskWriteHandoffTool,
} from "./task-tool.js";

type ToolResult = {
  ok: boolean;
  task?: { id: string };
  workspace?: Record<string, unknown>;
  handoff?: { id: number };
  error?: string;
};

async function callTool(
  tool: ReturnType<typeof createTaskCreateTool>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await tool.execute("tc-test-ws", params, {
    signal: new AbortController().signal,
  });
  return result.details as ToolResult;
}

describe("per-task workspace", () => {
  let dir: string;
  let prevJournalEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-workspace-"));
    prevJournalEnv = process.env.BITTERBOT_EVENT_JOURNAL;
    process.env.BITTERBOT_EVENT_JOURNAL = "1";
    resetAgentRunContextForTest();
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
    startEventJournal({ dbPath: path.join(dir, "journal.sqlite") });
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

  it("store merge semantics: set, overwrite, delete via null, other metadata preserved", () => {
    const store = getActiveTaskStore()!;
    const task = store.create({ goal: "g", doneCriteria: "d", source: "user" });
    store.update(task.id, { metadata: { topic: "research" } });

    store.mergeWorkspace(task.id, { cursor: 5, files: ["a.ts"] });
    store.mergeWorkspace(task.id, { cursor: 9, extra: { nested: true } });
    expect(store.getWorkspace(task.id)).toEqual({
      cursor: 9,
      files: ["a.ts"],
      extra: { nested: true },
    });

    store.mergeWorkspace(task.id, { files: null });
    expect(store.getWorkspace(task.id)).toEqual({ cursor: 9, extra: { nested: true } });

    // Pre-existing metadata keys survive workspace merges
    expect(store.get(task.id)!.metadata).toMatchObject({ topic: "research" });
  });

  it("store rejects prototype-polluting keys", () => {
    const store = getActiveTaskStore()!;
    const task = store.create({ goal: "g", doneCriteria: "d", source: "user" });
    const patch = JSON.parse('{"__proto__": {"admin": true}}') as Record<string, unknown>;
    expect(() => store.mergeWorkspace(task.id, patch)).toThrow(/not allowed/);
    expect(store.getWorkspace(task.id)).toEqual({});
  });

  it("store enforces the workspace size cap", () => {
    const store = getActiveTaskStore()!;
    const task = store.create({ goal: "g", doneCriteria: "d", source: "user" });
    const huge = "x".repeat(TaskStore.WORKSPACE_MAX_BYTES + 1);
    expect(() => store.mergeWorkspace(task.id, { blob: huge })).toThrow(/exceed/);
    expect(store.getWorkspace(task.id)).toEqual({});
  });

  it("tools round-trip workspace state and surface it on task_read_handoff", async () => {
    const create = createTaskCreateTool({});
    const merge = createTaskWorkspaceMergeTool();
    const get = createTaskWorkspaceGetTool();
    const writeHandoff = createTaskWriteHandoffTool();
    const readHandoff = createTaskReadHandoffTool();

    const created = await callTool(create, { goal: "g", done_criteria: "d" });
    const tid = created.task!.id;

    const merged = await callTool(merge, {
      task_id: tid,
      entries: { parsedRows: 42, artifactPath: "out/report.md" },
    });
    expect(merged.ok).toBe(true);
    expect(merged.workspace).toEqual({ parsedRows: 42, artifactPath: "out/report.md" });

    const got = await callTool(get, { task_id: tid });
    expect(got.ok).toBe(true);
    expect(got.workspace).toEqual({ parsedRows: 42, artifactPath: "out/report.md" });

    await callTool(writeHandoff, { task_id: tid, intent: "suspending for the night" });
    const read = await callTool(readHandoff, { task_id: tid });
    expect(read.ok).toBe(true);
    expect(read.workspace).toEqual({ parsedRows: 42, artifactPath: "out/report.md" });
  });

  it("tools report errors for unknown tasks and bad entries", async () => {
    const merge = createTaskWorkspaceMergeTool();
    const get = createTaskWorkspaceGetTool();

    const missing = await callTool(get, { task_id: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/);

    const bad = await callTool(merge, { task_id: "nope", entries: { a: 1 } });
    expect(bad.ok).toBe(false);
  });
});
