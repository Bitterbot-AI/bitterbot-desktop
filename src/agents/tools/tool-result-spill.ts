/**
 * Tool-result spill-to-file (token-efficiency W5, item 3).
 *
 * The model receives tool results untruncated from pi-agent's loop; the old
 * 8000-char cap in pi-embedded-subscribe.tools.ts only trimmed the EVENT
 * stream. This wrapper is the model-facing cap: a text block over
 * `tools.resultMaxChars` (default 8000) is written in full to
 * `<agent state dir>/tool-results/<runId>-<n>.txt` and the model gets
 * head + a one-line marker + tail, so it can `read` the file (with offsets)
 * when the middle matters. Files older than 24h are swept on the next spill.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { truncateUtf16Safe } from "../../utils.js";
import { carryToolMarkers } from "../pi-tools.types.js";

const log = createSubsystemLogger("agents/tools/result-spill");

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 8000;
export const TOOL_RESULTS_DIRNAME = "tool-results";
export const TOOL_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** head = 75% of the cap, tail = 18.75% (6000 / 1500 at the 8000 default). */
const HEAD_RATIO = 0.75;
const TAIL_RATIO = 0.1875;

const lastSweepByDir = new Map<string, number>();

export function resolveToolResultMaxChars(cfg?: BitterbotConfig): number {
  const raw = cfg?.tools?.resultMaxChars;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1000) {
    return Math.floor(raw);
  }
  return DEFAULT_TOOL_RESULT_MAX_CHARS;
}

/**
 * `agentDir` is `<state>/agents/<id>/agent`; the spill dir is the sibling
 * `<state>/agents/<id>/tool-results`. Any other directory gets a child.
 */
export function resolveToolResultsDir(agentDir?: string): string {
  const trimmed = agentDir?.trim();
  if (!trimmed) {
    return path.join(os.tmpdir(), "bitterbot", TOOL_RESULTS_DIRNAME);
  }
  const base = path.basename(trimmed) === "agent" ? path.dirname(trimmed) : trimmed;
  return path.join(base, TOOL_RESULTS_DIRNAME);
}

function tailUtf16Safe(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) {
    return input;
  }
  let start = input.length - limit;
  const code = input.charCodeAt(start);
  // Do not start on a low surrogate.
  if (code >= 0xdc00 && code <= 0xdfff) {
    start += 1;
  }
  return input.slice(start);
}

export function formatTruncatedToolText(params: {
  text: string;
  maxChars: number;
  savedPath?: string;
  failure?: string;
}): string {
  const { text, maxChars } = params;
  const head = truncateUtf16Safe(text, Math.floor(maxChars * HEAD_RATIO));
  const tail = tailUtf16Safe(text, Math.floor(maxChars * TAIL_RATIO));
  const where = params.savedPath
    ? `full output saved to ${params.savedPath}; use read to view`
    : params.failure
      ? `full output not saved: ${params.failure}`
      : "full output not saved";
  return `${head}\n[truncated: ${text.length} chars total; ${where}]\n${tail}`;
}

function sanitizeStem(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 80) || "run";
}

export type SpillContext = {
  maxChars: number;
  dir: string;
  /** File stem; the run id when known, else the session key. */
  runId?: string;
  /** Shared per-run counter so files are `<runId>-1.txt`, `<runId>-2.txt`, ... */
  counter?: { value: number };
};

/** Write the full text to `<dir>/<stem>-<n>.txt` and return the model-facing text. */
export async function spillToolResultText(
  text: string,
  ctx: SpillContext,
): Promise<{ text: string; path?: string }> {
  if (text.length <= ctx.maxChars) {
    return { text };
  }
  const counter = ctx.counter ?? { value: 0 };
  counter.value += 1;
  const stem = sanitizeStem(ctx.runId ?? `run-${Date.now()}`);
  const filePath = path.join(ctx.dir, `${stem}-${counter.value}.txt`);
  try {
    await fs.promises.mkdir(ctx.dir, { recursive: true });
    await fs.promises.writeFile(filePath, text, "utf8");
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    log.warn("tool result spill failed; returning plain truncation", { path: filePath, failure });
    return { text: formatTruncatedToolText({ text, maxChars: ctx.maxChars, failure }) };
  }
  scheduleSweep(ctx.dir);
  return {
    text: formatTruncatedToolText({ text, maxChars: ctx.maxChars, savedPath: filePath }),
    path: filePath,
  };
}

/** Delete spill files older than the retention window; returns the count removed. */
export async function sweepToolResults(
  dir: string,
  opts?: { retentionMs?: number; now?: number },
): Promise<number> {
  const retentionMs = opts?.retentionMs ?? TOOL_RESULT_RETENTION_MS;
  const now = opts?.now ?? Date.now();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".txt")) {
      continue;
    }
    const filePath = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || now - stat.mtimeMs <= retentionMs) {
        continue;
      }
      await fs.promises.unlink(filePath);
      removed += 1;
    } catch {
      // Raced with another sweep or already gone.
    }
  }
  return removed;
}

function scheduleSweep(dir: string) {
  const now = Date.now();
  const last = lastSweepByDir.get(dir) ?? 0;
  if (now - last < SWEEP_MIN_INTERVAL_MS) {
    return;
  }
  lastSweepByDir.set(dir, now);
  void sweepToolResults(dir).then((removed) => {
    if (removed > 0) {
      log.debug("swept stale tool results", { dir, removed });
    }
  });
}

/** Test hook: forget sweep timestamps so the next spill sweeps again. */
export function resetToolResultSweepStateForTest() {
  lastSweepByDir.clear();
}

async function spillResult(result: unknown, ctx: SpillContext): Promise<unknown> {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return result;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string" &&
      (item as { text: string }).text.length > ctx.maxChars
    ) {
      const spilled = await spillToolResultText((item as { text: string }).text, ctx);
      next.push({ ...(item as Record<string, unknown>), text: spilled.text });
      changed = true;
      continue;
    }
    next.push(item);
  }
  return changed ? { ...record, content: next } : result;
}

export function wrapToolWithResultSpill(tool: AnyAgentTool, ctx: SpillContext): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return carryToolMarkers(tool, {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await execute(toolCallId, params, signal, onUpdate);
      return (await spillResult(result, ctx)) as Awaited<ReturnType<typeof execute>>;
    },
  });
}

export function wrapToolsWithResultSpill(
  tools: AnyAgentTool[],
  ctx: Omit<SpillContext, "counter">,
): AnyAgentTool[] {
  const shared: SpillContext = { ...ctx, counter: { value: 0 } };
  return tools.map((tool) => wrapToolWithResultSpill(tool, shared));
}
