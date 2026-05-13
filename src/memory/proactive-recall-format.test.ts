import { describe, expect, it } from "vitest";
import {
  formatProactiveFacts,
  MEMORY_FENCE_CLOSE_TAG,
  MEMORY_FENCE_OPEN_TAG,
  type ProactiveFact,
} from "./proactive-recall.js";

const facts: ProactiveFact[] = [
  { text: "user prefers dark mode", source: "preference", confidence: 0.9 },
  { text: "user is a neuroscientist", source: "preference", confidence: 0.3 },
];

describe("formatProactiveFacts", () => {
  it("returns empty string for no facts", () => {
    expect(formatProactiveFacts([])).toBe("");
    expect(formatProactiveFacts([], { wrapInMemoryFence: true })).toBe("");
  });

  it("formats facts as a bulleted block without fence by default", () => {
    const out = formatProactiveFacts(facts);
    expect(out).toContain("What you already know");
    expect(out).toContain("- user prefers dark mode");
    expect(out).toContain("- (uncertain) user is a neuroscientist");
    expect(out).not.toContain(MEMORY_FENCE_OPEN_TAG);
    expect(out).not.toContain(MEMORY_FENCE_CLOSE_TAG);
  });

  it("wraps the block in memory-context fence tags when requested", () => {
    const out = formatProactiveFacts(facts, { wrapInMemoryFence: true });
    expect(out.startsWith(MEMORY_FENCE_OPEN_TAG)).toBe(true);
    expect(out.endsWith(MEMORY_FENCE_CLOSE_TAG)).toBe(true);
    expect(out).toContain("- user prefers dark mode");
    expect(out).toContain("- (uncertain) user is a neuroscientist");
  });

  it("exports the canonical fence tag strings", () => {
    expect(MEMORY_FENCE_OPEN_TAG).toBe("<memory-context>");
    expect(MEMORY_FENCE_CLOSE_TAG).toBe("</memory-context>");
  });
});
