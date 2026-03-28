import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  middleOutTruncate,
  truncateWithReference,
  compressOldMessages,
  getOriginalContent,
  clearTruncatedOriginals,
} from "./progressive-compression.js";

afterEach(() => {
  clearTruncatedOriginals();
});

// Helper to create a message with a given role and text content
function makeMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: text,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeToolResult(text: string, toolName = "read"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

describe("middleOutTruncate", () => {
  it("returns text unchanged if within limit", () => {
    const text = "short text";
    expect(middleOutTruncate(text, 100)).toBe(text);
  });

  it("truncates text with middle marker", () => {
    const text = "A".repeat(100);
    const result = middleOutTruncate(text, 40);
    expect(result).toContain("... [middle truncated] ...");
    expect(result.length).toBeLessThan(100);
    // Should start with first half and end with last half
    expect(result.startsWith("A".repeat(20))).toBe(true);
    expect(result.endsWith("A".repeat(20))).toBe(true);
  });

  it("handles edge case of maxChars=0", () => {
    const result = middleOutTruncate("hello", 0);
    expect(result).toContain("[middle truncated]");
  });
});

describe("truncateWithReference", () => {
  it("returns text unchanged if within limit", () => {
    const text = "short";
    expect(truncateWithReference(text, 100)).toBe(text);
  });

  it("truncates and stores reference", () => {
    const text = "X".repeat(200);
    const result = truncateWithReference(text, 50);
    expect(result).toContain("[Content truncated. Reference:");
    expect(result).toContain("use expand_message tool");

    // Extract the fingerprint from the result
    const match = result.match(/Reference: ([a-f0-9]+)/);
    expect(match).not.toBeNull();
    const fingerprint = match![1];

    // Verify original can be retrieved
    const original = getOriginalContent(fingerprint);
    expect(original).toBe(text);
  });
});

describe("compressOldMessages", () => {
  it("returns messages unchanged when under budget", () => {
    const messages = [
      makeMessage("user", "hello"),
      makeMessage("assistant", "hi"),
    ];
    const result = compressOldMessages(messages, 100_000);
    expect(result.messages).toEqual(messages);
    expect(result.totalCompressed).toBe(0);
    expect(result.passesRun).toBe(0);
  });

  it("returns messages unchanged when disabled", () => {
    const longText = "X".repeat(50_000);
    const messages = [makeToolResult(longText)];
    const result = compressOldMessages(messages, 100, { enabled: false });
    expect(result.totalCompressed).toBe(0);
  });

  it("compresses large tool results", () => {
    const longText = "X".repeat(50_000);
    const messages = [
      makeToolResult(longText, "read"),
      makeToolResult(longText, "read"),
      makeToolResult(longText, "read"),
      makeToolResult("recent", "read"),
      makeToolResult("most recent", "read"),
    ];
    const result = compressOldMessages(messages, 1000, {
      toolResultThreshold: 100,
      spareRecentToolResults: 2,
    });
    expect(result.totalCompressed).toBeGreaterThan(0);
    // The two most recent should be untouched
    expect(result.messages[3]).toBe(messages[3]);
    expect(result.messages[4]).toBe(messages[4]);
  });

  it("spares recent messages from compression", () => {
    const messages = [
      makeMessage("user", "X".repeat(20_000)),
      makeMessage("user", "Y".repeat(20_000)),
      makeMessage("user", "short recent message"),
    ];
    const result = compressOldMessages(messages, 500, {
      messageThreshold: 100,
      spareRecentMessages: 1,
    });
    // The last message should be untouched
    expect(result.messages[result.messages.length - 1]).toBe(
      messages[messages.length - 1],
    );
  });

  it("applies middle-out message removal when over middleOutMaxMessages", () => {
    // Use longer messages so they don't all get compressed to nothing
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `message number ${i} with some padding text`),
    );
    const result = compressOldMessages(messages, 1, {
      middleOutMaxMessages: 10,
      // Use higher thresholds so per-message compression doesn't trigger
      toolResultThreshold: 10_000,
      messageThreshold: 10_000,
      maxIterations: 1,
    });
    expect(result.messages.length).toBeLessThanOrEqual(10);
    // Middle-out preserves first 5 and last 5
    expect(result.messages.length).toBe(10);
  });

  it("runs compression passes when over budget", () => {
    // Use the same array content format as makeToolResult since
    // pi-coding-agent's estimateTokens may count string content differently
    const messages = [
      makeToolResult("X".repeat(50_000)),
      makeToolResult("Y".repeat(50_000)),
      makeToolResult("Z".repeat(50_000)),
      makeToolResult("W".repeat(50_000)),
      makeToolResult("V".repeat(50_000)),
    ];
    const result = compressOldMessages(messages, 10, {
      toolResultThreshold: 100,
      messageThreshold: 100,
      spareRecentToolResults: 0,
      spareRecentMessages: 0,
    });
    // At least some compression passes should run
    expect(result.passesRun).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
  });

  it("truncated messages have retrievable references", () => {
    const originalText = "Important content: " + "Z".repeat(50_000);
    const messages = [
      makeToolResult(originalText),
      makeToolResult("recent"),
    ];
    const result = compressOldMessages(messages, 500, {
      toolResultThreshold: 100,
      spareRecentToolResults: 1,
    });
    // The first message should be compressed with a reference
    const firstContent = result.messages[0] as unknown as {
      content: Array<{ text?: string }>;
    };
    const text = Array.isArray(firstContent.content)
      ? firstContent.content.map((b) => b.text ?? "").join("")
      : String(firstContent.content);
    const match = text.match(/Reference: ([a-f0-9]+)/);
    expect(match).not.toBeNull();
    const original = getOriginalContent(match![1]);
    expect(original).toBe(originalText);
  });
});
