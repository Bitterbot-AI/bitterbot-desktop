import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeTaskCheck,
  getTaskCheckContext,
  isTaskCheckCommandsEnabled,
  parseTaskChecks,
  registerTaskCheckContext,
  runTaskChecks,
} from "./checks.js";

describe("parseTaskChecks", () => {
  it("accepts every kind with the required fields", () => {
    const parsed = parseTaskChecks([
      { kind: "file_exists", path: "out/report.md" },
      { kind: "file_contains", path: "out/report.md", value: "## Summary" },
      { kind: "file_regex", path: "out/report.md", pattern: "^# .+" },
      { kind: "output_regex", pattern: "crystal:" },
      { kind: "command", command: "true", expectExitCode: 0, stdoutRegex: "^$" },
    ]);
    expect(parsed).toHaveLength(5);
    expect(parsed[4]).toEqual({
      kind: "command",
      command: "true",
      expectExitCode: 0,
      stdoutRegex: "^$",
    });
  });

  it("rejects malformed checks with a precise reason instead of coercing", () => {
    expect(() => parseTaskChecks("nope")).toThrow(/array/);
    expect(() => parseTaskChecks([{ kind: "teleport" }])).toThrow(/kind must be one of/);
    expect(() => parseTaskChecks([{ kind: "file_contains", path: "a" }])).toThrow(/value/);
    expect(() => parseTaskChecks([{ kind: "output_regex", pattern: "(" }])).toThrow(
      /invalid regex/,
    );
    expect(() =>
      parseTaskChecks([{ kind: "command", command: "ls", expectExitCode: "0" }]),
    ).toThrow(/integer/);
    expect(() =>
      parseTaskChecks(Array.from({ length: 21 }, () => ({ kind: "output_regex", pattern: "x" }))),
    ).toThrow(/at most/);
  });
});

describe("runTaskChecks", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "task-checks-"));
    fs.mkdirSync(path.join(ws, "out"));
    fs.writeFileSync(path.join(ws, "out", "report.md"), "# Report\n\n## Summary\nall good\n");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("executes file and output checks deterministically", async () => {
    const results = await runTaskChecks(
      parseTaskChecks([
        { kind: "file_exists", path: "out/report.md" },
        { kind: "file_exists", path: "out/missing.md" },
        { kind: "file_contains", path: "out/report.md", value: "## Summary" },
        { kind: "file_contains", path: "out/report.md", value: "## Appendix" },
        { kind: "file_regex", path: "out/report.md", pattern: "^# Report$" },
        { kind: "output_regex", pattern: "^crystal:" },
      ]),
      { workspaceDir: ws, output: "crystal:abc", allowCommands: false },
    );
    expect(results.map((r) => r.passed)).toEqual([true, false, true, false, true, true]);
    expect(results[1]?.detail).toBe("missing");
    expect(results[3]?.detail).toMatch(/not found/);
    expect(results.every((r) => r.description === describeTaskCheck(r.check))).toBe(true);
  });

  it("confines paths to the workspace and never reads outside it", async () => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`);
    fs.writeFileSync(outside, "secret");
    try {
      const results = await runTaskChecks(
        parseTaskChecks([
          { kind: "file_exists", path: outside },
          { kind: "file_contains", path: "../../etc/passwd", value: "root" },
        ]),
        { workspaceDir: ws, output: null, allowCommands: false },
      );
      expect(results.map((r) => r.passed)).toEqual([false, false]);
      expect(results[0]?.detail).toMatch(/escapes the workspace/);
      expect(results[1]?.detail).toMatch(/escapes the workspace/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("fails path checks loudly when no workspace is registered", async () => {
    const results = await runTaskChecks(parseTaskChecks([{ kind: "file_exists", path: "x" }]), {
      workspaceDir: null,
      output: null,
      allowCommands: false,
    });
    expect(results[0]).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/no workspace/),
    });
  });

  it("output_regex fails when the task has no output (an absent artifact is not a pass)", async () => {
    const results = await runTaskChecks(
      parseTaskChecks([{ kind: "output_regex", pattern: ".*" }]),
      { workspaceDir: ws, output: null, allowCommands: false },
    );
    expect(results[0]?.passed).toBe(false);
  });

  it("command checks fail with the opt-in reason when commands are disabled", async () => {
    const results = await runTaskChecks(parseTaskChecks([{ kind: "command", command: "true" }]), {
      workspaceDir: ws,
      output: null,
      allowCommands: false,
    });
    expect(results[0]).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/BITTERBOT_TASKS_CHECK_COMMANDS/),
    });
  });

  // POSIX commands (cat, exit, pwd, sleep); the Windows CI leg runs cmd.exe.
  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly(
    "command checks run in the workspace with exit code and stdout assertions when enabled",
    async () => {
      const results = await runTaskChecks(
        parseTaskChecks([
          { kind: "command", command: "cat out/report.md", stdoutRegex: "## Summary" },
          { kind: "command", command: "exit 3", expectExitCode: 3 },
          { kind: "command", command: "exit 1" },
          { kind: "command", command: "pwd", stdoutRegex: "task-checks-" },
        ]),
        { workspaceDir: ws, output: null, allowCommands: true, timeoutMs: 30_000 },
      );
      expect(results.map((r) => r.passed)).toEqual([true, true, false, true]);
      expect(results[2]?.detail).toMatch(/exit 1 \(expected 0\)/);
    },
  );

  posixOnly("times out a hung command instead of hanging the judge", async () => {
    const results = await runTaskChecks(
      parseTaskChecks([{ kind: "command", command: "sleep 5" }]),
      { workspaceDir: ws, output: null, allowCommands: true, timeoutMs: 200 },
    );
    expect(results[0]).toMatchObject({ passed: false, detail: "command timed out" });
  });
});

describe("task check registry", () => {
  it("defaults commands off and reads the operator opt-in from the environment", () => {
    expect(isTaskCheckCommandsEnabled({})).toBe(false);
    expect(isTaskCheckCommandsEnabled({ BITTERBOT_TASKS_CHECK_COMMANDS: "1" })).toBe(true);
    registerTaskCheckContext({ workspaceDir: "/tmp/ws", allowCommands: false });
    expect(getTaskCheckContext()).toEqual({ workspaceDir: "/tmp/ws", allowCommands: false });
  });
});
