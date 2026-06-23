import { describe, expect, it } from "vitest";
import {
  extractIdentityRelationship,
  extractPersonNames,
  extractRelationshipFromFact,
  FAMILY_RELATION_LABEL,
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

describe("extractIdentityRelationship (PLAN-27 family edges)", () => {
  const opts = { userName: "Victor" };

  it("extracts a possessive spouse fact -> person spouse_of user", () => {
    const edge = extractIdentityRelationship("User's wife is named Donna.", opts);
    expect(edge).not.toBeNull();
    expect(edge?.sourceName).toBe("Donna");
    expect(edge?.targetName).toBe("Victor");
    expect(edge?.relationType).toBe("spouse_of");
    expect(edge?.weight).toBe(0.85);
  });

  it("handles the predicate phrasing 'Donna is my wife'", () => {
    const edge = extractIdentityRelationship("Donna is my wife", opts);
    expect(edge?.sourceName).toBe("Donna");
    expect(edge?.targetName).toBe("Victor");
    expect(edge?.relationType).toBe("spouse_of");
  });

  it("maps kinship words to gender-neutral relation types", () => {
    expect(extractIdentityRelationship("My mom is Sarah", opts)?.relationType).toBe("parent_of");
    expect(extractIdentityRelationship("The user's son is named Max", opts)?.relationType).toBe(
      "child_of",
    );
    expect(extractIdentityRelationship("My sister is Jane", opts)?.relationType).toBe("sibling_of");
  });

  it("returns null for non-kinship or unknown-user text", () => {
    expect(extractIdentityRelationship("The user works on Bitterbot", opts)).toBeNull();
    expect(extractIdentityRelationship("User's wife is named Donna.", { userName: "" })).toBeNull();
  });

  it("guards against degenerate self-reference", () => {
    expect(extractIdentityRelationship("Victor is my brother", { userName: "Victor" })).toBeNull();
  });

  it("does NOT attribute third-party (his/her/their) kinship to the user", () => {
    // "her wife" / "his mom" are about someone else — never the user's edge.
    expect(
      extractIdentityRelationship("Her wife is named Donna", { userName: "Victor" }),
    ).toBeNull();
    expect(extractIdentityRelationship("His mother is Sarah", { userName: "Victor" })).toBeNull();
  });

  it("rejects a non-proper-noun captured name (no 'what' edges)", () => {
    // Regression: the case-insensitive keyword match must not let a lowercase
    // word slip through as a person name.
    expect(
      extractIdentityRelationship("Tell her the wife thing is what", { userName: "Victor" }),
    ).toBeNull();
  });

  it("exposes human labels for rendering", () => {
    expect(FAMILY_RELATION_LABEL.spouse_of).toBe("spouse");
    expect(FAMILY_RELATION_LABEL.parent_of).toBe("parent");
  });
});
