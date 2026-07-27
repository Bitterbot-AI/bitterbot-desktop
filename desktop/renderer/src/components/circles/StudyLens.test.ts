import { describe, expect, it } from "vitest";
import { parseStudyDraft } from "./StudyLens";

// PLAN-36 Phase 4b: parsing the study draft's pinned output format. The model
// is instructed to emit `Qn [<slot>] <question>` lines under QUIZ, then GAP
// MAP / NEXT REVIEW prose. The parser is lenient (a malformed draft still
// renders as text) but only well-formed, known-slot questions get mastery
// taps — checked by the caller against the card's real section slots.

const DRAFT = [
  "QUIZ",
  "Q1 [sec-b9b14b81] What does glycolysis yield per glucose?",
  "Q2 [sec-a34f5662] Where does the Krebs cycle run?",
  "not a question line",
  "GAP MAP",
  "sec-b9b14b81: shaky — redo the ATP accounting.",
  "NEXT REVIEW",
  "Glycolysis tomorrow, Krebs in 3d.",
].join("\n");

describe("parseStudyDraft", () => {
  it("extracts tagged questions and keeps GAP MAP onward as prose", () => {
    const { quiz, rest } = parseStudyDraft(DRAFT);
    expect(quiz).toEqual([
      { n: 1, slot: "sec-b9b14b81", question: "What does glycolysis yield per glucose?" },
      { n: 2, slot: "sec-a34f5662", question: "Where does the Krebs cycle run?" },
    ]);
    expect(rest).toContain("GAP MAP");
    expect(rest).toContain("NEXT REVIEW");
    // Question lines never leak into the prose block.
    expect(rest).not.toContain("Q1 [");
  });

  it("degrades to zero questions on a free-form draft (renders as plain text)", () => {
    const { quiz, rest } = parseStudyDraft("Here are some thoughts about the guide…");
    expect(quiz).toEqual([]);
    expect(rest).toBe("");
  });

  it("ignores a frame-breaking slot tag (charset gate)", () => {
    const { quiz } = parseStudyDraft("QUIZ\nQ1 [evil slot!] nope\nQ2 [sec-0806ea9e] ok?");
    expect(quiz).toEqual([{ n: 2, slot: "sec-0806ea9e", question: "ok?" }]);
  });
});
