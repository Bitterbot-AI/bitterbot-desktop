import { describe, expect, it, vi } from "vitest";
import type { Task, TaskHandoff } from "./types.js";
import {
  buildTaskJudgePrompt,
  parseTaskJudgeResponse,
  runTaskJudge,
  type TaskJudgeInput,
} from "./judge.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-test",
    goal: "Refactor cron docs to match new schedule API",
    doneCriteria: "docs/automation/cron.md updated AND no broken links AND pnpm test passes",
    status: "judging",
    parentTaskId: null,
    plan: {
      steps: [
        { id: "s1", title: "audit current docs", status: "completed" },
        { id: "s2", title: "draft updates", status: "completed" },
        { id: "s3", title: "verify links + tests", status: "completed" },
      ],
    },
    checkpoint: null,
    currentRunId: null,
    output: "crystal:docs-cron-v2",
    source: "user",
    bounty: null,
    agentSessionKey: null,
    wakeupCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastSeenAt: now,
    metadata: null,
    ...overrides,
  };
}

function makeHandoff(overrides: Partial<TaskHandoff> = {}): TaskHandoff {
  return {
    id: 1,
    taskId: "task-test",
    runId: null,
    intent: "suspended for rest",
    decisions: ["chose Markdown not MDX"],
    pending: ["regenerate sidebar"],
    context: null,
    contextTokens: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("buildTaskJudgePrompt", () => {
  it("includes goal, done criteria, plan, and output", () => {
    const task = makeTask();
    const prompt = buildTaskJudgePrompt({ task, output: task.output });
    expect(prompt).toContain("Goal");
    expect(prompt).toContain(task.goal);
    expect(prompt).toContain(task.doneCriteria);
    expect(prompt).toContain("audit current docs");
    expect(prompt).toContain("crystal:docs-cron-v2");
  });

  it("notes 'no plan recorded' when plan is absent", () => {
    const task = makeTask({ plan: null });
    const prompt = buildTaskJudgePrompt({ task, output: null });
    expect(prompt).toContain("(no plan recorded)");
  });

  it("notes 'no output recorded' when output is null", () => {
    const task = makeTask({ output: null });
    const prompt = buildTaskJudgePrompt({ task, output: null });
    expect(prompt).toContain("(no output recorded)");
  });

  it("includes the handoff block when provided", () => {
    const task = makeTask();
    const prompt = buildTaskJudgePrompt({
      task,
      output: task.output,
      latestHandoff: makeHandoff(),
    });
    expect(prompt).toContain("Intent: suspended for rest");
    expect(prompt).toContain("chose Markdown not MDX");
    expect(prompt).toContain("regenerate sidebar");
  });

  it("truncates pathological output to ~3k chars", () => {
    const task = makeTask({ output: "x".repeat(50_000) });
    const prompt = buildTaskJudgePrompt({ task, output: task.output });
    expect(prompt.length).toBeLessThan(10_000);
    expect(prompt).toContain("…");
  });
});

describe("parseTaskJudgeResponse", () => {
  it("parses a pass decision", () => {
    const raw = "```yaml\nverdict: pass\nreasoning: docs updated, links checked, tests green\n```";
    const decision = parseTaskJudgeResponse(raw);
    expect(decision?.verdict).toBe("pass");
    expect(decision?.reasoning).toMatch(/links checked/);
  });

  it("parses a fail decision with missing list", () => {
    const raw =
      "```yaml\nverdict: fail\nreasoning: tests not run\nmissing:\n  - pnpm test was never invoked\n  - sidebar.json still references removed page\n```";
    const decision = parseTaskJudgeResponse(raw);
    expect(decision?.verdict).toBe("fail");
    expect(decision?.missing).toEqual([
      "pnpm test was never invoked",
      "sidebar.json still references removed page",
    ]);
  });

  it("parses needs_more verdict", () => {
    const raw =
      "```yaml\nverdict: needs_more\nreasoning: cannot verify test result\nmissing:\n  - link to pnpm test output\n```";
    const decision = parseTaskJudgeResponse(raw);
    expect(decision?.verdict).toBe("needs_more");
    expect(decision?.missing).toEqual(["link to pnpm test output"]);
  });

  it("accepts plain YAML without a fence", () => {
    const raw = "verdict: pass\nreasoning: ok";
    const decision = parseTaskJudgeResponse(raw);
    expect(decision?.verdict).toBe("pass");
  });

  it("rejects malformed YAML", () => {
    expect(parseTaskJudgeResponse("not yaml at all {{{")).toBeNull();
  });

  it("rejects unknown verdicts", () => {
    const raw = "```yaml\nverdict: maybe\nreasoning: not sure\n```";
    expect(parseTaskJudgeResponse(raw)).toBeNull();
  });

  it("returns empty reasoning placeholder when reasoning is missing", () => {
    const raw = "```yaml\nverdict: pass\n```";
    const decision = parseTaskJudgeResponse(raw);
    expect(decision?.verdict).toBe("pass");
    expect(decision?.reasoning).toBe("(no reasoning)");
  });

  it("ignores non-string entries in the missing array", () => {
    const raw =
      "```yaml\nverdict: fail\nreasoning: x\nmissing:\n  - real gap\n  - 123\n  - ''\n```";
    const decision = parseTaskJudgeResponse(raw);
    expect(decision?.missing).toEqual(["real gap"]);
  });
});

describe("runTaskJudge", () => {
  it("invokes llmCall with the built prompt and returns parsed verdict", async () => {
    const task = makeTask();
    const input: TaskJudgeInput = { task, output: task.output };
    const stub = vi.fn(
      async (_prompt: string) => "```yaml\nverdict: pass\nreasoning: looks complete\n```",
    );
    const decision = await runTaskJudge(input, stub);
    expect(decision?.verdict).toBe("pass");
    expect(stub).toHaveBeenCalledOnce();
    const sentPrompt = stub.mock.calls[0][0];
    expect(sentPrompt).toContain(task.goal);
  });

  it("returns null when llmCall throws", async () => {
    const task = makeTask();
    const input: TaskJudgeInput = { task, output: null };
    const decision = await runTaskJudge(input, async () => {
      throw new Error("provider down");
    });
    expect(decision).toBeNull();
  });

  it("returns null when llmCall returns unparseable text", async () => {
    const task = makeTask();
    const input: TaskJudgeInput = { task, output: null };
    const decision = await runTaskJudge(input, async () => "garbage");
    expect(decision).toBeNull();
  });
});
