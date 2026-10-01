import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { CACHE_BOUNDARY_MARKER } from "../system-prompt-cache-boundary.js";
import {
  applyAnthropicCacheLayout,
  createAnthropicCacheLayoutWrapper,
  resolveAnthropicCacheControl,
} from "./anthropic-payload-cache.js";

type Block = { type: string; text?: string; cache_control?: { type: string; ttl?: string } };
type Tool = { name: string; cache_control?: { type: string; ttl?: string } };

function syntheticPayload() {
  // Exactly what pi-ai 0.52.12 builds: one marked system block, tools in
  // discovery order without markers, a marker on the last user block.
  return {
    model: "claude-opus-4-8",
    system: [
      {
        type: "text",
        text: `STABLE PART\nline two\n${CACHE_BOUNDARY_MARKER}\nVOLATILE PART\n## Runtime\nRuntime: x`,
        cache_control: { type: "ephemeral" },
      },
    ] as Block[],
    tools: [
      { name: "write", input_schema: {} },
      { name: "Read", input_schema: {} },
      { name: "exec", input_schema: {} },
      { name: "a2a_status", input_schema: {} },
    ] as Tool[],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
}

function markerCount(payload: ReturnType<typeof syntheticPayload>): number {
  const inTools = payload.tools.filter((t) => t.cache_control).length;
  const inSystem = payload.system.filter((b) => b.cache_control).length;
  const inMessages = payload.messages
    .flatMap((m) => m.content as Block[])
    .filter((b) => b.cache_control).length;
  return inTools + inSystem + inMessages;
}

function lastContent(payload: ReturnType<typeof syntheticPayload>): Block[] {
  const last = payload.messages[payload.messages.length - 1];
  return (last ? (last.content as Block[]) : []) ?? [];
}

describe("applyAnthropicCacheLayout", () => {
  it("splits system at the boundary: stable block marked, volatile half becomes an unmarked user tail", () => {
    const payload = syntheticPayload();
    const result = applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(result?.boundaryFound).toBe(true);
    expect(result?.volatilePlacement).toBe("user-tail");
    expect(payload.system).toHaveLength(1);
    expect(payload.system[0]?.text).toBe("STABLE PART\nline two");
    expect(payload.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    const tail = lastContent(payload);
    expect(tail).toHaveLength(2);
    expect(tail[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(tail[1]?.text).toBe(
      "<runtime-state>\nVOLATILE PART\n## Runtime\nRuntime: x\n</runtime-state>",
    );
    expect(tail[1]?.cache_control).toBeUndefined();
    // Idempotent: a second application does not stack a second tail.
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(lastContent(payload).length).toBe(2);
    expect(payload.system.some((b) => b.text?.includes(CACHE_BOUNDARY_MARKER))).toBe(false);
  });

  it("sorts tools by name in byte order and marks only the last one", () => {
    const payload = syntheticPayload();
    applyAnthropicCacheLayout(payload, { type: "ephemeral", ttl: "1h" });
    expect(payload.tools.map((t) => t.name)).toEqual(["Read", "a2a_status", "exec", "write"]);
    expect(payload.tools.slice(0, -1).every((t) => !t.cache_control)).toBe(true);
    expect(payload.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Tool marker TTL == stable system marker TTL (1h before 5m rule holds trivially).
    expect(payload.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps the total marker count at or under four; messages only gain the unmarked tail", () => {
    const payload = syntheticPayload();
    const before = JSON.stringify(payload.messages);
    const result = applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(markerCount(payload)).toBe(3); // tools + stable system + last user
    expect(result?.markerCount).toBe(3);
    const after = payload.messages.map((m) => ({
      ...m,
      content: (m.content as Block[]).filter((b) => !b.text?.startsWith("<runtime-state>")),
    }));
    expect(JSON.stringify(after)).toBe(before);
  });

  it("OAuth shape (identity block + prompt block) stays within four markers", () => {
    const payload = syntheticPayload();
    payload.system.unshift({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral" },
    });
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(payload.system).toHaveLength(2);
    expect(payload.system[0]?.cache_control).toBeDefined();
    expect(payload.system[1]?.cache_control).toBeDefined();
    expect(markerCount(payload)).toBe(4);
  });

  it("sheds surplus markers from non-stable system blocks first, never the stable block", () => {
    const payload = syntheticPayload();
    payload.system.unshift(
      { type: "text", text: "extra-1", cache_control: { type: "ephemeral" } },
      { type: "text", text: "extra-2", cache_control: { type: "ephemeral" } },
    );
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(markerCount(payload)).toBeLessThanOrEqual(4);
    const stable = payload.system.find((b) => b.text === "STABLE PART\nline two");
    expect(stable?.cache_control).toBeDefined();
    expect(payload.tools.at(-1)?.cache_control).toBeDefined();
  });

  it("without a boundary only sorts tools and adds the tool marker", () => {
    const payload = syntheticPayload();
    payload.system = [{ type: "text", text: "plain prompt", cache_control: { type: "ephemeral" } }];
    const result = applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(result?.boundaryFound).toBe(false);
    expect(payload.system).toHaveLength(1);
    expect(payload.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(payload.tools.map((t) => t.name)).toEqual(["Read", "a2a_status", "exec", "write"]);
    expect(payload.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent", () => {
    const payload = syntheticPayload();
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    const once = JSON.stringify(payload);
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(JSON.stringify(payload)).toBe(once);
  });

  it("retention none: no markers are placed, the boundary line is still consumed", () => {
    const payload = syntheticPayload();
    payload.system[0]!.cache_control = undefined;
    payload.messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    applyAnthropicCacheLayout(payload, undefined);
    expect(markerCount(payload)).toBe(0);
    expect(payload.system).toHaveLength(1);
    expect(payload.tools.at(-1)?.cache_control).toBeUndefined();
  });

  it("string system prompts are accepted", () => {
    const payload = {
      system: `S\n${CACHE_BOUNDARY_MARKER}\nV`,
      tools: [] as Tool[],
      messages: [],
    };
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(payload.system).toEqual([
      { type: "text", text: "S", cache_control: { type: "ephemeral" } },
      { type: "text", text: "V" },
    ]);
  });

  it("ignores non-object payloads", () => {
    expect(applyAnthropicCacheLayout(undefined, { type: "ephemeral" })).toBeUndefined();
    expect(applyAnthropicCacheLayout("x", { type: "ephemeral" })).toBeUndefined();
  });
});

describe("resolveAnthropicCacheControl", () => {
  it("mirrors pi-ai: 1h only for long retention on api.anthropic.com", () => {
    expect(resolveAnthropicCacheControl({ retention: "none" })).toBeUndefined();
    expect(resolveAnthropicCacheControl({ retention: "short" })).toEqual({ type: "ephemeral" });
    expect(
      resolveAnthropicCacheControl({ retention: "long", baseUrl: "https://api.anthropic.com" }),
    ).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(
      resolveAnthropicCacheControl({ retention: "long", baseUrl: "https://proxy.example" }),
    ).toEqual({ type: "ephemeral" });
  });
});

describe("createAnthropicCacheLayoutWrapper", () => {
  const context = { messages: [], systemPrompt: "x" } as unknown as Context;

  it("applies the layout through onPayload for anthropic-messages models and chains the original hook", () => {
    let captured: SimpleStreamOptions | undefined;
    const base: StreamFn = (_model, _context, options) => {
      captured = options;
      return new AssistantMessageEventStream();
    };
    const wrapped = createAnthropicCacheLayoutWrapper(base, "long");
    const seen: unknown[] = [];
    const model = { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } as Model;
    void wrapped(model, context, { onPayload: (p) => seen.push(p) });
    const payload = syntheticPayload();
    captured?.onPayload?.(payload);
    expect(seen).toHaveLength(1);
    expect(payload.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(payload.system).toHaveLength(1);
  });

  it("passes other providers through untouched", () => {
    let captured: SimpleStreamOptions | undefined;
    const base: StreamFn = (_model, _context, options) => {
      captured = options;
      return new AssistantMessageEventStream();
    };
    const wrapped = createAnthropicCacheLayoutWrapper(base, "short");
    const original = { onPayload: () => undefined };
    void wrapped({ api: "openai-completions" } as Model, context, original);
    expect(captured?.onPayload).toBe(original.onPayload);
  });
});

describe("volatile tail fallback", () => {
  it("falls back to a second system block when there is no user message", () => {
    const payload = syntheticPayload();
    payload.messages = [];
    const result = applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(result?.volatilePlacement).toBe("system");
    expect(payload.system).toHaveLength(2);
    expect(payload.system[1]?.cache_control).toBeUndefined();
  });

  it("attaches the tail after tool_result blocks in a tool-loop user message", () => {
    const payload = syntheticPayload();
    payload.messages = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [{ type: "tool_result", text: "", cache_control: { type: "ephemeral" } } as Block],
      },
    ];
    const result = applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(result?.volatilePlacement).toBe("user-tail");
    const last = lastContent(payload);
    expect(last[0]?.type).toBe("tool_result");
    expect(last[1]?.text?.startsWith("<runtime-state>")).toBe(true);
    expect((payload.messages[0] as { content: Block[] }).content.length).toBe(1);
  });
});

describe("deferred tools (native tool search)", () => {
  it("marker goes on the last non-deferred custom tool; a deferred tool never carries cache_control", () => {
    const payload = syntheticPayload();
    (payload.tools as Array<Tool & { defer_loading?: boolean; type?: string }>).push(
      { name: "zeta_deferred", defer_loading: true },
      { name: "tool_search_tool_bm25", type: "tool_search_tool_bm25_20251119" },
    );
    (payload.tools[0] as Tool & { defer_loading?: boolean }).defer_loading = true; // "write"
    const result = applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    const marked = payload.tools.filter((t) => t.cache_control).map((t) => t.name);
    expect(marked).toEqual(["exec"]);
    expect(payload.tools.map((t) => t.name)).toEqual([
      "Read",
      "a2a_status",
      "exec",
      "tool_search_tool_bm25",
      "write",
      "zeta_deferred",
    ]);
    expect(result?.deferredToolCount).toBe(2);
    expect(result?.markerCount).toBe(3);
  });

  it("falls back to the server-tool entry when it is the only non-deferred tool", () => {
    const payload = syntheticPayload();
    for (const tool of payload.tools as Array<Tool & { defer_loading?: boolean }>) {
      tool.defer_loading = true;
    }
    (payload.tools as Array<Tool & { type?: string }>).push({
      name: "tool_search_tool_bm25",
      type: "tool_search_tool_bm25_20251119",
    });
    applyAnthropicCacheLayout(payload, { type: "ephemeral" });
    expect(payload.tools.filter((t) => t.cache_control).map((t) => t.name)).toEqual([
      "tool_search_tool_bm25",
    ]);
  });
});
