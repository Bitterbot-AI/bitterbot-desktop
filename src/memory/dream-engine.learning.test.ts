import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning } from "./procedural-learning.js";
import type { EvolutionPassResult } from "./skill-evolution/evolution-pass.js";

vi.mock("./skill-evolution/sampler.js", async (original) => ({
  ...(await original<typeof import("./skill-evolution/sampler.js")>()),
  readSamplerState: async () => ({
    cursorSeq: 0,
    updatedAt: 0,
    pending: [],
    processed: [],
    parseFailures: null,
  }),
}));
vi.mock("./skill-evolution/canonical-corpus.js", () => ({ loadEffectiveCorpus: async () => null }));
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});
function makeDb() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

it("shares the idle and full-cycle lane and refuses dispatch after an index DB swap", async () => {
  const db = makeDb();
  const service = new ProceduralLearning(new ProceduralLearningStore(makeDb()));
  const engine = new DreamEngine(
    db,
    {
      llmCall: async () => "",
      skillEvolution: { validationMode: "records" },
      a2aAttestation: { enabled: false },
    },
    async () => "",
    async () => [],
  );
  let finish!: (result: EvolutionPassResult) => void;
  const blocked = new Promise<EvolutionPassResult>((resolve) => {
    finish = resolve;
  });
  const run = vi.spyOn(service.failureExperiments, "run").mockReturnValue(blocked);
  engine.setFailureLearningHost({ service: () => service, canDispatch: () => true });
  const idle = engine.runLearningLane("idle", true);
  expect(engine.runLearningLane("full-cycle")).toBe(idle);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  const args = run.mock.calls[0]!;
  expect(args[0].db).toBe(db);
  expect(args[1].canDispatch()).toBe(true);
  engine.updateDb(makeDb());
  expect(args[1].canDispatch()).toBe(false);
  finish({ ran: false, reason: "no-new-traces" });
  await engine.waitForLearning();
  await idle;
  await engine.runLearningLane("next-idle", true);
  expect(run).toHaveBeenCalledTimes(1);
}, 20_000);

it("does not request the service while the host is paused", async () => {
  const engine = new DreamEngine(
    makeDb(),
    {},
    async () => "",
    async () => [],
  );
  const service = vi.fn(() => null);
  engine.setFailureLearningHost({ service, canDispatch: () => false });
  await engine.runLearningLane("paused", true);
  expect(service).not.toHaveBeenCalled();
});
