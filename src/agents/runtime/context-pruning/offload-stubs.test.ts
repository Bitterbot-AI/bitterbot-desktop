/**
 * PLAN-52A tool-output stubs: planning, application, the prune record, and the
 * mid-turn guard using them. The scenario mirrors the sessions that actually
 * overflowed: one turn with several 80 to 280 KB tool outputs.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { applyMidTurnBudget } from "../../embedded-runner/mid-turn-budget.js";
import {
  applyStubsToMessages,
  buildPruneRecordData,
  collectStubRecords,
  planMessageStubs,
  PRUNE_RECORD_CUSTOM_TYPE,
  renderStubText,
  STUB_MARKER_PREFIX,
} from "./offload-stubs.js";

const user = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const assistant = (text: string, callId?: string): AgentMessage =>
  ({
    role: "assistant",
    content: [
      { type: "text", text },
      ...(callId
        ? [{ type: "toolCall", id: callId, name: "read", arguments: { path: "/x" } }]
        : []),
    ],
    timestamp: 1,
  }) as unknown as AgentMessage;
const toolResult = (callId: string, text: string, toolName = "read"): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  }) as unknown as AgentMessage;

const est = (m: AgentMessage) => {
  const c = (m as { content?: Array<{ text?: string }> }).content ?? [];
  return Math.ceil(c.reduce((n, b) => n + (b.text?.length ?? 0), 0) / 4);
};
const total = (ms: AgentMessage[]) => ms.reduce((n, m) => n + est(m), 0);

function agenticTurn(outputs: number, charsEach: number): AgentMessage[] {
  const ms: AgentMessage[] = [user("read the config files and compare them")];
  for (let i = 1; i <= outputs; i++) {
    ms.push(assistant(`reading ${i}`, `call-${i}`));
    ms.push(toolResult(`call-${i}`, `OUTPUT-${i} ${"x".repeat(charsEach)}`));
  }
  ms.push(assistant("done"));
  return ms;
}

describe("planMessageStubs", () => {
  it("stubs oldest first, spares the newest two, stops at the target", () => {
    const ms = agenticTurn(5, 40_000); // 5 x ~10k tokens
    const stubs = planMessageStubs({
      messages: ms,
      estimate: est,
      totalTokens: total(ms),
      targetTokens: 35_000,
    });
    expect(stubs.map((s) => s.toolCallId)).toEqual(["call-1", "call-2"]);
    expect(stubs[0]!.toolName).toBe("read");
    expect(stubs[0]!.chars).toBeGreaterThan(40_000);
  });

  it("never stubs the newest two even when far over target", () => {
    const ms = agenticTurn(4, 40_000);
    const stubs = planMessageStubs({
      messages: ms,
      estimate: est,
      totalTokens: total(ms),
      targetTokens: 1,
    });
    expect(stubs.map((s) => s.toolCallId)).toEqual(["call-1", "call-2"]);
  });

  it("skips small outputs and already-stubbed ones", () => {
    const ms: AgentMessage[] = [
      user("go"),
      assistant("a", "c1"),
      toolResult("c1", "tiny"),
      assistant("b", "c2"),
      toolResult("c2", renderStubText({ toolCallId: "c2", toolName: "read", chars: 99_999 })),
      assistant("c", "c3"),
      toolResult("c3", "y".repeat(40_000)),
      assistant("d", "c4"),
      toolResult("c4", "z".repeat(40_000)),
      assistant("e", "c5"),
      toolResult("c5", "w".repeat(40_000)),
    ];
    const stubs = planMessageStubs({
      messages: ms,
      estimate: est,
      totalTokens: total(ms),
      targetTokens: 1,
    });
    expect(stubs.map((s) => s.toolCallId)).toEqual(["c3"]);
  });

  it("returns nothing when already under target", () => {
    const ms = agenticTurn(3, 400);
    expect(
      planMessageStubs({ messages: ms, estimate: est, totalTokens: total(ms), targetTokens: 1e9 }),
    ).toEqual([]);
  });
});

describe("applyStubsToMessages", () => {
  it("replaces only the stubbed tool results, keeps pairing, and is idempotent", () => {
    const ms = agenticTurn(3, 40_000);
    const stubs = new Map([["call-1", { toolCallId: "call-1", toolName: "read", chars: 40_009 }]]);
    const once = applyStubsToMessages(ms, stubs);
    expect(once.applied).toBe(1);
    const stubbed = once.messages[2] as unknown as {
      role: string;
      toolCallId: string;
      content: Array<{ text: string }>;
    };
    expect(stubbed.role).toBe("toolResult");
    expect(stubbed.toolCallId).toBe("call-1");
    expect(stubbed.content[0]!.text.startsWith(STUB_MARKER_PREFIX)).toBe(true);
    expect(stubbed.content[0]!.text).toContain("recall_range tool_call_id call-1");
    // Untouched messages keep their identity; the input is not mutated.
    expect(once.messages[4]).toBe(ms[4]);
    expect((ms[2] as unknown as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "OUTPUT-1",
    );
    const twice = applyStubsToMessages(once.messages, stubs);
    expect(twice.applied).toBe(0);
  });
});

describe("prune record round trip", () => {
  it("collects stubs from custom entries on the branch and ignores other entries", () => {
    const data = buildPruneRecordData(
      [{ toolCallId: "c1", toolName: "exec", chars: 123 }],
      "mid-turn",
    );
    expect(data).toEqual({
      version: 1,
      trigger: "mid-turn",
      stubs: [{ toolCallId: "c1", kind: "tool_result", chars: 123, toolName: "exec" }],
    });
    const records = collectStubRecords([
      { type: "message" },
      { type: "custom", customType: "bitterbot.cache-ttl", data: {} },
      { type: "custom", customType: PRUNE_RECORD_CUSTOM_TYPE, data },
      {
        type: "custom",
        customType: PRUNE_RECORD_CUSTOM_TYPE,
        data: {
          version: 1,
          stubs: [
            { entryId: "e9", kind: "heartbeat_pair", chars: 1 },
            { toolCallId: "c2", kind: "tool_result", chars: 5 },
          ],
        },
      },
    ]);
    expect([...records.keys()]).toEqual(["c1", "c2"]);
    expect(records.get("c1")!.toolName).toBe("exec");
  });
});

describe("applyMidTurnBudget with stubs", () => {
  const window = 200_000;
  // 6 outputs x ~30k tokens = ~180k: over the 80% trigger (160k).
  const build = () => {
    const messages = agenticTurn(6, 120_000);
    return { messages, agent: { state: { messages } } };
  };

  it("stubs instead of truncating, returns the stubs, and leaves recent outputs whole", () => {
    const session = build();
    const result = applyMidTurnBudget({
      session,
      contextWindowTokens: window,
      stubConfig: { enabled: true },
    });
    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.method).toBe("stubs");
    expect(result.stubs!.length).toBeGreaterThanOrEqual(3);
    expect(result.tokensAfter).toBeLessThanOrEqual(window * 0.65);
    const after = session.agent.state.messages as unknown as Array<{
      role: string;
      toolCallId?: string;
      content: Array<{ text: string }>;
    }>;
    const results = after.filter((m) => m.role === "toolResult");
    expect(results[0]!.content[0]!.text.startsWith(STUB_MARKER_PREFIX)).toBe(true);
    // The two newest outputs are intact (no truncation marker, full length).
    expect(results[results.length - 1]!.content[0]!.text.length).toBeGreaterThan(120_000);
    expect(results[results.length - 2]!.content[0]!.text.length).toBeGreaterThan(120_000);
    // Nothing was truncated the old way.
    expect(JSON.stringify(after)).not.toContain("Content truncated. Reference:");
  });

  it("keeps the old behaviour when stubs are disabled", () => {
    const session = build();
    const result = applyMidTurnBudget({ session, contextWindowTokens: window });
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.method).toBe("compression");
      expect(result.stubs).toBeUndefined();
    }
  });

  it("falls back to compression on top of stubs when stubs cannot reach the target", () => {
    // Two huge outputs only: both are spared, so stubs free nothing.
    const messages = agenticTurn(2, 360_000);
    const session = { messages, agent: { state: { messages } } };
    const result = applyMidTurnBudget({
      session,
      contextWindowTokens: window,
      stubConfig: { enabled: true },
    });
    if (result.applied) {
      expect(["compression", "stubs+compression"]).toContain(result.method);
    } else {
      expect(result.reason).toBe("compression made no progress");
    }
  });
});
