import { describe, expect, it } from "vitest";
import { circleIdentity, hueFor, leadingEmoji } from "./circle-identity";

// Phase B: circle identity is pure and stable — same circleId, same color,
// forever; the name's leading emoji (and only a LEADING one) claims the tile.

describe("hueFor", () => {
  it("is stable and inside the hue wheel", () => {
    expect(hueFor("circle-abc")).toBe(hueFor("circle-abc"));
    expect(hueFor("circle-abc")).toBeGreaterThanOrEqual(0);
    expect(hueFor("circle-abc")).toBeLessThan(360);
  });

  it("distinguishes sibling circles (the identical-tiles bug)", () => {
    // Not a universal guarantee (360 buckets), but these must not collide —
    // they're the shape auto-created circles actually take.
    expect(hueFor("bbc-1a2b3c")).not.toBe(hueFor("bbc-9z8y7x"));
  });
});

describe("leadingEmoji", () => {
  it("returns a leading emoji whole, including multi-codepoint clusters", () => {
    expect(leadingEmoji("🏔️ Tahoe")).toBe("🏔️");
    expect(leadingEmoji("👨‍👩‍👧 fam")).toBe("👨‍👩‍👧");
  });

  it("ignores non-leading emoji and plain names", () => {
    expect(leadingEmoji("Tahoe 🏔️")).toBeNull();
    expect(leadingEmoji("Bio 204")).toBeNull();
    expect(leadingEmoji("")).toBeNull();
  });
});

describe("circleIdentity", () => {
  it("shows the emoji when the name leads with one, initials otherwise", () => {
    const withEmoji = circleIdentity("c1", "🏔️ Tahoe Trip");
    expect(withEmoji.emoji).toBe("🏔️");
    // Initials skip the emoji so a fallback render never shows "🏔T".
    expect(withEmoji.initials).toBe("TT");
    const plain = circleIdentity("c1", "Bio 204");
    expect(plain.emoji).toBeNull();
    expect(plain.initials).toBe("B2");
  });

  it("derives gradient and accent from the circleId hue", () => {
    const id = circleIdentity("circle-abc", "Anything");
    expect(id.gradient).toContain(`hsl(${hueFor("circle-abc")} `);
    expect(id.accent).toBe(`hsl(${hueFor("circle-abc")} 62% 46%)`);
  });
});
