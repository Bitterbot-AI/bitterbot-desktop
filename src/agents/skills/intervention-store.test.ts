import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import type { InterventionRecord } from "./intervention-record.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { createSqliteInterventionStore } from "./intervention-store.js";

function rec(over: Partial<InterventionRecord> = {}): InterventionRecord {
  return {
    id: "r1",
    ts: 1000,
    sessionKey: "s",
    skill: "test",
    interceptorId: "test:1",
    stateSummary: {
      hormonal: {
        dopamine: 0.1,
        cortisol: 0.02,
        oxytocin: 0.2,
        response: {
          warmth: 0,
          energy: 0,
          focus: 0,
          playfulness: 0,
          verbosity: 0,
          curiosity: 0,
          assertiveness: 0,
          empathy: 0,
        },
      },
      gccrf: {
        predictionError: 0,
        learningProgress: 0,
        novelty: 0,
        empowerment: 0.5,
        strategicAlignment: 0.5,
        certaintyDelta: 0,
      },
      channel: "internal",
    },
    actionOriginal: { toolName: "send_message", params: { text: "hi" } },
    actionFinal: { toolName: "send_message", params: { text: "hi" } },
    intervention: { type: "noop" },
    metadata: { activationLatencyMs: 0.5, interventionLatencyMs: 0.7 },
    sig: { ed25519: "", pubkeyId: "unsigned-local" },
    ...over,
  };
}

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(d);
  return d;
}

describe("intervention-store", () => {
  let store: ReturnType<typeof createSqliteInterventionStore>;
  let conn: DatabaseSync;
  beforeEach(() => {
    conn = db();
    store = createSqliteInterventionStore(conn);
  });

  it("insert + recent round-trip", () => {
    store.insert(rec({ id: "r1", ts: 1000 }));
    store.insert(rec({ id: "r2", ts: 2000 }));
    const recent = store.recent({ limit: 10 });
    expect(recent.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("recent filters by sessionKey", () => {
    store.insert(rec({ id: "r1", sessionKey: "a" }));
    store.insert(rec({ id: "r2", sessionKey: "b" }));
    const rs = store.recent({ sessionKey: "b", limit: 10 });
    expect(rs.map((r) => r.id)).toEqual(["r2"]);
  });

  it("insert is idempotent on id collision (INSERT OR IGNORE)", () => {
    store.insert(rec({ id: "r1", ts: 1000 }));
    store.insert(rec({ id: "r1", ts: 9999 }));
    const rs = store.recent({ limit: 10 });
    expect(rs.length).toBe(1);
    expect(rs[0]?.ts).toBe(1000);
  });

  it("attachOutcome updates outcome_tag", () => {
    store.insert(rec({ id: "r1" }));
    store.attachOutcome("r1", { tag: "downstream-success", evidence: "thanks!" });
    const row = conn
      .prepare(`SELECT outcome_tag, outcome_evidence FROM intervention_records WHERE id='r1'`)
      .get() as {
      outcome_tag: string;
      outcome_evidence: string;
    };
    expect(row.outcome_tag).toBe("downstream-success");
    expect(row.outcome_evidence).toBe("thanks!");
  });

  it("attachOutcome does not overwrite an existing tag", () => {
    store.insert(rec({ id: "r1" }));
    store.attachOutcome("r1", { tag: "downstream-failure", evidence: "wrong" });
    store.attachOutcome("r1", { tag: "downstream-success", evidence: "thanks!" });
    const row = conn
      .prepare(`SELECT outcome_tag FROM intervention_records WHERE id='r1'`)
      .get() as {
      outcome_tag: string;
    };
    expect(row.outcome_tag).toBe("downstream-failure");
  });
});
