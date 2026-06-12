import { describe, expect, it } from "vitest";
import { extractSessionFacts } from "./session-extractor.js";

describe("extractSessionFacts — HORMA provenance citations", () => {
  it("attaches session evidence refs from the LLM's line citations", async () => {
    const transcript = "User: I use Postgres 16\nAssistant: noted\nUser: deploy to eu-west";
    const llmCall = async (prompt: string) => {
      // The prompt must present a line-numbered transcript so the model can cite.
      expect(prompt).toContain("L1: User: I use Postgres 16");
      expect(prompt).toContain("L3: User: deploy to eu-west");
      return JSON.stringify({
        facts: [
          { text: "User uses Postgres 16", layer: "world_fact", confidence: 0.9, lines: [1] },
          { text: "Deploy target is eu-west", layer: "directive", confidence: 0.8, lines: [3] },
        ],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    };

    const result = await extractSessionFacts(transcript, "/path/session.jsonl", llmCall);
    expect(result).not.toBeNull();
    expect(result!.facts).toHaveLength(2);
    expect(result!.facts[0].evidence).toEqual([
      { kind: "session", path: "/path/session.jsonl", line: 1 },
    ]);
    expect(result!.facts[1].evidence).toEqual([
      { kind: "session", path: "/path/session.jsonl", line: 3 },
    ]);
  });

  it("tolerates missing or malformed citations (evidence = [])", async () => {
    const llmCall = async () =>
      JSON.stringify({
        facts: [
          { text: "no citation", layer: "experience", confidence: 0.5 },
          { text: "bad citation", layer: "experience", confidence: 0.5, lines: "nope" },
        ],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    const result = await extractSessionFacts("User: hi", "/s.jsonl", llmCall);
    expect(result!.facts.every((f) => f.evidence.length === 0)).toBe(true);
  });

  it("de-duplicates and drops non-positive line numbers", async () => {
    const llmCall = async () =>
      JSON.stringify({
        facts: [{ text: "f", layer: "world_fact", confidence: 1, lines: [2, 2, 0, -1, 5] }],
        handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
      });
    const result = await extractSessionFacts("a\nb\nc\nd\ne", "/s.jsonl", llmCall);
    expect(result!.facts[0].evidence).toEqual([
      { kind: "session", path: "/s.jsonl", line: 2 },
      { kind: "session", path: "/s.jsonl", line: 5 },
    ]);
  });
});
