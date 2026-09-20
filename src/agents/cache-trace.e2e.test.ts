import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { computePrefixDigests, createCacheTrace, getRunPrefixDigests } from "./cache-trace.js";
import { CACHE_BOUNDARY_MARKER, digestToolDefinitions } from "./system-prompt-cache-boundary.js";

describe("createCacheTrace", () => {
  it("is digest-only (enabled=false, no writes) when diagnostics cache tracing is disabled", () => {
    const trace = createCacheTrace({
      cfg: {} as BitterbotConfig,
      env: {},
      runId: "run-off",
    });

    expect(trace.enabled).toBe(false);
    trace.recordStage("session:loaded", { messages: [], system: "sys" });
    const streamFn = trace.wrapStreamFn(() => {
      const stream = new AssistantMessageEventStream();
      stream.end({ usage: { input: 1, output: 1 } } as never);
      return stream;
    });
    const system = `STABLE\n${CACHE_BOUNDARY_MARKER}\nVOLATILE`;
    const tools = [{ name: "b" }, { name: "a" }];
    void streamFn({ id: "m" } as never, { systemPrompt: system, messages: [], tools } as never, {});
    const digests = getRunPrefixDigests("run-off");
    expect(digests?.prefixDigest).toBe(computePrefixDigests(system, tools).prefixDigest);
    expect(digests?.toolsDigest).toBe(
      computePrefixDigests(system, [{ name: "a" }, { name: "b" }]).toolsDigest,
    );
  });

  it("honors diagnostics cache trace config and expands file paths", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            filePath: "~/.bitterbot/logs/cache-trace.jsonl",
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(trace.enabled).toBe(true);
    expect(trace?.filePath).toBe(resolveUserPath("~/.bitterbot/logs/cache-trace.jsonl"));

    trace?.recordStage("session:loaded", {
      messages: [],
      system: "sys",
    });

    expect(lines.length).toBe(1);
  });

  it("records empty prompt/system values when enabled", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includePrompt: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    trace?.recordStage("prompt:before", { prompt: "", system: "" });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.prompt).toBe("");
    expect(event.system).toBe("");
  });

  it("respects env overrides for enablement", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {
        BITTERBOT_CACHE_TRACE: "0",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(trace.enabled).toBe(false);
    trace.recordStage("prompt:before", { system: "x" });
    expect(lines.length).toBe(0);
  });
});

describe("token-efficiency W4: prefix-stability digests and usage", () => {
  function makeTrace(lines: string[]) {
    return createCacheTrace({
      cfg: { diagnostics: { cacheTrace: { enabled: true } } },
      env: {},
      writer: { filePath: "memory", write: (line) => lines.push(line) },
    });
  }

  it("records separate stable / volatile digests and a sorted tools digest", async () => {
    const lines: string[] = [];
    const trace = makeTrace(lines);
    const system = `STABLE\n${CACHE_BOUNDARY_MARKER}\nVOLATILE 1`;
    const streamFn = trace?.wrapStreamFn(() => {
      const stream = new AssistantMessageEventStream();
      stream.end({ usage: { input: 10, output: 2, cacheRead: 5000, cacheWrite: 120 } } as never);
      return stream;
    });
    const model = { id: "m", provider: "anthropic", api: "anthropic-messages" };
    const tools = [
      { name: "write", description: "w", parameters: {} },
      { name: "read", description: "r", parameters: {} },
    ];
    await streamFn?.(model as never, { systemPrompt: system, messages: [], tools } as never, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const ctx = events.find((e) => e.stage === "stream:context");
    expect(ctx?.boundaryFound).toBe(true);
    expect(typeof ctx?.stableDigest).toBe("string");
    expect(typeof ctx?.volatileDigest).toBe("string");
    expect(ctx?.stableDigest).not.toBe(ctx?.volatileDigest);
    expect(ctx?.toolsDigest).toBe(digestToolDefinitions([tools[1]!, tools[0]!]));
    const usage = events.find((e) => e.stage === "stream:usage");
    expect(usage?.usage).toEqual({ input: 10, output: 2, cacheRead: 5000, cacheWrite: 120 });
  });

  it("stable digest is unchanged when only the volatile half moves", () => {
    const lines: string[] = [];
    const trace = makeTrace(lines);
    trace?.recordStage("prompt:before", { system: `STABLE\n${CACHE_BOUNDARY_MARKER}\nV1` });
    trace?.recordStage("prompt:before", { system: `STABLE\n${CACHE_BOUNDARY_MARKER}\nV2` });
    const [a, b] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(a?.stableDigest).toBe(b?.stableDigest);
    expect(a?.volatileDigest).not.toBe(b?.volatileDigest);
  });
});
