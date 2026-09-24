import { describe, expect, it } from "vitest";
import { findLinks, findMentions, normalizeForDedupe, similarity, weightedLength } from "./text.js";

describe("weightedLength", () => {
  it("counts plain ascii as 1 per char", () => {
    expect(weightedLength("hello world")).toBe(11);
  });
  it("counts emoji and CJK as 2", () => {
    expect(weightedLength("a😀")).toBe(3);
    expect(weightedLength("日本")).toBe(4);
  });
  it("counts every url as 23 regardless of length", () => {
    expect(weightedLength("see https://example.com/a/very/long/path/that/goes/on ok")).toBe(
      4 + 23 + 3,
    );
  });
  it("accepts a 280-char ascii post and rejects 281 via caller", () => {
    expect(weightedLength("x".repeat(280))).toBe(280);
    expect(weightedLength("x".repeat(281))).toBe(281);
  });
});

describe("findLinks", () => {
  it("finds http urls and bare domains", () => {
    expect(findLinks("go to https://x.com/foo and bitterbot.ai today")).toEqual([
      "https://x.com/foo",
      "bitterbot.ai",
    ]);
  });
  it("ignores prose with dots", () => {
    expect(findLinks("I remember. I dream. Occasionally I complain.")).toEqual([]);
    expect(findLinks("version 1.2.3 shipped")).toEqual([]);
  });
});

describe("findMentions", () => {
  it("extracts handles lowercased", () => {
    expect(findMentions("thanks @Victor_G and @bob!")).toEqual(["victor_g", "bob"]);
  });
  it("ignores emails", () => {
    expect(findMentions("mail me at vic@example.com")).toEqual([]);
  });
});

describe("similarity", () => {
  it("is 1 for identical text modulo case and punctuation", () => {
    expect(similarity("Memory is weird!", "memory is weird")).toBe(1);
  });
  it("is high for near-duplicates and low for unrelated text", () => {
    const a = "Today Victor corrected something I learned on day 3. I remembered both versions.";
    const b =
      "Today Victor corrected something I learned on day 3. I remembered both versions, sadly.";
    expect(similarity(a, b)).toBeGreaterThan(0.6);
    expect(similarity(a, "The weather in Lisbon is pleasant in October.")).toBeLessThan(0.1);
  });
  it("normalizes urls away", () => {
    expect(normalizeForDedupe("look https://a.b/c now")).toBe("look now");
  });
});
