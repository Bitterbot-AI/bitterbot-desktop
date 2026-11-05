import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { learningHash, type LearningConfig } from "./procedural-learning-contract.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning } from "./procedural-learning.js";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const scope = {
  tool: "export",
  version: "v2",
  operation: "sum",
  contractHash: learningHash("sum-v2"),
};
const budget = { providerUsd: 0, toolCalls: 1000, wallMs: 1000000 };
function setup(mode: LearningConfig["mode"] = "active") {
  let now = 100000;
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new ProceduralLearningStore(
    db,
    { mode, experienceMemory: { enabled: true, minSupport: 2, maxPromptChars: 6000 } },
    () => now,
  );
  const service = new ProceduralLearning(store);
  const description = {
    cue: "sum export rows",
    context: { pagination: "cursor" },
    action: "sum values",
    check: "compare sum",
    detail: "sanitized receipt",
  };
  service.registerAdapter({
    id: "sum",
    scope,
    verifierHash: learningHash("verifier"),
    isolation: "sandbox",
    qualificationCases: [[1], [2]],
    quote: () => ({ providerUsd: 0, toolCalls: 2, wallMs: 1000 }),
    execute: async (_program, input) => ({
      output: (input as number[]).reduce((a, b) => a + b, 0),
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
    }),
    verify: async (input, output) => ({
      passed: output === (input as number[]).reduce((a, b) => a + b, 0),
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
    }),
    describeExperience: () => description,
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
  const entry = store.propose({
    schemaVersion: 1,
    scope,
    lesson: "sum",
    adapter: "sum",
    program: "sum",
    counterexamples: ["not a count"],
    parents: [],
    sourceEpisodes: ["seed"],
    origin: "experience",
    sharing: "private",
    expiresAt: now + 1000,
  });
  const run = (input: number[], partition: "acquisition" | "held-out" = "acquisition") =>
    service.run({
      candidate: entry.hash,
      input,
      scope,
      budget,
      partition,
      predictedSuccess: 0.5,
      shadowEvaluation: true,
    });
  const sources = () =>
    (db.prepare("SELECT id FROM experience_evidence ORDER BY id").all() as { id: string }[]).map(
      (r) => r.id,
    );
  const lesson = () => ({
    scope,
    cue: "sum export rows",
    when: { pagination: "cursor" },
    lesson: "sum all cursor pages",
    check: "compare sum",
    avoid: ["do not count rows"],
    sources: sources(),
  });
  return {
    service,
    store,
    db,
    run,
    sources,
    lesson,
    description,
    advance: () => {
      now += 1001;
    },
  };
}
it("captures independently checked acquisition, recalls compact advice and expands original evidence", async () => {
  const f = setup();
  await f.run([1, 2]);
  await f.run([3, 4]);
  const id = f.service.experience.consolidate(f.lesson());
  expect(
    f.service.experience.recall({ scope, query: "sum export", context: { pagination: "cursor" } })
      .items,
  ).toEqual([
    expect.objectContaining({
      id,
      applicability: "matched",
      status: "advisory-derived-not-verified",
      outcomes: ["pass", "pass"],
    }),
  ]);
  expect(f.service.experience.expand(f.sources()[0])?.detail).toBe("sanitized receipt");
  expect(
    f.service.experience.recall({ scope, query: "sum export", context: { pagination: "offset" } })
      .items,
  ).toEqual([]);
  expect(
    f.service.experience.recall({ scope: { ...scope, version: "v3" }, query: "sum" }).items,
  ).toEqual([]);
  f.service.replay();
  f.service.replay();
  expect(f.sources()).toHaveLength(2);
});
it("rejects held-out labels, invented receipts, duplicated inputs and unsupported conditions", async () => {
  const f = setup();
  const held = await f.run([6, 7], "held-out");
  expect(f.sources()).toEqual([]);
  expect(() => f.service.experience.attach(held.runId, f.description)).toThrow("acquisition");
  expect(() => f.service.experience.attach("fabricated", f.description)).toThrow("acquisition");
  await f.run([1, 2]);
  await f.run([1, 2]);
  expect(() => f.service.experience.consolidate(f.lesson())).toThrow("independent");
  await f.run([3, 4]);
  expect(() =>
    f.service.experience.consolidate({ ...f.lesson(), when: { pagination: "offset" } }),
  ).toThrow("Applicability");
});
it("keeps shadow private, enforces budget, and withdraws advice when source is forgotten or expired", async () => {
  const f = setup("shadow");
  await f.run([1, 2]);
  await f.run([3, 4]);
  f.service.experience.consolidate(f.lesson());
  expect(f.service.experience.recall({ scope, query: "sum" }).items).toEqual([]);
  expect(f.service.experience.expand(f.sources()[0])).toBeNull();
  expect(f.service.experience.recall({ scope, query: "sum" }, true).items).toHaveLength(1);
  f.service.experience.forget(f.sources()[0]);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM experience_lessons").get()).toEqual({ n: 0 });
  f.advance();
  f.service.replay();
  expect(f.sources()).toEqual([]);
});
it("does not lose a verified outcome when optional extraction fails", async () => {
  const f = setup();
  f.description.detail = "x".repeat(6001);
  expect((await f.run([1, 2])).passed).toBe(true);
  expect(f.store.costs().unknownRuns).toBe(0);
  expect(f.store.costs().unknownAcquisitions).toBe(0);
  expect(f.sources()).toEqual([]);
});
it("does not recreate a forgotten lesson or rebind a forgotten receipt to changed prose", async () => {
  const f = setup();
  const first = await f.run([1, 2]);
  await f.run([3, 4]);
  const proposal = f.lesson();
  const lessonId = f.service.experience.consolidate(proposal);
  f.service.experience.forget(lessonId);
  expect(() => f.service.experience.consolidate(proposal)).toThrow("forgotten");
  const evidenceId = f
    .sources()
    .find((id) => f.service.experience.expand(id)?.runId === first.runId)!;
  f.service.experience.forget(evidenceId);
  expect(
    f.service.experience.attach(first.runId, { ...f.description, detail: "rewritten" }),
  ).toBeNull();
});
it("marks unspecified conditions and bounds the complete returned item serialization", async () => {
  const f = setup();
  await f.run([1, 2]);
  await f.run([3, 4]);
  f.service.experience.consolidate(f.lesson());
  expect(f.service.experience.recall({ scope, query: "sum" }).items[0]).toMatchObject({
    applicability: "check-conditions",
  });
  f.store.config.experienceMemory.maxPromptChars = 512;
  const result = f.service.experience.recall({ scope, query: "sum" });
  expect(JSON.stringify(result.items).length).toBeLessThanOrEqual(512);
});
it("does not invoke optional extraction when experience memory is disabled", async () => {
  const f = setup();
  f.store.config.experienceMemory.enabled = false;
  let reads = 0;
  Object.defineProperty(f.description, "detail", {
    get() {
      reads++;
      return "private";
    },
  });
  expect((await f.run([1, 2])).passed).toBe(true);
  expect(reads).toBe(0);
  expect(f.sources()).toEqual([]);
});
