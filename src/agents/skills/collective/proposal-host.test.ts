import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ runner: vi.fn(), loaded: false }));
vi.mock("../../embedded-runner/run.js", () => {
  state.loaded = true;
  return { runEmbeddedPiAgent: state.runner };
});
vi.mock("../../embedded-runner/model.js", () => ({
  resolveModel: () => ({ model: { cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }),
}));
vi.mock("./sandbox-image.js", () => ({
  resolvePackageSandboxImage: async () => ({
    id: "sha256:" + "a".repeat(64),
    architecture: "amd64",
  }),
}));
import { learningHash } from "./contracts.js";
import { observePackageTrialTools } from "./execution-context.js";
import { snapshotPackage } from "./package.js";
import { CompletedProposalError, proposalContext } from "./proposal-context.js";
import { createPackageProposalHost, type PackageProposalExecution } from "./proposal-host.js";

const config = { skills: { collective: { validationModel: "fixture/model" } } };
const result = () => ({
  meta: { agentMeta: { provider: "fixture", model: "model", usage: { input: 10, output: 10 } } },
});
const parent = () =>
  snapshotPackage(path.resolve("test/fixtures/collective-learning/research-brief"), {
    name: "research-brief",
    description: "Source-backed briefs",
    requirements: { platforms: [], tools: {}, runtime: {}, capabilities: [] },
  });
beforeEach(() => {
  state.runner.mockReset();
});

it("loads the runner before returning a quote and starting a paid proposal", async () => {
  expect(state.loaded).toBe(false);
  const host = await createPackageProposalHost(config, "main");
  expect(state.loaded).toBe(true);
  expect(state.runner).not.toHaveBeenCalled();
  expect(host.quote.wallMs).toBe(150000);
  expect(host.preflightWallMs).toBeGreaterThanOrEqual(0);
});

it("supplies the immutable host public contract without checker internals or tasks", async () => {
  const contract = {
    id: "fixture",
    version: "1",
    instructions: "A missing required governor is an error; aliases never substitute for it.",
  };
  const hash = learningHash(contract);
  const host = await createPackageProposalHost(config, "main", { publicContract: contract });
  contract.instructions = "MUTATED AFTER HOST CREATION";
  state.runner.mockImplementation(
    async ({
      prompt,
      workspaceDir,
      timeoutMs,
    }: {
      prompt: string;
      workspaceDir: string;
      timeoutMs: number;
    }) => {
      expect(prompt).toContain("A missing required governor is an error");
      expect(prompt).not.toContain("MUTATED AFTER HOST CREATION");
      expect(prompt).toContain("must not override");
      expect(await fs.readdir(workspaceDir)).toEqual(["candidate", "observations.json", "skill"]);
      expect(timeoutMs).toBeLessThan(host.quote.wallMs);
      return result();
    },
  );
  expect(host.taskContractHash).toBe(hash);
  const generated = await host.propose(
    { parent: await parent(), evidence: [] },
    new AbortController().signal,
  );
  expect(generated.cost.providerUsd).toBeCloseTo(0.00002);
  expect(generated.tokens).toBe(20);
});

it("retains completed provider usage when generated package bytes are invalid", async () => {
  const host = await createPackageProposalHost(config, "main");
  let workspace = "";
  state.runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
    workspace = workspaceDir;
    await fs.unlink(path.join(workspaceDir, "candidate/SKILL.md"));
    return result();
  });
  const error = await host
    .propose({ parent: await parent(), evidence: [] }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CompletedProposalError);
  expect((error as CompletedProposalError).cost.providerUsd).toBeCloseTo(0.00002);
  expect(await fs.stat(workspace).catch(() => null)).toBeNull();
});

it("does not turn partial usage from an interrupted run into a settled cost", async () => {
  const host = await createPackageProposalHost(config, "main");
  state.runner.mockResolvedValue({ meta: { ...result().meta, aborted: true } });
  const error = await host
    .propose({ parent: await parent(), evidence: [] }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(CompletedProposalError);
  expect(error).toMatchObject({ message: "Proposal cost unresolved or interrupted" });
});

it("bounds public contracts and rejects undeclared checker/task fields", () => {
  expect(() =>
    proposalContext({ id: "x", version: "1", instructions: "x".repeat(8001) }),
  ).toThrow();
  expect(() =>
    proposalContext({
      id: "x",
      version: "1",
      instructions: "requirements",
      checker: "secret",
    } as never),
  ).toThrow();
  expect(proposalContext().taskContractHash).toBeUndefined();
  expect(proposalContext().prompt).toContain("No independent host task specification");
});

it("reserves the configured host deadline and rejects unbounded timeout settings", async () => {
  const host = await createPackageProposalHost(config, "main", { agentTimeoutMs: 300000 });
  expect(host.quote.wallMs).toBe(330000);
  expect(host.quote.toolCalls).toBe(20);
  state.runner.mockImplementation(async (params: { timeoutMs: number }) => {
    expect(params.timeoutMs).toBe(300000);
    return result();
  });
  await host.propose({ parent: await parent(), evidence: [] }, new AbortController().signal);
  for (const agentTimeoutMs of [0, 999, 600001, Infinity, NaN, 1200.5])
    await expect(createPackageProposalHost(config, "main", { agentTimeoutMs })).rejects.toThrow(
      "Invalid host-owned",
    );
  expect(state.runner).toHaveBeenCalledTimes(1);
});

it("retains bounded interrupted candidate bytes for host quarantine without settling partial usage", async () => {
  const events: PackageProposalExecution[] = [];
  const host = await createPackageProposalHost(config, "main", {
    onExecution: async (event) => {
      events.push(event);
    },
  });
  let workspace = "";
  state.runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
    workspace = workspaceDir;
    await fs.appendFile(
      path.join(workspaceDir, "candidate/SKILL.md"),
      "\nUnfinished generated change.\n",
    );
    return { meta: { ...result().meta, aborted: true } };
  });
  const error = await host
    .propose({ parent: await parent(), evidence: [] }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(CompletedProposalError);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    outcome: "interrupted",
    cost: null,
    candidateQualification: "unvalidated",
    observedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  });
  expect(events[0].candidate?.files.get("SKILL.md")?.toString()).toContain(
    "Unfinished generated change.",
  );
  expect(events[0]).not.toHaveProperty("transcript");
  expect(await fs.stat(workspace).catch(() => null)).toBeNull();
});

it("keeps successful generation immutable when host instrumentation changes its copy", async () => {
  const original = await parent();
  const host = await createPackageProposalHost(config, "main", {
    onExecution: async (event) => {
      expect(event.outcome).toBe("completed");
      expect(event.candidateQualification).toBe("unvalidated");
      event.candidate!.files.get("SKILL.md")!.fill(0);
      event.candidate!.manifest.description = "Mutated audit copy";
    },
  });
  state.runner.mockResolvedValue(result());
  const generated = await host.propose(
    { parent: original, evidence: [] },
    new AbortController().signal,
  );
  expect(generated.snapshot.packageHash).toBe(original.packageHash);
  expect(generated.snapshot.files.get("SKILL.md")).toEqual(original.files.get("SKILL.md"));
  expect(generated.snapshot.manifest.description).toBe(original.manifest.description);
});

it("never stages a candidate from a completed provider failure and retains its known cost", async () => {
  const events: PackageProposalExecution[] = [];
  const host = await createPackageProposalHost(config, "main", {
    onExecution: async (event) => {
      events.push(event);
    },
  });
  state.runner.mockResolvedValue({ meta: { ...result().meta, providerFailed: true } });
  const error = await host
    .propose({ parent: await parent(), evidence: [] }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CompletedProposalError);
  expect(events[0]).toMatchObject({
    outcome: "infrastructure",
    candidateQualification: "unvalidated",
  });
  expect(events[0].cost?.providerUsd).toBeCloseTo(0.00002);
});

it("settles completed work even if a diagnostic sink fails, and does not call the sink twice", async () => {
  const onExecution = vi.fn(async () => {
    throw new Error("audit sink unavailable");
  });
  const host = await createPackageProposalHost(config, "main", { onExecution });
  state.runner.mockResolvedValue(result());
  const error = await host
    .propose({ parent: await parent(), evidence: [] }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CompletedProposalError);
  expect((error as CompletedProposalError).cost.providerUsd).toBeCloseTo(0.00002);
  expect(onExecution).toHaveBeenCalledTimes(1);
});

it("cancels generation at tool exhaustion instead of allowing repeated model retries", async () => {
  const events: PackageProposalExecution[] = [];
  const host = await createPackageProposalHost(config, "main", {
    agentTimeoutMs: 300000,
    onExecution: async (event) => {
      events.push(event);
    },
  });
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ok" }],
    details: {},
  }));
  state.runner.mockImplementation(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
    const [tool] = observePackageTrialTools(
      [{ name: "exec", label: "test", description: "test", parameters: Type.Object({}), execute }],
      true,
    );
    for (let i = 0; i < 20; i++) await tool.execute(String(i), {});
    expect(abortSignal.aborted).toBe(false);
    await expect(tool.execute("excess", {})).rejects.toThrow("tool budget exhausted");
    expect(abortSignal.aborted).toBe(true);
    return result(); // Even an incorrectly non-aborted runner result must remain unqualified.
  });
  const error = await host
    .propose({ parent: await parent(), evidence: [] }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(CompletedProposalError);
  expect(execute).toHaveBeenCalledTimes(20);
  expect(events[0]).toMatchObject({
    outcome: "interrupted",
    toolCalls: 21,
    cost: null,
    candidateQualification: "unvalidated",
  });
});
