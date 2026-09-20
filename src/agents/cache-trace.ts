import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import {
  digestSystemPromptHalves,
  digestToolDefinitions,
  sha256Hex,
  splitSystemPromptAtBoundary,
} from "./system-prompt-cache-boundary.js";

export type CacheTraceStage =
  | "session:loaded"
  | "session:sanitized"
  | "session:limited"
  | "prompt:before"
  | "prompt:images"
  | "stream:context"
  | "stream:usage"
  | "session:after";

export type CacheTraceEvent = {
  ts: string;
  seq: number;
  stage: CacheTraceStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  prompt?: string;
  system?: unknown;
  options?: Record<string, unknown>;
  model?: Record<string, unknown>;
  messages?: AgentMessage[];
  messageCount?: number;
  messageRoles?: Array<string | undefined>;
  messageFingerprints?: string[];
  messagesDigest?: string;
  systemDigest?: string;
  /**
   * Token-efficiency W4: separate digests of the two system-prompt halves and
   * of the sorted tool definitions. A stable prefix shows as an unchanged
   * stableDigest + toolsDigest across turns while volatileDigest moves.
   */
  stableDigest?: string;
  volatileDigest?: string;
  boundaryFound?: boolean;
  toolsDigest?: string;
  /** Response usage (stream:usage): cache_read / cache_write straight from the provider. */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  note?: string;
  error?: string;
};

export type CacheTrace = {
  /**
   * True when the JSONL trace is being written (`BITTERBOT_CACHE_TRACE=1` or
   * `diagnostics.cacheTrace.enabled`). When false the trace is digest-only: `recordStage`
   * is a no-op and `wrapStreamFn` computes just the two cheap prefix digests per request
   * for the usage ledger (`prefix_digest`, `tools_digest`). It never returns null so the
   * ledger telemetry does not depend on the diagnostics flag.
   */
  enabled: boolean;
  filePath: string;
  recordStage: (stage: CacheTraceStage, payload?: Partial<CacheTraceEvent>) => void;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

/** Prefix digests of the most recent request of a run, read by the usage-ledger hook. */
export type RunPrefixDigests = {
  /** SHA-256 of the stable system block (text above the cache boundary marker). */
  prefixDigest?: string;
  /** SHA-256 of the sorted tool names sent with the request. */
  toolsDigest?: string;
  at: number;
};

const RUN_PREFIX_DIGESTS_MAX = 512;
const runPrefixDigests = new Map<string, RunPrefixDigests>();

/** The two cheap digests: stable system block and sorted tool names. Pure; exported for tests. */
export function computePrefixDigests(
  system: unknown,
  tools: ReadonlyArray<{ name?: unknown }> | undefined,
): Omit<RunPrefixDigests, "at"> {
  const out: Omit<RunPrefixDigests, "at"> = {};
  if (typeof system === "string" && system.length > 0) {
    out.prefixDigest = sha256Hex(splitSystemPromptAtBoundary(system).stable);
  }
  if (Array.isArray(tools) && tools.length > 0) {
    const names = tools
      .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
      .filter((name) => name.length > 0)
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (names.length > 0) {
      out.toolsDigest = sha256Hex(JSON.stringify(names));
    }
  }
  return out;
}

function publishRunPrefixDigests(key: string | undefined, digests: Omit<RunPrefixDigests, "at">) {
  if (!key) {
    return;
  }
  if (runPrefixDigests.size >= RUN_PREFIX_DIGESTS_MAX && !runPrefixDigests.has(key)) {
    const oldest = runPrefixDigests.keys().next().value;
    if (oldest !== undefined) {
      runPrefixDigests.delete(oldest);
    }
  }
  runPrefixDigests.set(key, { ...digests, at: Date.now() });
}

/** Digests of the latest request sent under `runId` (or session key), if any. */
export function getRunPrefixDigests(runId: string | undefined): RunPrefixDigests | undefined {
  return runId ? runPrefixDigests.get(runId) : undefined;
}

export function resetRunPrefixDigestsForTest(): void {
  runPrefixDigests.clear();
}

type CacheTraceInit = {
  cfg?: BitterbotConfig;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: CacheTraceWriter;
};

type CacheTraceConfig = {
  enabled: boolean;
  filePath: string;
  includeMessages: boolean;
  includePrompt: boolean;
  includeSystem: boolean;
};

type CacheTraceWriter = {
  filePath: string;
  write: (line: string) => void;
};

const writers = new Map<string, CacheTraceWriter>();

function resolveCacheTraceConfig(params: CacheTraceInit): CacheTraceConfig {
  const env = params.env ?? process.env;
  const config = params.cfg?.diagnostics?.cacheTrace;
  const envEnabled = parseBooleanValue(env.BITTERBOT_CACHE_TRACE);
  const enabled = envEnabled ?? config?.enabled ?? false;
  const fileOverride = config?.filePath?.trim() || env.BITTERBOT_CACHE_TRACE_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "cache-trace.jsonl");

  const includeMessages =
    parseBooleanValue(env.BITTERBOT_CACHE_TRACE_MESSAGES) ?? config?.includeMessages;
  const includePrompt =
    parseBooleanValue(env.BITTERBOT_CACHE_TRACE_PROMPT) ?? config?.includePrompt;
  const includeSystem =
    parseBooleanValue(env.BITTERBOT_CACHE_TRACE_SYSTEM) ?? config?.includeSystem;

  return {
    enabled,
    filePath,
    includeMessages: includeMessages ?? true,
    includePrompt: includePrompt ?? true,
    includeSystem: includeSystem ?? true,
  };
}

function getWriter(filePath: string): CacheTraceWriter {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();

  const writer: CacheTraceWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .catch(() => undefined);
    },
  };

  writers.set(filePath, writer);
  return writer;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return JSON.stringify(String(value));
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Error) {
    return stableStringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }
  if (value instanceof Uint8Array) {
    return stableStringify({
      type: "Uint8Array",
      data: Buffer.from(value).toString("base64"),
    });
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function digest(value: unknown): string {
  const serialized = stableStringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function summarizeMessages(messages: AgentMessage[]): {
  messageCount: number;
  messageRoles: Array<string | undefined>;
  messageFingerprints: string[];
  messagesDigest: string;
} {
  const messageFingerprints = messages.map((msg) => digest(msg));
  return {
    messageCount: messages.length,
    messageRoles: messages.map((msg) => (msg as { role?: string }).role),
    messageFingerprints,
    messagesDigest: digest(messageFingerprints.join("|")),
  };
}

export function createCacheTrace(params: CacheTraceInit): CacheTrace {
  const cfg = resolveCacheTraceConfig(params);
  const digestKey = params.runId ?? params.sessionKey;
  if (!cfg.enabled) {
    // Digest-only mode: no file, no per-message fingerprints; just the two prefix digests the
    // usage ledger stores on every chat row.
    return {
      enabled: false,
      filePath: cfg.filePath,
      recordStage: () => undefined,
      wrapStreamFn: (streamFn) => (model, context, options) => {
        try {
          const ctx = context as {
            system?: unknown;
            systemPrompt?: string;
            tools?: Array<{ name: string }>;
          };
          publishRunPrefixDigests(
            digestKey,
            computePrefixDigests(ctx.systemPrompt ?? ctx.system, ctx.tools),
          );
        } catch {
          // Telemetry only.
        }
        return streamFn(model, context, options);
      },
    };
  }

  const writer = params.writer ?? getWriter(cfg.filePath);
  let seq = 0;

  const base: Omit<CacheTraceEvent, "ts" | "seq" | "stage"> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const recordStage: CacheTrace["recordStage"] = (stage, payload = {}) => {
    const event: CacheTraceEvent = {
      ...base,
      ts: new Date().toISOString(),
      seq: (seq += 1),
      stage,
    };

    if (payload.prompt !== undefined && cfg.includePrompt) {
      event.prompt = payload.prompt;
    }
    if (payload.system !== undefined && cfg.includeSystem) {
      event.system = payload.system;
      event.systemDigest = digest(payload.system);
    }
    if (typeof payload.system === "string") {
      const halves = digestSystemPromptHalves(payload.system);
      event.stableDigest = halves.stableDigest;
      event.volatileDigest = halves.volatileDigest;
      event.boundaryFound = halves.boundaryFound;
    }
    if (payload.toolsDigest) {
      event.toolsDigest = payload.toolsDigest;
    }
    if (payload.usage) {
      event.usage = payload.usage;
    }
    if (payload.options) {
      event.options = payload.options;
    }
    if (payload.model) {
      event.model = payload.model;
    }

    const messages = payload.messages;
    if (Array.isArray(messages)) {
      const summary = summarizeMessages(messages);
      event.messageCount = summary.messageCount;
      event.messageRoles = summary.messageRoles;
      event.messageFingerprints = summary.messageFingerprints;
      event.messagesDigest = summary.messagesDigest;
      if (cfg.includeMessages) {
        event.messages = messages;
      }
    }

    if (payload.note) {
      event.note = payload.note;
    }
    if (payload.error) {
      event.error = payload.error;
    }

    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const recordUsage = (result: unknown) => {
    const usage = (result as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage || typeof usage !== "object") {
      return;
    }
    const num = (value: unknown) => (typeof value === "number" ? value : undefined);
    recordStage("stream:usage", {
      usage: {
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite: num(usage.cacheWrite),
      },
    });
  };

  const wrapStreamFn: CacheTrace["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const ctx = context as {
        system?: unknown;
        systemPrompt?: string;
        messages?: AgentMessage[];
        tools?: Array<{ name: string; description?: unknown; parameters?: unknown }>;
      };
      recordStage("stream:context", {
        model: {
          id: model?.id,
          provider: model?.provider,
          api: model?.api,
        },
        system: ctx.systemPrompt ?? ctx.system,
        toolsDigest: digestToolDefinitions(ctx.tools),
        messages: ctx.messages ?? [],
        options: (options ?? {}) as Record<string, unknown>,
      });
      try {
        publishRunPrefixDigests(
          digestKey,
          computePrefixDigests(ctx.systemPrompt ?? ctx.system, ctx.tools),
        );
      } catch {
        // Telemetry only.
      }
      const out = streamFn(model, context, options);
      // Hook the final assistant message for cache_read / cache_write. The
      // stream is consumed by the agent loop as usual; result() only awaits
      // the terminal event and never drains the queue.
      Promise.resolve(out)
        .then((stream) => (stream as { result?: () => Promise<unknown> }).result?.())
        .then((result) => recordUsage(result))
        .catch(() => undefined);
      return out;
    };
    return wrapped;
  };

  return {
    enabled: true,
    filePath: cfg.filePath,
    recordStage,
    wrapStreamFn,
  };
}
