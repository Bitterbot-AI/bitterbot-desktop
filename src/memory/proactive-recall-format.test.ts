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

describe("formatProactiveFacts — dream-origin surfacing (PLAN-34 Phase 4)", () => {
  it("renders a dream-origin fact with the hypothesis marker and adds the header note", () => {
    const out = formatProactiveFacts([
      {
        text: "sparse coding may fold context",
        source: "crystal",
        confidence: 0.9,
        origin: "dream",
      },
    ]);
    expect(out).toContain("- (dream hypothesis) sparse coding may fold context");
    expect(out).toContain("may be shared as hunches, not facts");
  });

  it("marks by ORIGIN, not importance — a high-importance dream fact is still a hypothesis", () => {
    const out = formatProactiveFacts([
      { text: "confident confabulation", source: "crystal", confidence: 0.99, origin: "dream" },
    ]);
    expect(out).toContain("(dream hypothesis) confident confabulation");
    expect(out).not.toContain("- confident confabulation"); // never unmarked
  });

  it("caps dream hypotheses at 1 per turn; ordinary facts are unaffected", () => {
    const out = formatProactiveFacts([
      { text: "dream one", source: "crystal", confidence: 0.8, origin: "dream" },
      { text: "dream two", source: "crystal", confidence: 0.8, origin: "dream" },
      { text: "real fact", source: "crystal", confidence: 0.8, origin: "indexed" },
    ]);
    expect(out.match(/dream hypothesis/g)).toHaveLength(1);
    expect(out).toContain("dream one");
    expect(out).not.toContain("dream two");
    expect(out).toContain("- real fact");
  });

  it("no header note when there are no dream facts", () => {
    const out = formatProactiveFacts([
      { text: "real fact", source: "crystal", confidence: 0.8, origin: "indexed" },
    ]);
    expect(out).not.toContain("hunches");
  });
});
