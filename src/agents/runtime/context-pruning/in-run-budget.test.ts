/**
 * PLAN-52A in-run budget: the transform the loop calls before every model
 * call. It must hold recorded stubs, add stubs when the context passes the
 * trigger, persist each new batch once, and fall back to truncation only when
 * stubs cannot free enough.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createInRunBudgetTransform, installInRunBudget } from "./in-run-budget.js";
import { STUB_MARKER_PREFIX, type ToolOutputStub } from "./offload-stubs.js";

const user = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const assistant = (text: string, callId?: string): AgentMessage =>
  ({
    role: "assistant",
    content: [
      { type: "text", text },
      ...(callId ? [{ type: "toolCall", id: callId, name: "read", arguments: {} }] : []),
    ],
    timestamp: 1,
  }) as unknown as AgentMessage;
const toolResult = (callId: string, text: string): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  }) as unknown as AgentMessage;
const est = (m: AgentMessage) => {
  const c = (m as { content?: Array<{ text?: string }> }).content ?? [];
  return Math.ceil(c.reduce((n, b) => n + (b.text?.length ?? 0), 0) / 4);
};
const turn = (outputs: number, charsEach: number): AgentMessage[] => {
  const ms: AgentMessage[] = [user("read the files")];
  for (let i = 1; i <= outputs; i++) {
    ms.push(assistant(`reading ${i}`, `call-${i}`));
    ms.push(toolResult(`call-${i}`, `OUT-${i} ${"x".repeat(charsEach)}`));
  }
  return ms;
};
const textOf = (m: AgentMessage) =>
  (m as unknown as { content: Array<{ text: string }> }).content[0]!.text;

describe("createInRunBudgetTransform", () => {
  it("passes small contexts through untouched (same array)", () => {
    const persist = vi.fn();
    const t = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded: new Map(),
      persist,
    });
    const ms = turn(3, 400);
    expect(t(ms)).toBe(ms);
    expect(persist).not.toHaveBeenCalled();
  });

  it("stubs old tool outputs once the context passes the trigger, and persists the batch once", () => {
    const recorded = new Map<string, ToolOutputStub>();
    const persist = vi.fn();
    const events: unknown[] = [];
    const t = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded,
      persist,
      onApplied: (e) => events.push(e),
    });
    const ms = turn(6, 120_000); // ~180k tokens, over the 160k trigger
    const out = t(ms);
    expect(out).not.toBe(ms);
    const results = out.filter((m) => (m as { role: string }).role === "toolResult");
    expect(textOf(results[0]!).startsWith(STUB_MARKER_PREFIX)).toBe(true);
    expect(textOf(results[5]!).length).toBeGreaterThan(120_000); // newest intact
    expect(persist).toHaveBeenCalledTimes(1);
    expect((persist.mock.calls[0]![0] as ToolOutputStub[]).length).toBe(recorded.size);
    expect(events).toHaveLength(1);
    // The input (the loop's own array) is never mutated.
    expect(textOf(ms[2]!)).toContain("OUT-1");

    // Next model call of the same run: the loop passes the ORIGINAL messages
    // again (plus one more result). Recorded stubs still hold; nothing new is
    // persisted unless the context grows past the trigger again.
    const next = t([...ms, assistant("reading 7", "call-7"), toolResult("call-7", "small")]);
    const nextResults = next.filter((m) => (m as { role: string }).role === "toolResult");
    expect(textOf(nextResults[0]!).startsWith(STUB_MARKER_PREFIX)).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("holds stubs recorded in earlier turns even when the context is small", () => {
    const recorded = new Map<string, ToolOutputStub>([
      ["call-1", { toolCallId: "call-1", toolName: "read", chars: 99 }],
    ]);
    const t = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded,
      persist: vi.fn(),
    });
    const out = t(turn(2, 100));
    expect(textOf(out[2]!)).toContain("recall_range tool_call_id call-1");
  });

  it("counts the fixed share (system prompt) toward the trigger", () => {
    const persist = vi.fn();
    const ms = turn(5, 120_000); // ~150k: under 160k without the fixed share
    const without = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded: new Map(),
      persist,
    });
    without(ms);
    expect(persist).not.toHaveBeenCalled();
    const withFixed = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      fixedTokens: 20_000,
      estimate: est,
      recorded: new Map(),
      persist,
    });
    withFixed(ms);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("falls back to truncation when stubs cannot free enough, and respects the switches", () => {
    const ms = turn(2, 380_000); // two huge outputs, both spared
    const onApplied = vi.fn();
    const t = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded: new Map(),
      persist: vi.fn(),
      onApplied,
      // The default spare of two protects both outputs from stubbing; let
      // compression touch them by sparing none.
      settings: { compression: { spareRecentToolResults: 0 } },
    });
    const out = t(ms);
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ compressed: true, newStubs: 0 }),
    );
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(ms).length);

    const off = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded: new Map(),
      persist: vi.fn(),
      settings: { stubsEnabled: false, compressionEnabled: false },
    });
    const big = turn(6, 120_000);
    expect(off(big)).toBe(big);
  });

  it("a failing persist does not lose the stubs for this run", () => {
    const recorded = new Map<string, ToolOutputStub>();
    const t = createInRunBudgetTransform({
      contextWindowTokens: 200_000,
      estimate: est,
      recorded,
      persist: () => {
        throw new Error("disk full");
      },
    });
    const out = t(turn(6, 120_000));
    expect(recorded.size).toBeGreaterThan(0);
    expect(JSON.stringify(out)).toContain(STUB_MARKER_PREFIX);
  });
});

describe("installInRunBudget", () => {
  it("chains after the agent's existing transformContext", async () => {
    const seen: string[] = [];
    const agent = {
      transformContext: async (messages: AgentMessage[]) => {
        seen.push("previous");
        return [...messages, user("added by the previous hook")];
      },
    };
    installInRunBudget(agent, {
      contextWindowTokens: 200_000,
      estimate: est,
      recorded: new Map([["call-1", { toolCallId: "call-1", toolName: "read", chars: 5 }]]),
      persist: vi.fn(),
    });
    const out = await agent.transformContext(turn(1, 50));
    expect(seen).toEqual(["previous"]);
    expect(out).toHaveLength(4);
    expect(textOf(out[2]!)).toContain(STUB_MARKER_PREFIX);
  });

  it("works when the agent had no hook", async () => {
    const agent: { transformContext?: (m: AgentMessage[]) => Promise<AgentMessage[]> } = {};
    installInRunBudget(agent, {
      contextWindowTokens: 200_000,
      estimate: est,
      recorded: new Map(),
      persist: vi.fn(),
    });
    const ms = turn(1, 50);
    expect(await agent.transformContext!(ms)).toBe(ms);
  });
});
