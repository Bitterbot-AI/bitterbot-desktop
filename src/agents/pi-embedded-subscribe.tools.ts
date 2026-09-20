import type { ToolCallVia } from "../infra/usage-ledger.types.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { MEDIA_TOKEN_RE } from "../media/parse.js";
import { truncateUtf16Safe } from "../utils.js";
import { type MessagingToolSend } from "./pi-embedded-messaging.js";
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  formatTruncatedToolText,
} from "./tools/tool-result-spill.js";

/**
 * Event-stream cap (UI / journal / after_tool_call). The MODEL-facing cap is
 * the spill wrapper in tools/tool-result-spill.ts (config
 * `tools.resultMaxChars`), applied inside every tool, so by the time a
 * result reaches this sanitizer it is normally already within the cap.
 */
const TOOL_RESULT_MAX_CHARS = DEFAULT_TOOL_RESULT_MAX_CHARS;
const TOOL_ERROR_MAX_CHARS = 400;

function truncateToolText(text: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return formatTruncatedToolText({ text, maxChars });
}

function normalizeToolErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

function extractErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct =
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason);
  if (direct) {
    return direct;
  }
  const status = typeof record.status === "string" ? record.status.trim() : "";
  return status ? normalizeToolErrorText(status) : undefined;
}

export function sanitizeToolResult(result: unknown, maxChars?: number): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return record;
  }
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text, maxChars) };
    }
    if (type === "image") {
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

export function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return undefined;
  }
  const texts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type !== "text" || typeof entry.text !== "string") {
        return undefined;
      }
      const trimmed = entry.text.trim();
      return trimmed ? trimmed : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Parse `MEDIA:` tokens from text content blocks (all Bitterbot tools).
 * 2. Fall back to `details.path` when image content exists (Bitterbot imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
export function extractToolResultMediaPaths(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return [];
  }

  // Extract MEDIA: paths from text content blocks.
  const paths: string[] = [];
  let hasImageContent = false;
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === "image") {
      hasImageContent = true;
      continue;
    }
    if (entry.type === "text" && typeof entry.text === "string") {
      // Reset lastIndex since MEDIA_TOKEN_RE is global.
      MEDIA_TOKEN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MEDIA_TOKEN_RE.exec(entry.text)) !== null) {
        // Strip surrounding quotes/backticks and whitespace (mirrors cleanCandidate in media/parse).
        const p = match[1]
          ?.replace(/^[`"'[{(]+/, "")
          .replace(/[`"'\]})\\,]+$/, "")
          .trim();
        if (p && p.length <= 4096) {
          paths.push(p);
        }
      }
    }
  }

  if (paths.length > 0) {
    return paths;
  }

  // Fall back to details.path when image content exists but no MEDIA: text.
  if (hasImageContent) {
    const details = record.details as Record<string, unknown> | undefined;
    const p = typeof details?.path === "string" ? details.path.trim() : "";
    if (p) {
      return [p];
    }
  }

  return [];
}

/**
 * Outcome of a tool call as far as telemetry is concerned.
 *
 * - `error`: the tool threw, or its result BODY says it failed
 *   (`details.status` error/timeout, `ok: false`, or a non-empty `error`
 *   field with no `ok: true`). Before 2026-09-05 only `details.status` was
 *   consulted, so the dominant `jsonResult({ ok: false, error })` shape of
 *   88 tool sites was journaled as a success and labeled "clean end, zero
 *   tool errors" downstream.
 * - `pending`: the result is a placeholder (`approval-pending`): the action
 *   has not happened yet, so it is neither a success nor a failure.
 * - `ok`: everything else.
 *
 * The classification is telemetry-only: the model still receives the
 * result text unchanged.
 */
export type ToolResultOutcome = "ok" | "error" | "pending";

const PENDING_STATUSES = new Set(["approval-pending"]);
const ERROR_STATUSES = new Set(["error", "timeout", "failed"]);

function classifyPayloadOutcome(payload: unknown): ToolResultOutcome | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (status && ERROR_STATUSES.has(status)) {
    return "error";
  }
  if (status && PENDING_STATUSES.has(status)) {
    return "pending";
  }
  if (record.ok === false) {
    return "error";
  }
  if (record.ok === true) {
    return "ok";
  }
  if (typeof record.error === "string" && record.error.trim().length > 0) {
    return "error";
  }
  return null;
}

export function classifyToolResultOutcome(result: unknown): ToolResultOutcome {
  if (!result || typeof result !== "object") {
    return "ok";
  }
  const record = result as Record<string, unknown>;
  const fromDetails = classifyPayloadOutcome(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  if (record.details !== undefined && record.details !== null) {
    // A structured payload that says nothing about failure is a success;
    // do not second-guess it from the rendered text.
    return "ok";
  }
  const text = extractToolResultText(result);
  if (text && text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const fromJson = classifyPayloadOutcome(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch {
      // Not JSON: no body-level signal.
    }
  }
  return "ok";
}

export function isToolResultError(result: unknown): boolean {
  return classifyToolResultOutcome(result) === "error";
}

export function isToolResultPending(result: unknown): boolean {
  return classifyToolResultOutcome(result) === "pending";
}

export function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const fromDetails = extractErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  const fromRoot = extractErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  const text = extractToolResultText(result);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromJson = extractErrorField(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fall through to first-line text fallback.
  }
  return normalizeToolErrorText(text);
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") {
      return undefined;
    }
    const toRaw = typeof args.to === "string" ? args.to : undefined;
    if (!toRaw) {
      return undefined;
    }
    const providerRaw = typeof args.provider === "string" ? args.provider.trim() : "";
    const channelRaw = typeof args.channel === "string" ? args.channel.trim() : "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const provider = providerId ?? (providerHint ? providerHint.toLowerCase() : "message");
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
  }
  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return undefined;
  }
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) {
    return undefined;
  }
  const to = normalizeTargetForProvider(providerId, extracted.to);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}

// ---------------------------------------------------------------------------
// Tool-call telemetry (hot-set proof). Pure classification over the agent
// event stream; the subscriber wires `record` to the usage ledger.
// ---------------------------------------------------------------------------

export type ToolCallTelemetryEvent = {
  ts: number;
  toolCallId: string;
  /** The tool the agent actually reached (for use_tool, the dispatched target). */
  tool: string;
  via: ToolCallVia;
  ok: boolean;
  errorClass?: string;
  durationMs?: number;
  /** Full result size when known (the spill marker carries the original length). */
  resultChars?: number;
  spilled: boolean;
};

const SPILL_MARKER_RE = /\[truncated: (\d+) chars total/;
const NATIVE_TOOL_SEARCH_PREFIX = "tool_search_tool";

/** Coarse failure class for the ledger; the full message stays in the transcript. */
export function classifyToolErrorClass(message: string | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (!text) {
    return "error";
  }
  if (/timed? ?out|timeout|deadline/.test(text)) {
    return "timeout";
  }
  if (/denied|not allowed|blocked|forbidden|policy|approval|consent|unauthori[sz]ed/.test(text)) {
    return "denied";
  }
  if (/not found|unknown tool|no such tool|does not exist|enoent/.test(text)) {
    return "not-found";
  }
  if (/invalid|missing required|must be|expected|schema|malformed|parse/.test(text)) {
    return "invalid-args";
  }
  if (/rate limit|429|too many/.test(text)) {
    return "rate-limit";
  }
  if (/network|econnrefused|econnreset|fetch failed|dns|socket/.test(text)) {
    return "network";
  }
  return "error";
}

function resolveToolVia(toolName: string, args: unknown): { tool: string; via: ToolCallVia } {
  const name = toolName.trim().toLowerCase();
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (name === "use_tool") {
    const target =
      typeof record.name === "string"
        ? record.name
        : typeof record.tool === "string"
          ? record.tool
          : "";
    return { tool: target.trim() || "use_tool", via: "use_tool" };
  }
  if (name === "list_tools") {
    return { tool: "list_tools", via: "list_tools" };
  }
  if (name.startsWith(NATIVE_TOOL_SEARCH_PREFIX)) {
    return { tool: toolName.trim(), via: "native-search" };
  }
  return { tool: toolName.trim(), via: "direct" };
}

/** Size and spill state of a tool result: the marker carries the original length. */
export function measureToolResult(result: unknown): { chars?: number; spilled: boolean } {
  const text = extractToolResultText(result);
  if (!text) {
    return { spilled: false };
  }
  const match = SPILL_MARKER_RE.exec(text);
  if (match) {
    const total = Number(match[1]);
    return { chars: Number.isFinite(total) ? total : text.length, spilled: true };
  }
  const record = result as { details?: { spilled?: unknown; spilledPath?: unknown } };
  const flagged =
    record?.details?.spilled === true || typeof record?.details?.spilledPath === "string";
  return { chars: text.length, spilled: flagged };
}

/**
 * Native tool search: Anthropic's `server_tool_use` blocks named `tool_search_tool_*` and the
 * `tool_search_tool_result` blocks listing the `tool_reference`s it surfaced. One telemetry
 * row per referenced tool (via "native-search"); a search with no references is one row
 * named after the search tool itself.
 */
export function extractNativeToolSearchCalls(
  message: unknown,
  now: number,
): ToolCallTelemetryEvent[] {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const out: ToolCallTelemetryEvent[] = [];
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i] as Record<string, unknown> | null;
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = typeof block.type === "string" ? block.type : "";
    const name = typeof block.name === "string" ? block.name : "";
    const isServerSearch =
      (type === "server_tool_use" || type === "serverToolUse") &&
      name.startsWith(NATIVE_TOOL_SEARCH_PREFIX);
    if (!isServerSearch) {
      continue;
    }
    const id = typeof block.id === "string" ? block.id : `native-${i}`;
    const references: string[] = [];
    let errored = false;
    for (let j = i + 1; j < content.length; j += 1) {
      const next = content[j] as Record<string, unknown> | null;
      if (!next || typeof next !== "object") {
        continue;
      }
      const nextType = typeof next.type === "string" ? next.type : "";
      if (nextType !== "tool_search_tool_result" && nextType !== "toolSearchToolResult") {
        continue;
      }
      if (typeof next.tool_use_id === "string" && next.tool_use_id !== id) {
        continue;
      }
      const inner = next.content;
      if (Array.isArray(inner)) {
        for (const ref of inner) {
          const r = ref as Record<string, unknown> | null;
          if (r && (r.type === "tool_reference" || r.type === "toolReference")) {
            const toolName = typeof r.tool_name === "string" ? r.tool_name : r.name;
            if (typeof toolName === "string" && toolName.trim()) {
              references.push(toolName.trim());
            }
          }
        }
      } else if (inner && typeof inner === "object" && "error_code" in (inner as object)) {
        errored = true;
      }
      break;
    }
    if (references.length === 0) {
      out.push({
        ts: now,
        toolCallId: id,
        tool: name,
        via: "native-search",
        ok: !errored,
        errorClass: errored ? "error" : undefined,
        spilled: false,
      });
      continue;
    }
    for (const ref of references) {
      out.push({
        ts: now,
        toolCallId: id,
        tool: ref,
        via: "native-search",
        ok: true,
        spilled: false,
      });
    }
  }
  return out;
}

/**
 * Tap the raw agent events for tool telemetry. Start events remember (tool, args, time);
 * end events classify the outcome (body-level failures count) and emit one row. Never throws.
 */
export function createToolCallTelemetry(
  record: (evt: ToolCallTelemetryEvent) => void,
  opts?: { now?: () => number },
): { onEvent: (evt: unknown) => void; onAssistantMessage: (message: unknown) => void } {
  const now = opts?.now ?? Date.now;
  const starts = new Map<string, { startedAt: number; toolName: string; args: unknown }>();
  const safeRecord = (evt: ToolCallTelemetryEvent) => {
    try {
      record(evt);
    } catch {
      // Telemetry must never affect the turn.
    }
  };
  return {
    onEvent: (raw) => {
      const evt = raw as {
        type?: string;
        toolCallId?: unknown;
        toolName?: unknown;
        args?: unknown;
        result?: unknown;
        isError?: unknown;
      };
      if (!evt || typeof evt !== "object") {
        return;
      }
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      if (evt.type === "tool_execution_start" && toolCallId) {
        starts.set(toolCallId, {
          startedAt: now(),
          toolName: typeof evt.toolName === "string" ? evt.toolName : "unknown",
          args: evt.args,
        });
        if (starts.size > 256) {
          const oldest = starts.keys().next().value;
          if (oldest !== undefined) {
            starts.delete(oldest);
          }
        }
        return;
      }
      if (evt.type !== "tool_execution_end" || !toolCallId) {
        return;
      }
      const start = starts.get(toolCallId);
      starts.delete(toolCallId);
      const toolName =
        start?.toolName ?? (typeof evt.toolName === "string" ? evt.toolName : "unknown");
      const { tool, via } = resolveToolVia(toolName, start?.args);
      const outcome = classifyToolResultOutcome(evt.result);
      const failed = evt.isError === true || outcome === "error";
      const measured = measureToolResult(evt.result);
      const ts = now();
      safeRecord({
        ts,
        toolCallId,
        tool,
        via,
        ok: !failed,
        errorClass: failed
          ? classifyToolErrorClass(extractToolErrorMessage(evt.result))
          : undefined,
        durationMs: start ? Math.max(0, ts - start.startedAt) : undefined,
        resultChars: measured.chars,
        spilled: measured.spilled,
      });
    },
    onAssistantMessage: (message) => {
      try {
        for (const evt of extractNativeToolSearchCalls(message, now())) {
          safeRecord(evt);
        }
      } catch {
        // Telemetry only.
      }
    },
  };
}
