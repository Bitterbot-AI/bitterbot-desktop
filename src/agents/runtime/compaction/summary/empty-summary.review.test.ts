/**
 * REVIEW (adversarial pass): a summary call that ends without text (output
 * budget spent on thinking, or a provider-side abort that is not the caller's
 * signal) yields an EMPTY summary, which the session then persists as the
 * compaction entry: the history before the cut is replaced by nothing.
 * pi 0.73.1 behaves the same ("only stopReason error throws"); the port keeps
 * it on purpose. Fails on the current code.
 */
import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "./index.js";

const entry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
  type: "message" as const,
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message,
});

describe("REVIEW summary compaction", () => {
  it("must not produce a compaction with an empty summary when the model returned no text", async () => {
    const path = [
      entry("u1", null, { role: "user", content: [{ type: "text", text: "q".repeat(8_000) }] }),
      entry("a1", "u1", {
        role: "assistant",
        content: [{ type: "text", text: "a".repeat(8_000) }],
        stopReason: "stop",
      }),
      entry("u2", "a1", { role: "user", content: [{ type: "text", text: "q".repeat(8_000) }] }),
      entry("a2", "u2", {
        role: "assistant",
        content: [{ type: "text", text: "a".repeat(8_000) }],
        stopReason: "stop",
      }),
    ];
    const prep = prepareCompaction(path as never, {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 3_000,
    })!;
    expect(prep.messagesToSummarize.length).toBeGreaterThan(0);
    const run = compact(prep, {
      model: { provider: "p", id: "m", reasoning: true } as never,
      thinkingLevel: "high",
      // All output tokens went to thinking; no text block.
      complete: async () =>
        ({
          role: "assistant",
          content: [{ type: "thinking", thinking: "…" }],
          stopReason: "length",
        }) as never,
    });
    await expect(run).rejects.toThrow();
  });
});
