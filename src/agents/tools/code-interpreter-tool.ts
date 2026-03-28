import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { resolveStateDir } from "../../config/paths.js";
import { ensureDir } from "../../utils.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const LANGUAGES = ["python", "javascript"] as const;

const CodeInterpreterSchema = Type.Object({
  language: stringEnum(LANGUAGES),
  code: Type.String(),
  sessionId: Type.Optional(Type.String()),
});

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

// Per-session JS vm contexts for persistent state across calls
const jsSessions = new Map<string, vm.Context>();

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated, ${s.length - max} chars omitted)`;
}

/**
 * Execute JavaScript code server-side using Node's vm module.
 * Supports session persistence (variables carry across calls with same sessionId).
 */
async function executeJavaScript(
  code: string,
  sessionId: string,
): Promise<{ stdout: string; stderr: string; returnValue: string | null; error: string | null }> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  // Reuse or create a vm context for this session
  let context = jsSessions.get(sessionId);
  if (!context) {
    const sandbox: Record<string, unknown> = {
      console: {
        log: (...args: unknown[]) => stdout.push(args.map(formatArg).join(" ")),
        error: (...args: unknown[]) => stderr.push(args.map(formatArg).join(" ")),
        warn: (...args: unknown[]) => stdout.push("[warn] " + args.map(formatArg).join(" ")),
        info: (...args: unknown[]) => stdout.push(args.map(formatArg).join(" ")),
      },
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      Math,
      Date,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      RegExp,
      Error,
      Promise,
      Symbol,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      Buffer,
    };
    context = vm.createContext(sandbox);
    jsSessions.set(sessionId, context);
  } else {
    // Update console for this call (captures go to fresh arrays)
    context.console = {
      log: (...args: unknown[]) => stdout.push(args.map(formatArg).join(" ")),
      error: (...args: unknown[]) => stderr.push(args.map(formatArg).join(" ")),
      warn: (...args: unknown[]) => stdout.push("[warn] " + args.map(formatArg).join(" ")),
      info: (...args: unknown[]) => stdout.push(args.map(formatArg).join(" ")),
    };
  }

  try {
    // Wrap in async IIFE to support top-level await
    const wrappedCode = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrappedCode, { filename: "code-interpreter.js" });
    const result = await script.runInContext(context, { timeout: EXEC_TIMEOUT_MS });
    const returnValue = result !== undefined && result !== null ? formatArg(result) : null;
    return {
      stdout: truncate(stdout.join("\n"), MAX_OUTPUT_CHARS),
      stderr: truncate(stderr.join("\n"), MAX_OUTPUT_CHARS),
      returnValue,
      error: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      stdout: truncate(stdout.join("\n"), MAX_OUTPUT_CHARS),
      stderr: truncate(stderr.join("\n"), MAX_OUTPUT_CHARS),
      returnValue: null,
      error: errMsg,
    };
  }
}

function formatArg(a: unknown): string {
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a, null, 2);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/**
 * Execute Python code server-side using child_process.
 * Requires python3 to be available on PATH.
 */
function executePython(
  code: string,
): Promise<{ stdout: string; stderr: string; returnValue: string | null; error: string | null }> {
  return new Promise((resolve) => {
    // Try python3 first, then python
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    execFile(
      pythonBin,
      ["-c", code],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          // Python not found, try alternative
          if (pythonBin === "python3") {
            execFile(
              "python",
              ["-c", code],
              { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
              (err2, stdout2, stderr2) => {
                if (err2 && (err2 as NodeJS.ErrnoException).code === "ENOENT") {
                  resolve({
                    stdout: "",
                    stderr: "",
                    returnValue: null,
                    error:
                      "Python is not installed on this system. " +
                      "Install Python 3 to use the Python code interpreter, " +
                      "or use language: 'javascript' instead.",
                  });
                  return;
                }
                resolve({
                  stdout: truncate(stdout2, MAX_OUTPUT_CHARS),
                  stderr: truncate(stderr2, MAX_OUTPUT_CHARS),
                  returnValue: null,
                  error: err2 ? err2.message : null,
                });
              },
            );
            return;
          }
          resolve({
            stdout: "",
            stderr: "",
            returnValue: null,
            error: "Python is not installed on this system.",
          });
          return;
        }
        resolve({
          stdout: truncate(stdout, MAX_OUTPUT_CHARS),
          stderr: truncate(stderr, MAX_OUTPUT_CHARS),
          returnValue: null,
          error: err && !stdout ? err.message : null,
        });
      },
    );
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build an HTML page for UI-side rendering of execution results.
 * This is a visual artifact for the ToolCallPanel, not used for execution.
 */
function buildResultHtml(
  language: string,
  code: string,
  stdout: string,
  stderr: string,
  error: string | null,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Code Interpreter - ${escapeHtml(language)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: monospace; background: #0a0a0a; color: #fafafa; margin: 0; padding: 16px; }
    .section { margin-bottom: 16px; }
    .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    pre { white-space: pre-wrap; word-break: break-all; margin: 0; padding: 8px; border-radius: 4px; }
    .code { background: #1a1a2e; color: #e0e0ff; }
    .stdout { background: #0a1a0a; color: #a0ffa0; }
    .stderr { background: #1a0a0a; color: #ffa0a0; }
    .error { background: #2a0a0a; color: #ff5c5c; border: 1px solid #ff5c5c33; }
  </style>
</head>
<body>
  <div class="section">
    <div class="label">Code (${escapeHtml(language)})</div>
    <pre class="code">${escapeHtml(code)}</pre>
  </div>
  ${stdout ? `<div class="section"><div class="label">Output</div><pre class="stdout">${escapeHtml(stdout)}</pre></div>` : ""}
  ${stderr ? `<div class="section"><div class="label">Stderr</div><pre class="stderr">${escapeHtml(stderr)}</pre></div>` : ""}
  ${error ? `<div class="section"><div class="label">Error</div><pre class="error">${escapeHtml(error)}</pre></div>` : ""}
</body>
</html>`;
}

function resolveCodeExecDir(): string {
  return path.join(resolveStateDir(), "canvas", "code-exec");
}

export function createCodeInterpreterTool(): AnyAgentTool {
  return {
    label: "Code Interpreter",
    name: "code_interpreter",
    description:
      "Execute Python or JavaScript code and return the output. " +
      "JavaScript runs in a sandboxed Node.js VM with session persistence (variables survive across calls). " +
      "Python runs via the system python3 interpreter. " +
      "Use this for calculations, data analysis, algorithms, and verifying logic. " +
      "Output includes stdout, stderr, return values, and any errors.",
    parameters: CodeInterpreterSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const language = readStringParam(params, "language", { required: true }) as "python" | "javascript";
      const code = readStringParam(params, "code", { required: true });
      const sessionId = readStringParam(params, "sessionId", { required: false }) || "default";

      // Execute code server-side
      const result =
        language === "javascript"
          ? await executeJavaScript(code, sessionId)
          : await executePython(code);

      // Write an HTML artifact for UI-side rendering in the ToolCallPanel
      const execId = `exec_${Date.now()}_${toolCallId.slice(0, 8)}`;
      const execDir = resolveCodeExecDir();
      await ensureDir(execDir);
      const html = buildResultHtml(language, code, result.stdout, result.stderr, result.error);
      await fs.writeFile(path.join(execDir, `${execId}.html`), html, "utf8");

      // Build a structured result the agent can reason about
      const outputParts: string[] = [];
      if (result.stdout) outputParts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) outputParts.push(`stderr:\n${result.stderr}`);
      if (result.returnValue) outputParts.push(`return value: ${result.returnValue}`);
      if (result.error) outputParts.push(`error: ${result.error}`);

      const hasOutput = outputParts.length > 0;

      return jsonResult({
        ok: !result.error,
        execId,
        language,
        sessionId,
        ...(result.stdout ? { stdout: result.stdout } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ...(result.returnValue ? { returnValue: result.returnValue } : {}),
        ...(result.error ? { error: result.error } : {}),
        output: hasOutput ? outputParts.join("\n\n") : "(no output)",
      });
    },
  };
}
