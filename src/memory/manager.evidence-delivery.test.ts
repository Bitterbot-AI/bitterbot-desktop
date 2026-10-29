import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveEndocrineState } from "../agents/endocrine-state.js";
import { buildEndocrineStateSection } from "../agents/system-prompt-endocrine.js";
import { EvidenceTelemetry } from "./evidence-telemetry.js";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// Control only fact selection; execute the real recall hook, writer, endocrine
// resolver and prompt renderer. No embeddings or provider requests.
vi.mock("./proactive-recall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proactive-recall.js")>()),
  proactiveRecall: vi.fn(() => ({
    facts: [
      {
        text: "The review fixture uses port 12345",
        source: "crystal",
        confidence: 1,
        chunkId: "review-fact",
      },
      {
        text: "First dream",
        source: "crystal",
        confidence: 1,
        chunkId: "dream-1",
        origin: "dream",
      },
      {
        text: "Discarded dream",
        source: "crystal",
        confidence: 1,
        chunkId: "dream-2",
        origin: "dream",
      },
    ],
    searchTimeMs: 0,
    layerCounts: { graphFacts: 0, identityFacts: 0, vectorFacts: 1, keywordFacts: 0, openLoops: 0 },
  })),
}));

let db: DatabaseSync;
let manager: MemoryIndexManager;
const markDreamArtifactsConsumed = vi.fn();
beforeEach(() => {
  markDreamArtifactsConsumed.mockClear();
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  manager = Object.assign(Object.create(MemoryIndexManager.prototype), {
    db,
    cfg: { memory: { consolidation: { enabled: false } } },
    consolidationTimer: null,
    evidenceTelemetry: new EvidenceTelemetry(db, { mode: "observe" }, { debug() {}, warn() {} }),
    stimulateFromLiveMessage() {},
    backfillIdentityRelationships() {},
    backfillGeneralRelationships() {},
    embedQueryWithTimeout: async () => [1, 0],
    proactiveRecallCooldown: new Map(),
    turnCount: 1,
    retrievalObs: { record() {} },
    retrievalTraceRate: 0,
    resolveUserName: () => undefined,
    hormonalState: () => null,
    gccrfDiagnostics: () => null,
    markDreamArtifactsConsumed,
  }) as MemoryIndexManager;
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 28, 12));
  vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(manager);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const rows = () => db.prepare("SELECT event_id, stage, session_digest FROM surfacing_events").all();

it("minimal prompt must not count a discarded proactive fact as delivered", async () => {
  const state = await resolveEndocrineState({
    agentId: "review",
    workspaceDir: "/nonexistent-review-fixture",
    userMessage: "Which port?",
    sessionKey: "agent:review:main",
    promptMode: "minimal",
  });
  expect(state?.proactiveMemories).toContain("12345");
  const prompt = buildEndocrineStateSection({ endocrineState: state, isMinimal: true }).join("\n");
  expect(prompt).not.toContain("12345");
  expect(rows()).toHaveLength(0);
});

it("two full prompt exposures in separate sessions must remain two events", async () => {
  for (const sessionKey of ["agent:review:first", "agent:review:second"]) {
    const state = await resolveEndocrineState({
      agentId: "review",
      workspaceDir: "/nonexistent-review-fixture",
      userMessage: "Which port?",
      sessionKey,
      promptMode: "full",
    });
    const prompt = buildEndocrineStateSection({ endocrineState: state, isMinimal: false }).join(
      "\n",
    );
    expect(prompt).toContain("12345");
  }
  expect(rows()).toHaveLength(4); // one fact and the first dream per session
  expect(rows().every((r) => !String(r.event_id).includes("dream-2"))).toBe(true);
});

it("does not record selection or discarded full-mode assembly, and deduplicates render retries", async () => {
  const state = await resolveEndocrineState({
    agentId: "review",
    workspaceDir: "/nonexistent-review-fixture",
    userMessage: "Which port?",
    sessionKey: "agent:review:main",
    deliveryId: "turn-1",
    promptMode: "full",
  });
  expect(state?.proactiveMemories).toContain("12345");
  expect(rows()).toHaveLength(0);
  buildEndocrineStateSection({ endocrineState: state, isMinimal: true });
  expect(rows()).toHaveLength(0);
  const full = buildEndocrineStateSection({ endocrineState: state, isMinimal: false }).join("\n");
  expect(full).not.toContain("Discarded dream");
  expect(rows()).toHaveLength(2);
  buildEndocrineStateSection({ endocrineState: state, isMinimal: false });
  expect(rows()).toHaveLength(2);
  expect(markDreamArtifactsConsumed).toHaveBeenCalledWith(["dream-1"], "retrieved");
  const rebuilt = await resolveEndocrineState({
    agentId: "review",
    workspaceDir: "/nonexistent-review-fixture",
    userMessage: "Which port?",
    sessionKey: "agent:review:main",
    deliveryId: "turn-1",
    promptMode: "full",
  });
  buildEndocrineStateSection({ endocrineState: rebuilt, isMinimal: false });
  expect(rows()).toHaveLength(2);
});

it("distinct turns in the same session remain distinct within the hour", async () => {
  for (const deliveryId of ["turn-1", "turn-2"]) {
    const state = await resolveEndocrineState({
      agentId: "review",
      workspaceDir: "/nonexistent-review-fixture",
      userMessage: "Which port?",
      sessionKey: "agent:review:main",
      deliveryId,
      promptMode: "full",
    });
    buildEndocrineStateSection({ endocrineState: state, isMinimal: false });
  }
  expect(rows()).toHaveLength(4);
  expect(JSON.stringify(rows())).not.toContain("agent:review:main");
  expect(JSON.stringify(rows())).not.toContain("turn-1");
});

it("evidence failures never drop prompt content", async () => {
  vi.spyOn(manager.getEvidenceTelemetry()!, "recordSurfacingBatch").mockImplementation(() => {
    throw Error("unavailable");
  });
  const state = await resolveEndocrineState({
    agentId: "review",
    workspaceDir: "/nonexistent-review-fixture",
    userMessage: "Which port?",
    promptMode: "full",
  });
  expect(
    buildEndocrineStateSection({ endocrineState: state, isMinimal: false }).join("\n"),
  ).toContain("12345");
  expect(rows()).toHaveLength(0);
});
