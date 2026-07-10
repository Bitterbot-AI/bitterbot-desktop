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

describe("extractSessionFacts — PLAN-33 Phase 2 canonical fields", () => {
  const handover = { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] };

  it("instructs the model about canonical key-value extraction", async () => {
    const llmCall = async (prompt: string) => {
      expect(prompt).toContain("canonicalKey");
      expect(prompt).toContain("canonicalValue");
      expect(prompt).toContain("Most facts are NOT canonical");
      return JSON.stringify({ facts: [], handover });
    };
    await extractSessionFacts("User: hi", "/s.jsonl", llmCall);
  });

  it("parses valid canonical fields into fact.canonical", async () => {
    const llmCall = async () =>
      JSON.stringify({
        facts: [
          {
            text: "The project repository is github.com/Bitterbot-AI/bitterbot-desktop.",
            layer: "world_fact",
            confidence: 0.95,
            lines: [1],
            canonicalKey: "project.repo",
            canonicalValue: "github.com/Bitterbot-AI/bitterbot-desktop",
          },
          { text: "We debugged the sync job.", layer: "experience", confidence: 0.8, lines: [2] },
        ],
        handover,
      });
    const result = await extractSessionFacts("a\nb", "/s.jsonl", llmCall);
    expect(result!.facts[0].canonical).toEqual({
      key: "project.repo",
      value: "github.com/Bitterbot-AI/bitterbot-desktop",
    });
    expect(result!.facts[1].canonical).toBeUndefined();
  });

  it("drops invalid canonical keys/values instead of rejecting the fact", async () => {
    const llmCall = async () =>
      JSON.stringify({
        facts: [
          {
            text: "f1",
            layer: "world_fact",
            confidence: 0.9,
            canonicalKey: "???",
            canonicalValue: "x",
          },
          {
            text: "f2",
            layer: "world_fact",
            confidence: 0.9,
            canonicalKey: "ok.key",
            canonicalValue: "  ",
          },
          {
            text: "f3",
            layer: "world_fact",
            confidence: 0.9,
            canonicalKey: 42,
            canonicalValue: "x",
          },
          {
            text: "f4",
            layer: "world_fact",
            confidence: 0.9,
            canonicalKey: "Ok Key",
            canonicalValue: "x",
          },
        ],
        handover,
      });
    const result = await extractSessionFacts("a", "/s.jsonl", llmCall);
    expect(result!.facts).toHaveLength(4); // facts themselves survive
    expect(result!.facts[0].canonical).toBeUndefined();
    expect(result!.facts[1].canonical).toBeUndefined();
    expect(result!.facts[2].canonical).toBeUndefined();
    // Normalizable key is accepted after slugification.
    expect(result!.facts[3].canonical).toEqual({ key: "ok_key", value: "x" });
  });
});
