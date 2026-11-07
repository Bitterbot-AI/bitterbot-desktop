import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgentRunContext, clearAgentRunContext } from "../../infra/agent-events.js";
import { createExecutionTrackingHook } from "../../memory/execution-tracking-hook.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { SkillExecutionTracker } from "../../memory/skill-execution-tracker.js";
import { runTaskChecks, taskChecksHash } from "../../tasks/checks.js";
import { TaskStore, startTaskStore, stopTaskStore } from "../../tasks/store.js";
import { createReadTool } from "../runtime/tools/coding/read.js";
import type { AnyAgentTool } from "../tools/common.js";
import { wrapToolsWithResultSpill } from "../tools/tool-result-spill.js";
import {
  captureSkillReadContext,
  isSkillReadPath,
  type SkillReadProof,
} from "./skill-read-provenance.js";

describe("skill read and check provenance producers", () => {
  let dir: string, skill: string;
  const original =
    "---\nname: actual-name\ndescription: Produce a report\n---\nOriginal instructions\n";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-proof-"));
    skill = path.join(dir, "folder-name", "SKILL.md");
    await fs.mkdir(path.dirname(skill));
    await fs.writeFile(skill, original);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const context = { runId: "run-1", sessionKey: "agent:main:main", senderIsOwner: true };

  it("recognizes Windows and relative skill paths", () => {
    expect(
      isSkillReadPath(["C:", "skills", "name", "SKILL.md"].join(String.fromCharCode(92))),
    ).toBe(true);
    expect(isSkillReadPath("SKILL.md")).toBe(true);
    expect(isSkillReadPath("/skills/name/README.md")).toBe(false);
  });
  it("hashes the bytes read, preserves frontmatter name, persists through the execution hook", async () => {
    const tool = createReadTool(dir, { skillReadContext: () => context });
    const result = await tool.execute("call-1", { path: skill });
    await fs.writeFile(skill, original + "Changed later");
    const proof = result.details!.skillRead!;
    expect(proof).toMatchObject({
      complete: true,
      name: "actual-name",
      hash: createHash("sha256").update(original).digest("hex"),
      context,
    });
    expect(proof.hash).not.toBe(
      createHash("sha256")
        .update(await fs.readFile(skill))
        .digest("hex"),
    );
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        ftsTable: "chunks_fts",
        ftsEnabled: false,
      });
      db.prepare(`INSERT INTO chunks (id,path,source,start_line,end_line,text,hash,model,embedding,updated_at,created_at,lifecycle,semantic_type,skill_category)
        VALUES ('s',?,'skills',0,0,'body','hash','model','[]',1,1,'frozen','skill','folder-name')`).run(
        path.dirname(skill),
      );
      const hook = createExecutionTrackingHook(new SkillExecutionTracker(db), db);
      hook(
        { toolName: "read", params: { path: skill }, result },
        { ...context, toolName: "read", toolCallId: "call-1" },
      );
      const row = db.prepare("SELECT context_json FROM skill_executions").get() as {
        context_json: string;
      };
      expect(JSON.parse(row.context_json).skillRead).toEqual(proof);
    } finally {
      db.close();
    }
  });
  it("captures task context before file operations and excludes offset/limit/spilled reads", async () => {
    let revision = 0;
    const tool = createReadTool(dir, {
      skillReadContext: () => ({
        ...context,
        task: { id: "t", hash: "frozen", revision, updatedAt: 0, author: "model" },
      }),
      operations: {
        access: async () => {
          revision++;
        },
        readFile: async () => Buffer.from(original),
      },
    });
    expect(
      (await tool.execute("a", { path: skill })).details?.skillRead?.context?.task?.revision,
    ).toBe(0);
    expect((await tool.execute("b", { path: skill, offset: 2 })).details?.skillRead?.complete).toBe(
      false,
    );
    expect((await tool.execute("c", { path: skill, limit: 1 })).details?.skillRead?.complete).toBe(
      false,
    );
    await fs.writeFile(skill, original + "long ".repeat(4000));
    const [spilled] = wrapToolsWithResultSpill(
      [createReadTool(dir, { skillReadContext: () => context }) as unknown as AnyAgentTool],
      { maxChars: 8000, dir: path.join(dir, "spill"), runId: "r" },
    );
    const result = await spilled.execute("d", { path: skill });
    expect((result.details as { skillRead: SkillReadProof }).skillRead.complete).toBe(false);
  });
  it("captures the actual task creation time as the earliest freeze boundary", () => {
    const store = startTaskStore({ dbPath: path.join(dir, "active-tasks.sqlite") });
    try {
      const task = store.create({
        goal: "report",
        doneCriteria: "exists",
        checks: [{ kind: "file_exists", path: "report.md" }],
      });
      store.update(task.id, { currentRunId: context.runId });
      registerAgentRunContext(context.runId, { taskId: task.id, sessionKey: context.sessionKey });
      expect(captureSkillReadContext(context)?.task).toMatchObject({
        id: task.id,
        revision: 0,
        updatedAt: task.createdAt,
        author: "model",
        hash: taskChecksHash(task.checks),
      });
    } finally {
      clearAgentRunContext(context.runId);
      stopTaskStore();
    }
  });

  it("versions every check update, including identical writes and change-then-restore, across restart", () => {
    const file = path.join(dir, "tasks.sqlite");
    let store = TaskStore.open(file);
    const checks = [{ kind: "file_exists" as const, path: "report.md" }];
    const t = store.create({ goal: "report", doneCriteria: "exists", checks });
    expect(t.checksRevision).toBe(0);
    store.update(t.id, { currentRunId: "run-1" });
    store.update(t.id, { checks: [] });
    store.update(t.id, { checks });
    const updated = store.update(t.id, { checks });
    expect(updated.checksRevision).toBe(3);
    expect(taskChecksHash(updated.checks)).toBe(taskChecksHash(checks));
    store.close();
    store = TaskStore.open(file);
    expect(store.get(t.id)?.checksRevision).toBe(3);
    store.close();
  });
  it("marks real pass/fail separately from disabled, timeout, missing workspace, and spawn failure", async () => {
    const results = await runTaskChecks(
      [
        { kind: "file_exists", path: "folder-name/SKILL.md" },
        { kind: "file_exists", path: "absent" },
        { kind: "command", command: "exit 1" },
      ],
      { workspaceDir: dir, output: null, allowCommands: false },
    );
    expect(results.map((r) => [r.passed, r.executed])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
    const command = await runTaskChecks(
      [
        { kind: "command", command: "exit 1" },
        { kind: "command", command: "bitterbot_intentionally_missing_command" },
      ],
      { workspaceDir: dir, output: null, allowCommands: true },
    );
    expect(command.map((r) => r.executed)).toEqual([process.platform !== "win32", false]);
    if (process.platform !== "win32") {
      const timeout = await runTaskChecks([{ kind: "command", command: "sleep 1" }], {
        workspaceDir: dir,
        output: null,
        allowCommands: true,
        timeoutMs: 20,
      });
      expect(timeout[0].executed).toBe(false);
    }
    const missing = await runTaskChecks(
      [
        { kind: "file_exists", path: "absent" },
        { kind: "command", command: "true" },
      ],
      { workspaceDir: path.join(dir, "missing-workspace"), output: null, allowCommands: true },
    );
    expect(missing.map((r) => r.executed)).toEqual([false, false]);
  });
});
