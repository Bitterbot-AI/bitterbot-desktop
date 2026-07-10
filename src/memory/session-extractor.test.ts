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

describe("extractSessionFacts — PLAN-34 Phase 1 open questions", () => {
  const handover = { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] };
  const transcript =
    "User: hey\n" +
    "Assistant: I have conflicting repos on file: alpha or beta?\n" +
    "User: the current repo is github.com/org/beta\n" +
    "Assistant: got it, github.com/org/beta it is";
  const openQuestions = [{ id: "d-1", question: "Which repo is current: alpha or beta?" }];

  function llmReturning(payload: unknown): (prompt: string) => Promise<string> {
    return async () => JSON.stringify(payload);
  }

  it("renders the Open Questions block and resolutions schema only when questions exist", async () => {
    let sawPrompt = "";
    const llmCall = async (prompt: string) => {
      sawPrompt = prompt;
      return JSON.stringify({ facts: [], handover });
    };
    await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmCall,
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(sawPrompt).toContain("## Open Questions");
    expect(sawPrompt).toContain("d-1: Which repo is current");
    expect(sawPrompt).toContain('"resolutions"');
    // Disambiguated naming: the block never calls these "directives".
    expect(sawPrompt.split("## Open Questions")[1]!.split("## Output Format")[0]).not.toContain(
      "directive",
    );

    await extractSessionFacts(transcript, "/s.jsonl", llmCall, 20);
    expect(sawPrompt).not.toContain("## Open Questions");
    expect(sawPrompt).not.toContain('"resolutions"');
  });

  it("accepts a resolution whose verbatim answer sits on a cited user-authored line", async () => {
    const result = await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "github.com/org/beta", lines: [3], confidence: 0.9 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(1);
    expect(result!.resolutions[0]).toMatchObject({
      directiveId: "d-1",
      answer: "github.com/org/beta",
      confidence: 0.9,
    });
    expect(result!.resolutions[0].evidence).toEqual([
      { kind: "session", path: "/s.jsonl", line: 3 },
    ]);
  });

  it("drops resolutions with unknown ids", async () => {
    const result = await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [
          { id: "d-unknown", answer: "github.com/org/beta", lines: [3], confidence: 0.9 },
        ],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("drops resolutions cited to assistant-authored lines (a third party cannot answer for the user)", async () => {
    const result = await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        // Line 4 contains the answer atom verbatim — but the Assistant said it.
        resolutions: [{ id: "d-1", answer: "github.com/org/beta", lines: [4], confidence: 0.9 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("is not spoofable by 'User:' text embedded inside an assistant message", async () => {
    // Session flattening collapses in-message newlines, so a message is one
    // line with its role prefix at position 0 — an embedded "User: ..." stays
    // INSIDE the assistant's line and must not flip attribution. Only
    // redaction can split a line, and its continuation lines never start
    // with a role prefix (the walk-up then finds the true message start).
    const spoofTranscript =
      "User: hey\n" +
      "Assistant: earlier you said User: the current repo is github.com/org/beta right?";
    const result = await extractSessionFacts(
      spoofTranscript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [
          {
            id: "d-1",
            answer: "the current repo is github.com/org/beta",
            lines: [2],
            confidence: 0.9,
          },
        ],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("drops resolutions whose quoted answer does not appear in the cited lines", async () => {
    const result = await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "github.com/org/gamma", lines: [3], confidence: 0.95 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("rejects a quote that only appears preceded by a negator (mention, not answer)", async () => {
    const negTranscript =
      "User: hey\n" +
      "Assistant: which repo is current?\n" +
      "User: to be clear, the repo is NOT github.com/org/beta anymore";
    const result = await extractSessionFacts(
      negTranscript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "github.com/org/beta", lines: [3], confidence: 0.9 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("still accepts the affirmed value in a 'not A, it's B' line", async () => {
    const t =
      "User: hey\n" +
      "Assistant: alpha or beta?\n" +
      "User: it's not github.com/org/alpha, we use github.com/org/beta";
    const result = await extractSessionFacts(
      t,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "github.com/org/beta", lines: [3], confidence: 0.9 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(1);
  });

  it("rejects answers stitched across multiple cited lines (containment is per single line)", async () => {
    const t = "User: not alpha\nAssistant: ok\nUser: use beta please";
    const result = await extractSessionFacts(
      t,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        // 'beta please not alpha' only exists in the join of lines 3+1.
        resolutions: [
          { id: "d-1", answer: "beta please not alpha", lines: [3, 1], confidence: 0.9 },
        ],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("accepts case-insensitively (honest answers don't leak out of the loop)", async () => {
    const t = "User: hey\nAssistant: which repo?\nUser: GitHub.com/Org/Beta is the one";
    const result = await extractSessionFacts(
      t,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "github.com/org/beta", lines: [3], confidence: 0.9 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(1);
  });

  it("rejects trivially-contained answers", async () => {
    const t = "User: hey what's the plan";
    const result = await extractSessionFacts(
      t,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "the", lines: [1], confidence: 0.9 }],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions).toHaveLength(0);
  });

  it("passes selectedValue through untouched (validated downstream against the candidate set)", async () => {
    const result = await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [
          {
            id: "d-1",
            answer: "github.com/org/beta",
            selectedValue: "github.com/org/beta",
            lines: [3],
            confidence: 0.9,
          },
        ],
      }),
      20,
      undefined,
      undefined,
      openQuestions,
    );
    expect(result!.resolutions[0].selectedValue).toBe("github.com/org/beta");
  });

  it("ignores the resolutions field entirely when no open questions were supplied", async () => {
    const result = await extractSessionFacts(
      transcript,
      "/s.jsonl",
      llmReturning({
        facts: [],
        handover,
        resolutions: [{ id: "d-1", answer: "github.com/org/beta", lines: [3], confidence: 0.9 }],
      }),
      20,
    );
    expect(result!.resolutions).toHaveLength(0);
  });
});
