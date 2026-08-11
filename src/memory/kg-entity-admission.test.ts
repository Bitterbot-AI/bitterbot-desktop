/**
 * Knowledge-graph admission control.
 *
 * Every case here is a real entity or edge that existed in the live graph on
 * 2026-08-11, when 60 of 63 entities were typed `person` — including `are`,
 * `could`, `water`, truncated fragments, and the two halves of the IANA
 * timezone "America/Toronto". Precision over recall: a rejected candidate is a
 * non-event, an admitted junk entity poisons every future recall.
 */

import { describe, expect, it } from "vitest";
import {
  dropTruncatedFragments,
  isAdmissibleEntity,
  isAdmissibleEntityName,
  isAdmissibleEntityType,
  isAdmissibleRelation,
  looksMachineGenerated,
  maskNonEntitySpans,
  MIN_ENTITY_NAME_LENGTH,
} from "./kg-entity-admission.js";

describe("isAdmissibleEntityName", () => {
  it("rejects the exact junk that polluted the live graph", () => {
    for (const junk of [
      "are",
      "could",
      "which",
      "both",
      "can",
      "our",
      "old",
      "there",
      "given",
      "date",
      "modes",
      "mood",
      "user",
      "assistant",
      "system",
      "skills",
      "analyze",
      "examine",
      "explore",
      "identify",
      "investigate",
      "testing",
      "understanding",
      "clarifying",
      "generated",
      "processed",
      "sending",
      "working memory",
      "working memory state",
      "session handover brief",
      "dream cycle",
      "quarantined",
    ]) {
      expect(isAdmissibleEntityName(junk), `"${junk}" must be rejected`).toBe(false);
    }
  });

  it("admits plausible real entities", () => {
    for (const good of ["Donna", "Victor", "Toronto", "Bitterbot", "Home Assistant", "Circles"]) {
      expect(isAdmissibleEntityName(good), `"${good}" must be admitted`).toBe(true);
    }
  });

  it("enforces length bounds", () => {
    expect(isAdmissibleEntityName("Al")).toBe(false);
    expect(isAdmissibleEntityName("a".repeat(MIN_ENTITY_NAME_LENGTH))).toBe(true);
    expect(isAdmissibleEntityName("x".repeat(61))).toBe(false);
  });

  it("rejects prose and punctuation-laden fragments", () => {
    expect(isAdmissibleEntityName("the user requests to read the file")).toBe(false);
    expect(isAdmissibleEntityName("America/Toronto")).toBe(false);
    expect(isAdmissibleEntityName("~/.bitterbot/memory")).toBe(false);
    expect(isAdmissibleEntityName("1234")).toBe(false);
  });
});

describe("isAdmissibleEntityType", () => {
  it("accepts the vocabulary and refuses free-form types", () => {
    expect(isAdmissibleEntityType("person")).toBe(true);
    expect(isAdmissibleEntityType("location")).toBe(true);
    expect(isAdmissibleEntityType("summary")).toBe(false);
    expect(isAdmissibleEntityType("banana")).toBe(false);
  });
});

describe("maskNonEntitySpans", () => {
  it("masks the timezone that became two people", () => {
    const masked = maskNonEntitySpans("User is located in the America/Toronto timezone.");
    expect(masked).not.toContain("America");
    expect(masked).not.toContain("Toronto");
    // Length preserved so surrounding offsets/boundaries survive.
    expect(masked.length).toBe("User is located in the America/Toronto timezone.".length);
  });

  it("masks URLs, paths and ISO timestamps", () => {
    expect(maskNonEntitySpans("see https://Example.com/Docs now")).not.toContain("Example");
    expect(maskNonEntitySpans("at /home/Victor/Notes today")).not.toContain("Victor");
    expect(maskNonEntitySpans("on 2026-08-11T13:49:56Z ok")).not.toContain("2026-08-11");
  });
});

describe("dropTruncatedFragments", () => {
  it("drops mid-word slices beside their full form", () => {
    const out = dropTruncatedFragments([
      "Explo",
      "Explore",
      "Iden",
      "Identify",
      "Investiga",
      "Investigate",
      "Donna",
    ]);
    expect(out).toEqual(["Explore", "Identify", "Investigate", "Donna"]);
  });

  it("keeps distinct names that merely share a prefix boundary", () => {
    expect(dropTruncatedFragments(["Don", "Donna"])).toEqual(["Donna"]);
    expect(dropTruncatedFragments(["Toronto", "Boston"]).toSorted()).toEqual(["Boston", "Toronto"]);
  });
});

describe("looksMachineGenerated", () => {
  it("flags the agent's own output shapes", () => {
    expect(looksMachineGenerated("# Session Handover Brief\n**Date:** 2026-08-11")).toBe(true);
    expect(looksMachineGenerated("- [exploration] Could there be emotional triggers")).toBe(true);
    expect(looksMachineGenerated("**Working Memory State**")).toBe(true);
    expect(looksMachineGenerated("Dream-generated skill crystal")).toBe(true);
  });

  it("does not flag ordinary human statements", () => {
    expect(looksMachineGenerated("Donna is my wife and she works at the hospital")).toBe(false);
    expect(looksMachineGenerated("I live in Toronto")).toBe(false);
  });
});

describe("isAdmissibleEntity (combined)", () => {
  it("requires both a valid type and a valid name", () => {
    expect(isAdmissibleEntity("Donna", "person")).toBe(true);
    expect(isAdmissibleEntity("Donna", "summary")).toBe(false);
    expect(isAdmissibleEntity("could", "person")).toBe(false);
  });
});

describe("isAdmissibleRelation (type-pair constraints)", () => {
  it("permits sensible pairs", () => {
    expect(isAdmissibleRelation("person", "spouse_of", "person")).toBe(true);
    expect(isAdmissibleRelation("person", "located_at", "location")).toBe(true);
    expect(isAdmissibleRelation("person", "works_on", "project")).toBe(true);
    expect(isAdmissibleRelation("person", "uses", "tool")).toBe(true);
  });

  it("makes the live junk classes structurally inexpressible", () => {
    // "america (person) -[located_at]-> toronto (person)" — the timezone bug.
    expect(isAdmissibleRelation("person", "located_at", "person")).toBe(false);
    // "could (person) -[prefers]-> explo (person)" — the `like` discourse bug.
    expect(isAdmissibleRelation("person", "prefers", "person")).toBe(false);
    // A place cannot manage anything.
    expect(isAdmissibleRelation("location", "manages", "person")).toBe(false);
  });

  it("refuses the untyped related_to fallback entirely", () => {
    expect(isAdmissibleRelation("person", "related_to", "person")).toBe(false);
  });
});
