import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProposal, collectProposalEvidence } from "./proposal-apply.js";

describe("collectProposalEvidence (PLAN-44 Phase 3)", () => {
  const samples = [
    { trace: { runId: "r-human", task: { origin: "human" } } },
    { trace: { runId: "r-circle", task: { origin: "circle" } } },
    { trace: { runId: "r-old", sessionKey: "agent:main:main", task: null } },
    { trace: { runId: "r-old-circle", sessionKey: "agent:main:circle:c1", task: null } },
    { trace: { runId: "r-nokey", task: null } },
  ];

  it("keeps only trace reads that resolve to a sampled run, deduplicated, with sorted origins", () => {
    const evidence = collectProposalEvidence(
      ["index.md", "traces/r-circle", "traces/r-human", "traces/r-human", "traces/r-unknown"],
      samples,
    );
    expect(evidence).toEqual({ runIds: ["r-circle", "r-human"], origins: ["circle", "human"] });
  });

  it("classifies a pre-user-stream trace by its session key (adversarial M3), unknown only without one", () => {
    expect(collectProposalEvidence(["traces/r-old"], samples).origins).toEqual(["human"]);
    expect(collectProposalEvidence(["traces/r-old-circle"], samples).origins).toEqual(["circle"]);
    expect(collectProposalEvidence(["traces/r-nokey"], samples).origins).toEqual(["unknown"]);
    expect(collectProposalEvidence(["index.md"], samples)).toEqual({ runIds: [], origins: [] });
  });
});

describe("applyProposal refuses a proposal that cites no traces (adversarial M3)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-apply-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns invalid and stages nothing", async () => {
    const result = await applyProposal(
      {
        action: "create",
        name: "no-evidence",
        skillMd: "---\nname: no-evidence\ndescription: x\n---\n# body\nrule\n",
        purposeMd: "why",
      },
      { storeOpts: { configDir: tmpDir }, iteration: "it", evidence: { runIds: [], origins: [] } },
    );
    expect(result).toMatchObject({ outcome: "invalid", detail: "proposal cites no traces" });
    const entries = await fs.readdir(path.join(tmpDir, "skills-staging")).catch(() => []);
    expect(entries).toEqual([]);
  });
});
