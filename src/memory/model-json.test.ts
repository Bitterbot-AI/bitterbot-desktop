/**
 * The first JSON object of a model response. The raw strings marked "real"
 * are answers claude-haiku-4-5 gave on the correction lane during a replay
 * of the owner's transcripts (2026-11-27): each was thrown away as
 * "unusable" by the fence-stripping parsers this helper replaces.
 */
import { describe, expect, it } from "vitest";
import { extractFirstJsonObject, hasRetraction } from "./model-json.js";

const REAL_FENCED_THEN_PROSE =
  '```json\n{"kind":"other"}\n```\n\nThe follow-up is a new, separate request (running `deep_recall` with a specific REPL query) rather than asking for a missing element.';
const REAL_RETRACTED =
  '```json\n{"kind":"gap","missing":"Include step 1 confirmation"}\n```\n\nWait, let me reconsider. The follow-up is asking for a different query structure (one deep_recall call instead of two-step).';
const REAL_PROSE_THEN_JSON =
  'The follow-up asks about npm downloads, which is a different metric of repository performance.\n\nThis is a gap.\n\n```json\n{"kind":"gap","missing":"Include npm downloads"}\n```';

describe("extractFirstJsonObject", () => {
  it("takes a bare object, a fenced one, and one with prose before or after (real answers)", () => {
    expect(extractFirstJsonObject('{"kind":"other"}')).toEqual({
      value: { kind: "other" },
      rest: "",
    });
    expect(extractFirstJsonObject('```json\n{"kind":"other"}\n```')).toEqual({
      value: { kind: "other" },
      rest: "",
    });
    const fenced = extractFirstJsonObject(REAL_FENCED_THEN_PROSE);
    expect(fenced?.value).toEqual({ kind: "other" });
    expect(fenced?.rest.startsWith("The follow-up is a new, separate request")).toBe(true);
    expect(extractFirstJsonObject(REAL_PROSE_THEN_JSON)?.value).toEqual({
      kind: "gap",
      missing: "Include npm downloads",
    });
  });

  it("handles braces and escaped quotes inside strings, and nested objects", () => {
    const raw =
      'Here: {"statement":"use {curly} and \\"quotes\\" }","follow_up":{"kind":"other"}} done {"kind":"gap"}';
    expect(extractFirstJsonObject(raw)).toEqual({
      value: { statement: 'use {curly} and "quotes" }', follow_up: { kind: "other" } },
      rest: 'done {"kind":"gap"}',
    });
  });

  it("skips prose in braces and an object that never closes", () => {
    expect(extractFirstJsonObject('I weighed {a, b} and chose {"kind":"other"}.')?.value).toEqual({
      kind: "other",
    });
    expect(extractFirstJsonObject('{"kind":"gap","missing":"Include')).toBeNull();
    expect(extractFirstJsonObject('{"a": {"kind":"other"}')?.value).toEqual({ kind: "other" });
  });

  it("is null for no object, an array, or nothing", () => {
    for (const raw of ["", "not json", "[]", '["a"]', "```json\n```", "{not json}"]) {
      expect(extractFirstJsonObject(raw), raw).toBeNull();
    }
  });
});

describe("hasRetraction", () => {
  it("sees the model taking its answer back (real answer)", () => {
    expect(hasRetraction(extractFirstJsonObject(REAL_RETRACTED)!.rest)).toBe(true);
    expect(hasRetraction("Actually, this is a different task.")).toBe(true);
    expect(hasRetraction("On second thought the answer did contain it.")).toBe(true);
  });

  it("does not see one in a plain explanation", () => {
    expect(hasRetraction(extractFirstJsonObject(REAL_FENCED_THEN_PROSE)!.rest)).toBe(false);
    expect(hasRetraction("")).toBe(false);
    expect(hasRetraction("The owner waited for the npm numbers.")).toBe(false);
  });
});
