/**
 * Deterministic task acceptance checks (2026-09-05 harness review, B4).
 *
 * `done_criteria` is free text the LLM judge reads. That is level-2
 * evidence at best: an opinion about a worker-authored summary. A check is
 * something the harness can EXECUTE against the workspace or the recorded
 * output and score 0/1 without a model — level-3 evidence. The judge sees
 * the check results; a failed check fails the task before any LLM call.
 *
 * Boundaries:
 * - Path checks are confined to the registered workspace directory. A path
 *   that escapes it (absolute elsewhere, `..`) fails the check with the
 *   reason recorded; it never reads outside the workspace.
 * - `command` checks execute a model-authored shell line, which would bypass
 *   the exec approval policy. They run only when the operator opts in with
 *   `BITTERBOT_TASKS_CHECK_COMMANDS=1`, in the workspace, with a scrubbed
 *   environment and a hard timeout. Otherwise they FAIL loudly with that
 *   reason, so a task cannot be verified by a check nobody ran.
 * - No check ever throws: an unrunnable check is a failed check with detail.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { TaskCheck, TaskCheckResult } from "./types.js";

export const MAX_CHECKS_PER_TASK = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT = 64 * 1024;

export type TaskCheckContext = {
  /** Workspace root for path and command checks; null = no workspace registered. */
  workspaceDir: string | null;
  /** The task's recorded output reference (for `output_regex`). */
  output: string | null;
  /** Operator opt-in for `command` checks. */
  allowCommands: boolean;
  timeoutMs?: number;
};

const CHECK_KINDS = new Set([
  "file_exists",
  "file_contains",
  "file_regex",
  "output_regex",
  "command",
]);

/**
 * Validate a raw `checks` array (tool params / RPC payloads). Throws with a
 * precise message so the model can correct the shape; never coerces.
 */
export function parseTaskChecks(raw: unknown): TaskCheck[] {
  if (!Array.isArray(raw)) {
    throw new Error("checks must be an array");
  }
  if (raw.length > MAX_CHECKS_PER_TASK) {
    throw new Error(`checks: at most ${MAX_CHECKS_PER_TASK} per task`);
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`checks[${i}] must be an object`);
    }
    const c = entry as Record<string, unknown>;
    const kind = typeof c.kind === "string" ? c.kind : "";
    if (!CHECK_KINDS.has(kind)) {
      throw new Error(`checks[${i}].kind must be one of ${[...CHECK_KINDS].join(", ")}`);
    }
    const str = (key: string): string => {
      const v = c[key];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error(`checks[${i}].${key} must be a non-empty string for kind ${kind}`);
      }
      return v;
    };
    switch (kind) {
      case "file_exists":
        return { kind, path: str("path") };
      case "file_contains":
        return { kind, path: str("path"), value: str("value") };
      case "file_regex":
        return { kind, path: str("path"), pattern: compileOrThrow(str("pattern"), i) };
      case "output_regex":
        return { kind, pattern: compileOrThrow(str("pattern"), i) };
      case "command": {
        const out: TaskCheck = { kind, command: str("command") };
        if (c.expectExitCode !== undefined) {
          if (typeof c.expectExitCode !== "number" || !Number.isInteger(c.expectExitCode)) {
            throw new Error(`checks[${i}].expectExitCode must be an integer`);
          }
          out.expectExitCode = c.expectExitCode;
        }
        if (c.stdoutRegex !== undefined) {
          out.stdoutRegex = compileOrThrow(str("stdoutRegex"), i);
        }
        return out;
      }
      default:
        throw new Error(`checks[${i}].kind unsupported`);
    }
  });
}

function compileOrThrow(pattern: string, i: number): string {
  if (pattern.length > 500) {
    throw new Error(`checks[${i}]: pattern longer than 500 chars`);
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `checks[${i}]: invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return pattern;
}

export function describeTaskCheck(check: TaskCheck): string {
  switch (check.kind) {
    case "file_exists":
      return `file exists: ${check.path}`;
    case "file_contains":
      return `file ${check.path} contains "${check.value}"`;
    case "file_regex":
      return `file ${check.path} matches /${check.pattern}/`;
    case "output_regex":
      return `output matches /${check.pattern}/`;
    case "command":
      return `command \`${check.command}\` exits ${check.expectExitCode ?? 0}${check.stdoutRegex ? ` and stdout matches /${check.stdoutRegex}/` : ""}`;
  }
}

/** Resolve a check path inside the workspace or explain why it cannot be. */
function confinePath(
  workspaceDir: string | null,
  target: string,
): { ok: string } | { err: string } {
  if (!workspaceDir) {
    return { err: "no workspace registered for path checks" };
  }
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { err: `path escapes the workspace: ${target}` };
  }
  return { ok: resolved };
}

async function readWorkspaceFile(
  workspaceDir: string | null,
  target: string,
): Promise<{ text: string } | { err: string }> {
  const confined = confinePath(workspaceDir, target);
  if ("err" in confined) {
    return confined;
  }
  try {
    const stat = await fs.stat(confined.ok);
    if (!stat.isFile()) {
      return { err: `not a regular file: ${target}` };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { err: `file larger than ${MAX_FILE_BYTES} bytes: ${target}` };
    }
    return { text: await fs.readFile(confined.ok, "utf-8") };
  } catch (err) {
    return { err: `cannot read ${target}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: cwd },
      },
      (error, stdout, stderr) => {
        const e = error as
          | (NodeJS.ErrnoException & { code?: number | string; killed?: boolean })
          | null;
        const timedOut = Boolean(e?.killed);
        const exitCode = e ? (typeof e.code === "number" ? e.code : null) : 0;
        resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
      },
    );
  });
}

async function runOne(check: TaskCheck, ctx: TaskCheckContext): Promise<TaskCheckResult> {
  const base = { check, description: describeTaskCheck(check) };
  switch (check.kind) {
    case "file_exists": {
      const confined = confinePath(ctx.workspaceDir, check.path);
      if ("err" in confined) {
        return { ...base, passed: false, detail: confined.err };
      }
      try {
        await fs.access(confined.ok);
        return { ...base, passed: true, detail: "exists" };
      } catch {
        return { ...base, passed: false, detail: "missing" };
      }
    }
    case "file_contains": {
      const file = await readWorkspaceFile(ctx.workspaceDir, check.path);
      if ("err" in file) {
        return { ...base, passed: false, detail: file.err };
      }
      const passed = file.text.includes(check.value);
      return { ...base, passed, detail: passed ? "found" : "value not found in file" };
    }
    case "file_regex": {
      const file = await readWorkspaceFile(ctx.workspaceDir, check.path);
      if ("err" in file) {
        return { ...base, passed: false, detail: file.err };
      }
      const passed = new RegExp(check.pattern, "m").test(file.text);
      return { ...base, passed, detail: passed ? "matched" : "no match in file" };
    }
    case "output_regex": {
      if (ctx.output === null || ctx.output.trim().length === 0) {
        return { ...base, passed: false, detail: "task has no recorded output" };
      }
      const passed = new RegExp(check.pattern, "m").test(ctx.output);
      return { ...base, passed, detail: passed ? "matched" : "no match in output" };
    }
    case "command": {
      if (!ctx.allowCommands) {
        return {
          ...base,
          passed: false,
          detail:
            "command checks are disabled (set BITTERBOT_TASKS_CHECK_COMMANDS=1 to run them); an unrun check cannot pass",
        };
      }
      if (!ctx.workspaceDir) {
        return { ...base, passed: false, detail: "no workspace registered for command checks" };
      }
      const r = await runCommand(
        check.command,
        path.resolve(ctx.workspaceDir),
        ctx.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
      if (r.timedOut) {
        return { ...base, passed: false, detail: "command timed out" };
      }
      const expected = check.expectExitCode ?? 0;
      if (r.exitCode !== expected) {
        return {
          ...base,
          passed: false,
          detail: `exit ${r.exitCode ?? "?"} (expected ${expected})${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ""}`,
        };
      }
      if (check.stdoutRegex && !new RegExp(check.stdoutRegex, "m").test(r.stdout)) {
        return { ...base, passed: false, detail: "exit ok but stdout did not match" };
      }
      return { ...base, passed: true, detail: `exit ${r.exitCode}` };
    }
  }
}

/** Run every check; never throws. Order preserved; each result self-describes. */
export async function runTaskChecks(
  checks: readonly TaskCheck[],
  ctx: TaskCheckContext,
): Promise<TaskCheckResult[]> {
  const out: TaskCheckResult[] = [];
  for (const check of checks) {
    try {
      out.push(await runOne(check, ctx));
    } catch (err) {
      out.push({
        check,
        description: describeTaskCheck(check),
        passed: false,
        detail: `check crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry — gateway boot supplies the workspace; tools read it.
// ---------------------------------------------------------------------------

let activeContext: { workspaceDir: string | null; allowCommands: boolean } = {
  workspaceDir: null,
  allowCommands: false,
};

export function isTaskCheckCommandsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BITTERBOT_TASKS_CHECK_COMMANDS;
  return v === "1" || v === "true";
}

export function registerTaskCheckContext(ctx: {
  workspaceDir: string | null;
  allowCommands?: boolean;
}) {
  activeContext = {
    workspaceDir: ctx.workspaceDir,
    allowCommands: ctx.allowCommands ?? isTaskCheckCommandsEnabled(),
  };
}

export function getTaskCheckContext(): { workspaceDir: string | null; allowCommands: boolean } {
  return activeContext;
}
