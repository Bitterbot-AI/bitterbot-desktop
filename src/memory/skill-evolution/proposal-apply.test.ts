import { describe, expect, it } from "vitest";
import { collectProposalEvidence } from "./proposal-apply.js";

describe("collectProposalEvidence (PLAN-44 Phase 3)", () => {
  const samples = [
    { trace: { runId: "r-human", task: { origin: "human" } } },
    { trace: { runId: "r-circle", task: { origin: "circle" } } },
    { trace: { runId: "r-old", task: null } },
  ];

  it("keeps only trace reads that resolve to a sampled run, deduplicated, with sorted origins", () => {
    const evidence = collectProposalEvidence(
      ["index.md", "traces/r-circle", "traces/r-human", "traces/r-human", "traces/r-unknown"],
      samples,
    );
    expect(evidence).toEqual({ runIds: ["r-circle", "r-human"], origins: ["circle", "human"] });
  });

  it("marks a pre-user-stream trace as unknown origin and reads nothing as empty evidence", () => {
    expect(collectProposalEvidence(["traces/r-old"], samples)).toEqual({
      runIds: ["r-old"],
      origins: ["unknown"],
    });
    expect(collectProposalEvidence(["index.md"], samples)).toEqual({ runIds: [], origins: [] });
  });
});
