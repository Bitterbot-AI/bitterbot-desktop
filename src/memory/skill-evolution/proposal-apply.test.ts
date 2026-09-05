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

describe("description contract on proposals (PLAN-44 Phase 4a)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-contract-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const evidence = { runIds: ["r1"], origins: ["human"] };
  const LEGACY =
    "---\nname: web-nav\ndescription: navigate the web\n---\nStep 1: open page\nStep 2: read\n";

  it("refuses a create whose description cannot route", async () => {
    const r = await applyProposal(
      { action: "create", name: "web-nav", skillMd: LEGACY, purposeMd: "why" },
      { storeOpts: { configDir: tmpDir }, iteration: "it", evidence },
    );
    expect(r.outcome).toBe("gate-failed");
    expect(r.detail).toContain("description contract");
  });

  it("grandfathers a body patch over a legacy skill, but holds a rewritten description to the contract", async () => {
    const { liveSkillPath, resolveStorageRoots } =
      await import("../../agents/skills/skill-storage.js");
    const roots = resolveStorageRoots({ configDir: tmpDir });
    await fs.mkdir(path.dirname(liveSkillPath(roots, "web-nav")), { recursive: true });
    await fs.writeFile(liveSkillPath(roots, "web-nav"), LEGACY);
    const body = await applyProposal(
      {
        action: "patch",
        name: "web-nav",
        edits: [{ op: "append", content: "Step 3: read with retry" }],
      },
      { storeOpts: { configDir: tmpDir }, iteration: "it", evidence },
    );
    expect(body.outcome).toBe("staged");
    const desc = await applyProposal(
      {
        action: "patch",
        name: "web-nav",
        edits: [
          {
            op: "replace",
            target: "description: navigate the web",
            content: "description: browse",
          },
        ],
      },
      { storeOpts: { configDir: tmpDir }, iteration: "it", evidence },
    );
    expect(desc.outcome).toBe("gate-failed");
    expect(desc.detail).toContain("description contract");
  });
});

describe("harvested skills stay patchable (Phase 4a adversarial H3)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-harvest-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  it("a compliant description rewrite over an owner/repo-named -alt skill stages", async () => {
    const { liveSkillPath, resolveStorageRoots } =
      await import("../../agents/skills/skill-storage.js");
    const roots = resolveStorageRoots({ configDir: tmpDir });
    const name = "public-apis-public-apis-alt";
    await fs.mkdir(path.dirname(liveSkillPath(roots, name)), { recursive: true });
    await fs.writeFile(
      liveSkillPath(roots, name),
      "---\nname: public-apis/public-apis\ndescription: A collective list of free APIs\n---\nbody\n",
    );
    const r = await applyProposal(
      {
        action: "patch",
        name,
        edits: [
          {
            op: "replace",
            target: "description: A collective list of free APIs",
            content:
              "description: Look up a free public API when the user asks for an open data source; not for paid APIs.",
          },
        ],
      },
      {
        storeOpts: { configDir: tmpDir },
        iteration: "it",
        evidence: { runIds: ["r"], origins: ["human"] },
      },
    );
    expect(r.outcome).toBe("staged");
  });
});
