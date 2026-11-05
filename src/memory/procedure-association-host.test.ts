import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { learningHash } from "./procedural-learning-contract.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning } from "./procedural-learning.js";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it("ranks only live scoped host receipts and removes forgotten, held-out, expired or revoked evidence", async () => {
  let now = 10000;
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const scope = {
    tool: "sum",
    operation: "run",
    version: "v1",
    contractHash: learningHash("contract"),
  };
  const verifierHash = learningHash("oracle");
  const store = new ProceduralLearningStore(
    db,
    { mode: "shadow", experienceMemory: { enabled: true, minSupport: 2, maxPromptChars: 6000 } },
    () => now,
  );
  const service = new ProceduralLearning(store);
  service.registerAdapter({
    id: "sum",
    scope,
    verifierHash,
    isolation: "sandbox",
    qualificationCases: [1, 2],
    quote: () => ({ providerUsd: 0, toolCalls: 1, wallMs: 100 }),
    execute: async (_p, input) => ({
      output: input,
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
    }),
    verify: async (input, output) => ({
      passed: input === output,
      cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
    }),
    describeExperience: () => ({
      cue: "sum",
      context: { endpoint: "customers" },
      action: "sum",
      check: "oracle",
      detail: "redacted",
    }),
  });
  store.recordEpisode({
    id: "seed",
    scope,
    outcome: "unknown",
    traceHash: learningHash("seed"),
    cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
    partition: "acquisition",
    sharing: "private",
    occurredAt: now,
  });
  const candidate = store.propose({
    schemaVersion: 1,
    scope,
    lesson: "sum",
    adapter: "sum",
    program: "sum",
    counterexamples: ["count"],
    parents: [],
    sourceEpisodes: ["seed"],
    origin: "experience",
    sharing: "private",
    expiresAt: now + 10000,
  });
  const run = (input: number, partition: "acquisition" | "held-out") =>
    service.run({
      candidate: candidate.hash,
      input,
      scope,
      budget: { providerUsd: 0, toolCalls: 10, wallMs: 10000 },
      partition,
      predictedSuccess: 0.5,
      shadowEvaluation: true,
    });
  await run(1, "acquisition");
  await run(1, "acquisition");
  await run(99, "held-out");
  const request = {
    scope,
    verifierHash,
    candidates: [candidate.hash],
    context: { endpoint: "customers" },
    shadowEvaluation: true as const,
  };
  expect(service.associations.rank(request).observations).toBe(1);
  expect(
    service.associations.rank({ ...request, verifierHash: learningHash("other") }).observations,
  ).toBe(0);
  expect(
    service.associations.rank({ ...request, scope: { ...scope, version: "v2" } }).ranked,
  ).toEqual([]);
  for (const row of db.prepare("SELECT id FROM experience_evidence").all() as { id: string }[])
    service.experience.forget(row.id);
  expect(service.associations.rank(request).observations).toBe(0);
  expect(service.associations.rank(request).ranked).toEqual([]);
  await run(3, "acquisition");
  expect(service.associations.rank(request).observations).toBe(1);
  store.revoke(candidate.hash, "test");
  expect(service.associations.rank(request).ranked).toEqual([]);
  now += 20000;
  expect(service.associations.rank(request).ranked).toEqual([]);
});
it("does not expose the host experiment when disabled or outside shadow mode", () => {
  for (const mode of ["off", "active", "shadow"] as const) {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const service = new ProceduralLearning(new ProceduralLearningStore(db, { mode }));
    expect(
      service.associations.rank({
        scope: { tool: "t", version: "v", operation: "o", contractHash: learningHash("c") },
        verifierHash: learningHash("v"),
        candidates: [],
        context: {},
        shadowEvaluation: true,
      }).ranked,
    ).toEqual([]);
  }
});
