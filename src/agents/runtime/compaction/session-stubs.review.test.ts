/**
 * REVIEW (adversarial pass, PLAN-52A): stubs the session recorded earlier in
 * a run must still hold after a later compaction rebuilds the context from
 * the transcript. `applyCompaction` re-applies only the stubs of the current
 * result; the in-run budget's `recorded` map (attempt.ts) never learns about
 * stubs the session recorded, so nothing else puts them back in that run.
 * Fails on the current code.
 */
import { describe, expect, it } from "vitest";
import { collectStubRecords } from "../context-pruning/offload-stubs.js";
import { AgentSession } from "../session/session.js";
import { TranscriptStore } from "../transcript/store.js";
import type { CompactionPolicy } from "./policy.js";

const BIG = "B".repeat(8_000);

function toolResultText(messages: readonly unknown[]): string {
  const result = messages.find((m) => (m as { role?: string }).role === "toolResult") as
    | { content: Array<{ text: string }> }
    | undefined;
  return result?.content[0]?.text ?? "";
}

describe("REVIEW session stubs across a later compaction", () => {
  it("a tool output stubbed by an earlier stubs-only pass comes back in full after the next compaction", async () => {
    const store = TranscriptStore.inMemory("/w");
    const firstId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "read the file" }],
      timestamp: 1,
    });
    store.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-A", name: "read", arguments: { path: "/x" } }],
      provider: "anthropic",
      model: "claude-test",
      stopReason: "toolUse",
      timestamp: 2,
    });
    store.appendMessage({
      role: "toolResult",
      toolCallId: "call-A",
      toolName: "read",
      content: [{ type: "text", text: BIG }],
      timestamp: 3,
    });
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      provider: "anthropic",
      model: "claude-test",
      stopReason: "stop",
      timestamp: 4,
    });

    let calls = 0;
    const policy: CompactionPolicy = {
      name: "scripted",
      shouldCompact: () => false,
      compact: async () =>
        calls++ === 0
          ? // 1st pass (what the offload policy returns for an overflow inside one turn).
            {
              stubsOnly: true,
              stubs: [{ toolCallId: "call-A", toolName: "read", chars: BIG.length }],
            }
          : // 2nd pass: a cut that keeps the stubbed result in the window. The
            // planner counted it at 40 tokens (it is in `view.stubbedIds`),
            // so it does not list it again.
            { summary: "[Context offloaded] ...", firstKeptEntryId: firstId, tokensBefore: 1 },
    };
    const session = new AgentSession({
      model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 } as never,
      systemPrompt: "",
      tools: [],
      store: store as never,
      compactionPolicy: policy,
    });

    await session.compact().catch(() => {});
    expect(toolResultText(session.messages)).toMatch(/^\[tool output offloaded/);
    // The record is in the transcript.
    expect(collectStubRecords(store.getBranch()).has("call-A")).toBe(true);

    await session.compact();
    // Same run, same session object: the next model call is built from this.
    expect(toolResultText(session.messages)).toMatch(/^\[tool output offloaded/);
  });
});
