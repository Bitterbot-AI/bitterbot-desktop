import { describe, expect, it } from "vitest";
import {
  extractPersonNames,
  extractRelationshipFromFact,
  relationTypeForText,
} from "./kg-relationship-extract.js";

describe("relationTypeForText", () => {
  it("maps management language to manages", () => {
    expect(relationTypeForText("Alice manages Bob")).toBe("manages");
    expect(relationTypeForText("Carol reports to Dave")).toBe("manages");
  });
  it("maps collaboration to works_on", () => {
    expect(relationTypeForText("Alice works on the parser")).toBe("works_on");
  });
  it("maps preference language to prefers", () => {
    expect(relationTypeForText("Bob prefers tea")).toBe("prefers");
  });
  it("maps acquaintance to knows", () => {
    expect(relationTypeForText("Alice met Bob at the conference")).toBe("knows");
  });
  it("falls back to related_to for unrecognized text", () => {
    expect(relationTypeForText("Alice and Bob exist")).toBe("related_to");
  });
});

describe("extractPersonNames", () => {
  it("pulls capitalized names from a sentence", () => {
    expect(extractPersonNames("Alice and Bob talked")).toEqual(["Alice", "Bob"]);
  });
  it("drops a standalone stop word", () => {
    expect(extractPersonNames("What did Bob say")).toEqual(["Bob"]);
  });
  it("ignores short tokens", () => {
    expect(extractPersonNames("Al met Bob")).toEqual(["Bob"]);
  });
});

describe("extractRelationshipFromFact", () => {
  it("pairs the leading two distinct persons with the typed relation", () => {
    const edge = extractRelationshipFromFact("Alice manages Bob");
    expect(edge).not.toBeNull();
    expect(edge?.sourceName).toBe("Alice");
    expect(edge?.targetName).toBe("Bob");
    expect(edge?.relationType).toBe("manages");
    expect(edge?.weight).toBe(0.5);
  });

  it("returns null when fewer than two distinct persons are present", () => {
    expect(extractRelationshipFromFact("Alice works alone")).toBeNull();
    expect(extractRelationshipFromFact("Alice and Alice")).toBeNull();
  });

  it("uses a low weight for the related_to fallback", () => {
    const edge = extractRelationshipFromFact("Alice and Bob exist together");
    expect(edge?.relationType).toBe("related_to");
    expect(edge?.weight).toBe(0.3);
  });

  it("does not fan out beyond the leading pair", () => {
    const edge = extractRelationshipFromFact("Alice manages Bob and Carol and Dave");
    // Only the first two distinct persons become an edge.
    expect(edge?.sourceName).toBe("Alice");
    expect(edge?.targetName).toBe("Bob");
  });
});
