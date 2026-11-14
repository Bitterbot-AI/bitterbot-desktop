import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchBriefExecution, ResearchBriefHostOptions } from "./research-brief.js";
const runner = vi.hoisted(() => vi.fn());
vi.mock("../../embedded-runner/run.js", () => ({ runEmbeddedPiAgent: runner }));
vi.mock("../../embedded-runner/model.js", () => ({
  resolveModel: () => ({
    model: { id: "model", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
  }),
}));
import { sha256 } from "./contracts.js";
import { snapshotPackage } from "./package.js";
import {
  RESEARCH_BRIEF_TASK_CONTRACT,
  RESEARCH_BRIEF_TASK_CONTRACT_HASH,
} from "./research-brief-contract.js";
import { createResearchBriefHost } from "./research-brief.js";

beforeEach(() => {
  runner.mockReset();
});

it("checks and records captured artifacts without requiring brief outputs or exposing the checker", async () => {
  const reports: ResearchBriefExecution[] = [];
  const bytes = Buffer.from([0, 255, 42]);
  runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
    expect(await fs.readdir(workspaceDir)).toEqual(["sources.json"]);
    await fs.writeFile(path.join(workspaceDir, "answer.pdf"), bytes);
    return {
      meta: {
        agentMeta: { provider: "fixture", model: "model", usage: { input: 10, output: 10 } },
      },
    };
  });
  const protocol = {
    ...customProtocol(),
    artifacts: {
      timeoutMs: 10000,
      files: [{ name: "answer.pdf", maxBytes: 100 }],
      check: (_task: unknown, files: readonly { bytes: Buffer; sha256: string }[]) => {
        expect(files[0].bytes).toEqual(bytes);
        expect(files[0].sha256).toBe(sha256(bytes));
        files[0].bytes.fill(0); // Audit bytes must survive even a defective host checker.
        return true;
      },
    },
  };
  const host = await createResearchBriefHost(
    { skills: { collective: { validationModel: "fixture/model" } } },
    "main",
    "node",
    "seed",
    { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
    {
      protocol,
      tasks: [{ id: "artifact", family: "artifact", regression: false, input: { public: 42 } }],
      onExecution: async (e) => {
        reports.push(e);
      },
    },
  );
  expect((await host.execute(host.tasks[0], null, new AbortController().signal)).outcome).toBe(
    "pass",
  );
  expect(reports[0].artifacts?.[0].bytes).toEqual(bytes);
  expect(host.publicContract).toEqual({
    id: protocol.id,
    version: protocol.version,
    instructions: protocol.prompt,
  });
  expect(JSON.stringify(host.publicContract)).not.toContain("checkerHash");
  expect(reports[0].brief).toBeNull();
  const changed = await customHost({
    ...protocol,
    artifacts: { ...protocol.artifacts, files: [{ name: "answer.pdf", maxBytes: 101 }] },
  });
  expect(host.environment.runtime.taskContract).not.toBe(changed.environment.runtime.taskContract);
});

it("distinguishes invalid artifacts from a broken artifact checker and retains known costs", async () => {
  runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
    await fs.writeFile(path.join(workspaceDir, "answer.pdf"), "123");
    return {
      meta: {
        agentMeta: { provider: "fixture", model: "model", usage: { input: 10, output: 10 } },
      },
    };
  });
  for (const [maxBytes, check, outcome] of [
    [2, () => true, "task-failure"],
    [3, () => false, "task-failure"],
    [3, () => "infrastructure" as const, "infrastructure"],
    [3, () => "checker-invalid" as const, "checker-invalid"],
    [
      3,
      () => {
        throw new Error("invalid reference");
      },
      "checker-invalid",
    ],
  ] as const) {
    const host = await customHost({
      ...customProtocol(),
      artifacts: { timeoutMs: 10000, files: [{ name: "answer.pdf", maxBytes }], check },
    });
    expect(await host.execute(host.tasks[0], null, new AbortController().signal)).toMatchObject({
      outcome,
      cost: { providerUsd: 0.00002 },
    });
  }
  await expect(
    customHost({
      ...customProtocol(),
      artifacts: {
        timeoutMs: 10000,
        files: [{ name: "../secret.pdf", maxBytes: 10 }],
        check: () => true,
      },
    }),
  ).rejects.toThrow("Invalid host-owned");
});

const customProtocol = (): NonNullable<ResearchBriefHostOptions["protocol"]> => ({
  id: "custom-calibration",
  version: "1",
  prompt: "Read sources.json; write brief.json and brief.md.",
  checkerHash: "b".repeat(64),
  maxOutputBytes: 200000,
  acceptsInput: (input) => JSON.stringify(input) === '{"public":42}',
  checkDeliverables: (_task, output, markdown) =>
    Boolean(markdown?.trim()) && (output as { hidden?: number })?.hidden === 7,
});
const customHost = (protocol = customProtocol()) =>
  createResearchBriefHost(
    { skills: { collective: { validationModel: "fixture/model" } } },
    "main",
    "node",
    "seed",
    { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
    {
      protocol,
      tasks: [{ id: "custom", family: "calibration", regression: false, input: { public: 42 } }],
    },
  );

it("keeps custom checker answers outside the workspace and supports bounded larger reports", async () => {
  runner.mockImplementation(
    async ({ workspaceDir, prompt }: { workspaceDir: string; prompt: string }) => {
      expect(prompt).toBe(customProtocol().prompt);
      expect(await fs.readdir(workspaceDir)).toEqual(["sources.json"]);
      expect(
        JSON.parse(await fs.readFile(path.join(workspaceDir, "sources.json"), "utf8")),
      ).toEqual({ public: 42 });
      await fs.writeFile(
        path.join(workspaceDir, "brief.json"),
        JSON.stringify({ hidden: 7, padding: "a".repeat(120000) }),
      );
      await fs.writeFile(path.join(workspaceDir, "brief.md"), "explanation");
      return {
        meta: {
          agentMeta: { provider: "fixture", model: "model", usage: { input: 10, output: 10 } },
        },
      };
    },
  );
  const host = await customHost();
  expect((await host.execute(host.tasks[0], null, new AbortController().signal)).outcome).toBe(
    "pass",
  );
  const small = await customHost({ ...customProtocol(), maxOutputBytes: 100000 });
  expect(small.environment.runtime.taskContract).not.toBe(host.environment.runtime.taskContract);
  expect((await small.execute(small.tasks[0], null, new AbortController().signal)).outcome).toBe(
    "task-failure",
  );
  const broken = await customHost({
    ...customProtocol(),
    checkDeliverables: () => {
      throw new Error("Broken checker");
    },
  });
  expect((await broken.execute(broken.tasks[0], null, new AbortController().signal)).outcome).toBe(
    "checker-invalid",
  );
});

it("refuses malformed host protocols and unfrozen custom inputs before calling a model", async () => {
  await expect(
    customHost({ ...customProtocol(), maxOutputBytes: 3 * 1024 * 1024 }),
  ).rejects.toThrow("Invalid host-owned");
  await expect(customHost({ ...customProtocol(), checkerHash: "invalid" })).rejects.toThrow(
    "Invalid host-owned",
  );
  const host = await customHost();
  expect(
    await host.execute(
      { ...host.tasks[0], input: { public: 43 } },
      null,
      new AbortController().signal,
    ),
  ).toMatchObject({ outcome: "checker-invalid", cost: { providerUsd: 0 } });
  expect(runner).not.toHaveBeenCalled();
});

it.each([0, -1, 999, 600001, Number.NaN, 300000.5])(
  "rejects an invalid operator timeout %s before invoking the runner",
  async (agentTimeoutMs) => {
    await expect(customHost({ ...customProtocol(), agentTimeoutMs })).rejects.toThrow(
      "Invalid host-owned",
    );
    expect(runner).not.toHaveBeenCalled();
  },
);

it("reserves and fingerprints the exact operator deadline passed to the runner", async () => {
  runner.mockResolvedValue({
    meta: { agentMeta: { provider: "fixture", model: "model", usage: { input: 1 } } },
  });
  const ordinary = await customHost();
  const extended = await customHost({ ...customProtocol(), agentTimeoutMs: 300000 });
  expect(ordinary.quote(ordinary.tasks[0]).wallMs).toBe(120000);
  expect(extended.quote(extended.tasks[0]).wallMs).toBe(300000);
  expect(extended.environment.runtime.taskContract).not.toBe(
    ordinary.environment.runtime.taskContract,
  );
  await extended.execute(extended.tasks[0], null, new AbortController().signal);
  expect(runner).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300000 }));
});

it("materializes hash-bound public files and awaits a private async checker", async () => {
  const bytes = Buffer.from("public database fixture");
  const protocol = {
    ...customProtocol(),
    inputFilesHash: "c".repeat(64),
    inputFiles: async () => [{ name: "database.sqlite", bytes, sha256: sha256(bytes) }],
    checkDeliverables: async (_task: unknown, output: unknown) => {
      await Promise.resolve();
      return (output as { hidden: number }).hidden === 7;
    },
  };
  runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
    expect((await fs.readdir(workspaceDir)).toSorted()).toEqual([
      "database.sqlite",
      "sources.json",
    ]);
    expect(await fs.readFile(path.join(workspaceDir, "database.sqlite"))).toEqual(bytes);
    await fs.writeFile(path.join(workspaceDir, "brief.json"), JSON.stringify({ hidden: 6 }));
    await fs.writeFile(path.join(workspaceDir, "brief.md"), "answer");
    return { meta: { agentMeta: { provider: "fixture", model: "model", usage: { input: 10 } } } };
  });
  const host = await customHost(protocol);
  expect((await host.execute(host.tasks[0], null, new AbortController().signal)).outcome).toBe(
    "task-failure",
  );
  const changed = await customHost({ ...protocol, inputFilesHash: "d".repeat(64) });
  expect(changed.environment.runtime.taskContract).not.toBe(host.environment.runtime.taskContract);
});

it.each([
  "../escape.sqlite",
  "CON.sqlite",
  "con.sqlite",
  "sources.json",
  "brief.json",
  "/database.sqlite",
])("rejects unsafe or reserved fixture name %s before a model call", async (name) => {
  const bytes = Buffer.from("data");
  const host = await customHost({
    ...customProtocol(),
    inputFilesHash: "c".repeat(64),
    inputFiles: async () => [{ name, bytes, sha256: sha256(bytes) }],
  });
  await expect(host.execute(host.tasks[0], null, new AbortController().signal)).rejects.toThrow(
    "Invalid host input file",
  );
  expect(runner).not.toHaveBeenCalled();
});

it("rejects missing fixture fingerprints, tampered bytes and duplicate names", async () => {
  const bytes = Buffer.from("data");
  const file = { name: "database.sqlite", bytes, sha256: sha256(bytes) };
  await expect(customHost({ ...customProtocol(), inputFiles: async () => [file] })).rejects.toThrow(
    "Invalid host-owned",
  );
  for (const files of [[{ ...file, sha256: "0".repeat(64) }], [file, file]]) {
    const host = await customHost({
      ...customProtocol(),
      inputFilesHash: "c".repeat(64),
      inputFiles: async () => files,
    });
    await expect(host.execute(host.tasks[0], null, new AbortController().signal)).rejects.toThrow(
      "Invalid host input file",
    );
  }
  expect(runner).not.toHaveBeenCalled();
});

it("records known zero cost for a fixture failure before invoking the runner", async () => {
  const reports: ResearchBriefExecution[] = [];
  const host = await createResearchBriefHost(
    { skills: { collective: { validationModel: "fixture/model" } } },
    "main",
    "node",
    "seed",
    { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
    {
      protocol: {
        ...customProtocol(),
        inputFilesHash: "c".repeat(64),
        inputFiles: async () => {
          throw new Error("Source fixture unavailable");
        },
      },
      onExecution: async (e) => {
        reports.push(e);
      },
    },
  );
  await expect(
    host.execute(
      { id: "x", family: "test", regression: false, input: { public: 42 } },
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Source fixture unavailable");
  expect(reports[0].result).toMatchObject({
    outcome: "infrastructure",
    cost: { providerUsd: 0, toolCalls: 0 },
  });
  expect(runner).not.toHaveBeenCalled();
});

it("does not invoke a runner for an already cancelled task", async () => {
  const host = await customHost();
  const abort = new AbortController();
  abort.abort();
  expect(await host.execute(host.tasks[0], null, abort.signal)).toMatchObject({
    outcome: "interrupted",
    cost: { providerUsd: 0, toolCalls: 0 },
  });
  expect(runner).not.toHaveBeenCalled();
});

it("rechecks cancellation after asynchronous fixture preparation", async () => {
  const abort = new AbortController();
  const host = await customHost({
    ...customProtocol(),
    inputFilesHash: "c".repeat(64),
    inputFiles: async () => {
      await Promise.resolve();
      abort.abort();
      return [];
    },
  });
  expect(await host.execute(host.tasks[0], null, abort.signal)).toMatchObject({
    outcome: "interrupted",
    cost: { providerUsd: 0, toolCalls: 0 },
  });
  expect(runner).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves cancellation during an async checker (rejects=%s)",
  async (rejects) => {
    const abort = new AbortController();
    const host = await customHost({
      ...customProtocol(),
      checkDeliverables: async () => {
        abort.abort();
        await Promise.resolve();
        if (rejects) throw new Error("Checker cancelled");
        return true;
      },
    });
    runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
      await fs.writeFile(path.join(workspaceDir, "brief.json"), JSON.stringify({ hidden: 7 }));
      await fs.writeFile(path.join(workspaceDir, "brief.md"), "answer");
      return { meta: { agentMeta: { provider: "fixture", model: "model", usage: { input: 10 } } } };
    });
    expect(await host.execute(host.tasks[0], null, abort.signal)).toMatchObject({
      outcome: "interrupted",
      cost: { providerUsd: 0.00001 },
    });
  },
);

it("keeps redacted provider diagnostics and unknown costs after cleaning the isolated workspace", async () => {
  const secret = "sk-ant-this-is-a-private-fixture-key-123456";
  runner.mockResolvedValue({
    meta: { durationMs: 1, providerFailed: true },
    payloads: [{ isError: true, text: `400 temperature is unsupported; apiKey=${secret}` }],
  });
  const reports: ResearchBriefExecution[] = [];
  const host = await createResearchBriefHost(
    { skills: { collective: { validationModel: "fixture/model" } } },
    "main",
    "node",
    "seed",
    { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
    {
      onExecution: async (report) => {
        reports.push(report);
      },
    },
  );
  const outcome = await host.execute(host.tasks[0], null, new AbortController().signal);
  expect(outcome).toMatchObject({ outcome: "infrastructure", cost: null, accessedFiles: [] });
  expect(reports[0].diagnostic).toMatchObject({
    kind: "provider-error",
    message: expect.stringContaining("temperature is unsupported"),
  });
  expect(JSON.stringify(reports)).not.toContain(secret);
  const workspace = runner.mock.calls[0][0].workspaceDir as string;
  await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  runner.mockRejectedValue(new Error("Sandbox unavailable"));
  await expect(host.execute(host.tasks[0], null, new AbortController().signal)).rejects.toThrow(
    "Sandbox unavailable",
  );
  expect(reports[1].diagnostic).toEqual({
    kind: "execution-error",
    message: "Sandbox unavailable",
  });
});

it.each([true, false])(
  "checks completed deliverables after a tool warning (correct=%s)",
  async (correct) => {
    runner.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => {
      const input = JSON.parse(
        await fs.readFile(path.join(workspaceDir, "sources.json"), "utf8"),
      ) as {
        question: string;
        followUpOwner: string;
        sources: Array<{
          id: string;
          metric: string;
          value: number;
          publishedAt: string;
          status: string;
        }>;
      };
      await fs.writeFile(
        path.join(workspaceDir, "brief.json"),
        JSON.stringify({
          question: input.question,
          findings: input.sources
            .filter((source) => source.status === "current")
            .map((source) => ({
              metric: source.metric,
              value: source.value + (correct ? 0 : 1),
              sourceId: source.id,
              date: new Date(source.publishedAt).toISOString().slice(0, 10),
            })),
          uncertainties: ["Conflicting observations require further investigation."],
          recommendation: "Continue measuring.",
          followUp: { owner: input.followUpOwner, action: "Collect a second sample." },
        }),
      );
      await fs.writeFile(
        path.join(workspaceDir, "brief.md"),
        "# Evidence brief\nReview the conflicting observations.",
      );
      return {
        meta: {
          durationMs: 1,
          agentMeta: { provider: "fixture", model: "model", usage: { input: 10, output: 10 } },
        },
        payloads: [
          { isError: true, text: "Optional node --version probe failed; Python succeeded" },
        ],
      };
    });
    const reports: ResearchBriefExecution[] = [];
    const host = await createResearchBriefHost(
      { skills: { collective: { validationModel: "fixture/model" } } },
      "main",
      "node",
      "seed",
      { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
      {
        onExecution: async (report) => {
          reports.push(report);
        },
      },
    );
    const outcome = await host.execute(host.tasks[0], null, new AbortController().signal);
    expect(outcome).toMatchObject({
      outcome: correct ? "pass" : "task-failure",
      cost: { providerUsd: 0.00002 },
    });
    expect(reports[0]).toMatchObject({
      diagnostic: { kind: "tool-warning", message: expect.stringContaining("node --version") },
      brief: { question: expect.any(String) },
      markdown: expect.stringContaining("Evidence brief"),
    });
  },
);

it("supplies the same public UTC contract to incumbent and candidate and fingerprints it", async () => {
  runner.mockResolvedValue({ meta: { durationMs: 1, providerFailed: true } });
  const snapshot = await snapshotPackage(
    path.resolve("test/fixtures/collective-learning/research-brief"),
    {
      name: "research-brief",
      description: "Test package",
      requirements: {
        platforms: ["linux"],
        tools: { python3: "3" },
        runtime: {},
        capabilities: [],
      },
    },
  );
  const host = await createResearchBriefHost(
    { skills: { collective: { validationModel: "fixture/model" } } },
    "main",
    "node",
    "seed",
    { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
  );
  await host.execute(host.tasks[0], null, new AbortController().signal);
  await host.execute(host.tasks[0], snapshot, new AbortController().signal);
  const [incumbent, candidate] = runner.mock.calls.map(([params]) => params as { prompt: string });
  expect(incumbent.prompt).toBe(candidate.prompt);
  expect(candidate.prompt).toBe(RESEARCH_BRIEF_TASK_CONTRACT.prompt);
  expect(candidate.prompt).toContain("Date rule (UTC)");
  expect(candidate.prompt).toContain("Date-only YYYY-MM-DD sources keep that date unchanged");
  expect(candidate.prompt).not.toContain(host.tasks[0].id);
  const calls = runner.mock.calls.map(
    ([params]) =>
      params as {
        workspaceDir: string;
        sessionId: string;
        config: { agents: { defaults: { toolCache: { enabled: boolean } } } };
      },
  );
  expect(new Set(calls.map((call) => call.workspaceDir)).size).toBe(2);
  expect(new Set(calls.map((call) => call.sessionId)).size).toBe(2);
  for (const call of calls) expect(call.config.agents.defaults.toolCache.enabled).toBe(false);
  expect(host.environment.runtime).toMatchObject({
    checker: "research-brief-v3",
    dateBasis: "utc",
    taskContract: RESEARCH_BRIEF_TASK_CONTRACT_HASH,
  });
});

it("rejects ambiguous task dates before any model call, with known zero provider cost", async () => {
  const reports: ResearchBriefExecution[] = [];
  const host = await createResearchBriefHost(
    { skills: { collective: { validationModel: "fixture/model" } } },
    "main",
    "node",
    "seed",
    { id: "sha256:" + "a".repeat(64), architecture: "amd64" },
    {
      onExecution: async (report) => {
        reports.push(report);
      },
    },
  );
  const input = {
    question: "Compare outcomes",
    followUpOwner: "Sam",
    sources: [
      {
        id: "s1",
        metric: "returns",
        value: 3,
        publishedAt: "2026-02-04T23:30:00",
        status: "current",
      },
    ],
  };
  const result = await host.execute(
    { ...host.tasks[0], input },
    null,
    new AbortController().signal,
  );
  expect(runner).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    outcome: "checker-invalid",
    cost: { providerUsd: 0, toolCalls: 0 },
    accessedFiles: [],
  });
  expect(reports[0].diagnostic?.kind).toBe("task-input-invalid");
});
