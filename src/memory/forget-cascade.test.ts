/**
 * PLAN-55 Phase 3: the forget cascade (forget-cascade.ts through
 * owner-controls). Each case seeds one dependent store with a row resting on
 * the memory the owner forgets and checks what the cascade did to it.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { CanonicalFactsStore } from "./canonical-facts.js";
import { ensureDreamSchema } from "./dream-schema.js";
import { planForgetCascade, sessionRefFile, textStatesValue } from "./forget-cascade.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { chunkTextHash, isSuppressed } from "./memory-suppressions.js";
import {
  CascadePlanChanged,
  editMemory,
  forgetMemory,
  forgetSessionMemories,
  getMemory,
  OwnerEditRefused,
  previewEdit,
  previewForget,
} from "./owner-controls.js";
import { UserModelManager } from "./user-model.js";

const TABLES = { ftsTable: "chunks_fts", vectorTable: null };
let db: DatabaseSync;
let store: CanonicalFactsStore;
let events: CanonicalChangeEvent[];

function insertChunk(id: string, text: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    path: `memory/${id}`,
    source: "memory",
    start_line: 0,
    end_line: 0,
    hash: id,
    model: "m",
    text,
    embedding: "[]",
    updated_at: 1,
    lifecycle: "generated",
    lifecycle_state: "active",
    semantic_type: "fact",
    created_at: 1,
    ...extra,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO chunks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...(Object.values(row) as Array<string | number>));
  db.prepare(
    "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, 'm', 0, 0)",
  ).run(text, id, row.path as string, row.source as string);
}

function pin(
  key: string,
  value: string,
  source: "extraction" | "owner" | "agent_pin",
  evidence: string[],
  evidenceRef?: string,
) {
  const res = store.pin({ key, value, source, evidenceChunkIds: evidence, evidenceRef });
  expect(["add", "strengthen", "supersede"]).toContain(res.op);
}

function insertEdge(id: string, evidence: string[], from = "victor", to = "lisbon") {
  for (const name of [from, to]) {
    db.prepare(
      `INSERT OR IGNORE INTO entities (id, name, entity_type, first_seen_at, last_seen_at) VALUES (?, ?, 'place', 1, 1)`,
    ).run(`ent_${name}`, name);
  }
  db.prepare(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, valid_from, evidence_chunk_ids, created_at, updated_at)
     VALUES (?, ?, ?, 'lives_in', 1, ?, 1, 1)`,
  ).run(id, `ent_${from}`, `ent_${to}`, JSON.stringify(evidence));
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: true,
  });
  ensureDreamSchema(db);
  new UserModelManager(db);
  store = new CanonicalFactsStore(db, { maxFacts: 1000 });
  events = [];
  store.onChanged((e) => events.push(e));
  insertChunk("fact_a", "Victor lives in Lisbon.");
  insertChunk("fact_b", "Victor moved to Lisbon in 2024.");
});

const factRow = (key: string) => store.get(key);

describe("forget cascade: facts", () => {
  it("retires a fact whose only evidence is the forgotten memory and emits canonical:changed", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a"]);
    events = [];
    const result = await forgetMemory(db, "fact_a", TABLES, { store });

    expect(factRow("identity.home_city")?.status).toBe("retired");
    expect(factRow("identity.home_city")?.evidenceChunkIds).toEqual([]);
    expect(result.retiredFacts).toEqual([{ key: "identity.home_city", value: "Lisbon" }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "retire",
      retireReason: "evidence_removed",
      tier: 3,
      oldValue: "Lisbon",
    });
  });

  it("keeps an owner-tier fact active and lists it", async () => {
    pin("identity.home_city", "Lisbon", "owner", ["fact_a"]);
    const preview = await previewForget(db, "fact_a");
    expect(preview.ownerFactsKept).toEqual([{ key: "identity.home_city", value: "Lisbon" }]);
    expect(preview.factsRetired).toEqual([]);

    const result = await forgetMemory(db, "fact_a", TABLES, { store });
    expect(result.ownerFactsKept).toEqual([{ key: "identity.home_city", value: "Lisbon" }]);
    expect(factRow("identity.home_city")?.status).toBe("active");
    expect(factRow("identity.home_city")?.evidenceChunkIds).toEqual([]);
  });

  it("a fact with other live evidence survives and only loses the forgotten id", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a", "fact_b"]);
    await forgetMemory(db, "fact_a", TABLES, { store });
    expect(factRow("identity.home_city")?.status).toBe("active");
    expect(factRow("identity.home_city")?.evidenceChunkIds).toEqual(["fact_b"]);
  });

  it("a dangling id does not count as other evidence", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a", "fact_long_gone"]);
    await forgetMemory(db, "fact_a", TABLES, { store });
    expect(factRow("identity.home_city")?.status).toBe("retired");
  });

  it("a session line ref into a live transcript counts as evidence", async () => {
    pin(
      "identity.home_city",
      "Lisbon",
      "extraction",
      ["fact_a"],
      "session:/x/sessions/s1.jsonl#L3",
    );
    await forgetMemory(db, "fact_a", TABLES, { store });
    expect(factRow("identity.home_city")?.status).toBe("active");
  });
});

describe("forget cascade: graph, insights, findings, preferences, utility", () => {
  it("closes a graph link left with no evidence and strips one with other evidence", async () => {
    insertEdge("rel_only", ["fact_a"]);
    insertEdge("rel_multi", ["fact_a", "fact_b"], "victor", "porto");
    await forgetMemory(db, "fact_a", TABLES, { store });

    const rel = (id: string) =>
      db
        .prepare(`SELECT valid_until, evidence_chunk_ids FROM relationships WHERE id = ?`)
        .get(id) as {
        valid_until: number | null;
        evidence_chunk_ids: string;
      };
    expect(rel("rel_only").valid_until).not.toBeNull();
    expect(JSON.parse(rel("rel_only").evidence_chunk_ids)).toEqual([]);
    expect(rel("rel_multi").valid_until).toBeNull();
    expect(JSON.parse(rel("rel_multi").evidence_chunk_ids)).toEqual(["fact_b"]);
    expect(
      db
        .prepare(
          `SELECT action FROM relationship_belief_history WHERE relationship_id = 'rel_only'`,
        )
        .all(),
    ).toEqual([{ action: "evidence_removed" }]);
  });

  it("flags a dream insight drawn from the memory and forgets the memory promoted from it", async () => {
    db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, source_chunk_ids, dream_cycle_id, created_at, updated_at)
       VALUES ('ins_1', 'Victor is settled in Lisbon', '[]', '["fact_a","fact_b"]', 'c1', 1, 1)`,
    ).run();
    insertChunk("dream_insight_x", "Victor is settled in Lisbon", {
      origin: "dream",
      evidence_refs: JSON.stringify([{ kind: "dream", insightId: "ins_1", sourceId: "fact_b" }]),
    });
    insertChunk("dream_insight_unrelated", "Something else", {
      origin: "dream",
      evidence_refs: JSON.stringify([{ kind: "dream", insightId: "ins_9", sourceId: "fact_b" }]),
    });

    const result = await forgetMemory(db, "fact_a", TABLES, { store });

    const stale = (
      db.prepare(`SELECT stale_fact FROM dream_insights WHERE id = 'ins_1'`).get() as {
        stale_fact: string;
      }
    ).stale_fact;
    expect(JSON.parse(stale)).toEqual([
      expect.objectContaining({ reason: "forgotten_evidence", chunkIds: ["fact_a"] }),
    ]);
    expect(getMemory(db, "dream_insight_x")).toBeNull();
    expect(getMemory(db, "dream_insight_unrelated")).not.toBeNull();
    expect(
      isSuppressed(db, "chunk_hash", chunkTextHash("Victor is settled in Lisbon")),
    ).not.toBeNull();
    expect(result.counts).toMatchObject({ chunks: 2, derivedChunks: 1, insightsFlagged: 1 });
  });

  it("clears a curiosity finding's chunk id, strips preference evidence, deletes dream-utility rows", async () => {
    db.prepare(
      `INSERT INTO curiosity_findings (id, target_id, question, query_phrase, answer, confidence, chunk_id, created_at)
       VALUES ('find_1', 't1', 'q', 'q', 'a', 0.9, 'fact_a', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
       VALUES ('p1', 'style', 'tone', 'brief', 0.8, '["fact_a","fact_b"]', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO dream_utility (id, lane, artifact_kind, artifact_id, produced_at) VALUES ('du1', 'legacy', 'insight_chunk', 'fact_a', 1)`,
    ).run();

    await forgetMemory(db, "fact_a", TABLES, { store });

    expect(db.prepare(`SELECT chunk_id FROM curiosity_findings`).get()).toEqual({ chunk_id: null });
    expect(
      JSON.parse(
        (db.prepare(`SELECT evidence_ids FROM user_preferences`).get() as { evidence_ids: string })
          .evidence_ids,
      ),
    ).toEqual(["fact_b"]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM dream_utility`).get()).toEqual({ n: 0 });
  });
});

describe("preview and confirmation", () => {
  it("refuses when the plan changed since the preview, applies when it did not", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a"]);
    const preview = await previewForget(db, "fact_a");
    expect(preview.factsRetired).toHaveLength(1);
    // Something new rests on the memory after the preview.
    insertEdge("rel_new", ["fact_a"]);
    await expect(
      forgetMemory(db, "fact_a", TABLES, { store, planHash: preview.planHash }),
    ).rejects.toBeInstanceOf(CascadePlanChanged);
    expect(getMemory(db, "fact_a")).not.toBeNull();
    expect(factRow("identity.home_city")?.status).toBe("active");

    const fresh = await previewForget(db, "fact_a");
    const result = await forgetMemory(db, "fact_a", TABLES, { store, planHash: fresh.planHash });
    expect(result.planHash).toBe(fresh.planHash);
    expect(getMemory(db, "fact_a")).toBeNull();
  });

  it("a preview changes nothing", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a"]);
    insertEdge("rel_only", ["fact_a"]);
    const before = JSON.stringify(db.prepare(`SELECT * FROM canonical_facts`).all());
    await previewForget(db, "fact_a");
    expect(JSON.stringify(db.prepare(`SELECT * FROM canonical_facts`).all())).toBe(before);
    expect(getMemory(db, "fact_a")).not.toBeNull();
  });

  it("refuses a memory indexed from a file", async () => {
    insertChunk("abcfile", "from MEMORY.md", { path: "MEMORY.md" });
    await expect(previewForget(db, "abcfile")).rejects.toThrow(/change the file instead/);
    await expect(forgetMemory(db, "abcfile", TABLES)).rejects.toBeInstanceOf(OwnerEditRefused);
  });

  it("forgets a transcript memory with a text-hash suppression", async () => {
    insertChunk("sess123", "I live in Lisbon now", {
      source: "sessions",
      path: "sessions/s1.jsonl",
    });
    pin("identity.home_city", "Lisbon", "extraction", ["sess123"]);
    await forgetMemory(db, "sess123", TABLES, { store });
    expect(getMemory(db, "sess123")).toBeNull();
    expect(isSuppressed(db, "chunk_hash", chunkTextHash("I live in Lisbon now"))).not.toBeNull();
    expect(factRow("identity.home_city")?.status).toBe("retired");
  });
});

describe("edit cascade", () => {
  it("moves a fact to the new memory when its value is still in the new text", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a"]);
    pin("identity.employer", "Acme", "extraction", ["fact_a"]);
    const preview = await previewEdit(db, "fact_a", "Victor lives in Lisbon, near the river.");
    const edited = await editMemory(
      db,
      "fact_a",
      "Victor lives in Lisbon, near the river.",
      TABLES,
      { store, planHash: preview.planHash },
    );
    expect(edited.id).toBe(preview.newId);
    expect(factRow("identity.home_city")?.status).toBe("active");
    expect(factRow("identity.home_city")?.evidenceChunkIds).toEqual([edited.id]);
    // Acme is not in the new text: the evidence-empty rule applies.
    expect(factRow("identity.employer")?.status).toBe("retired");
    // The old text is suppressed; the new one is not.
    expect(isSuppressed(db, "chunk_hash", chunkTextHash("Victor lives in Lisbon."))).not.toBeNull();
    expect(
      isSuppressed(db, "chunk_hash", chunkTextHash("Victor lives in Lisbon, near the river.")),
    ).toBeNull();
  });

  it("refuses to edit a transcript memory", async () => {
    insertChunk("sess9", "words", { source: "sessions", path: "sessions/s1.jsonl" });
    await expect(editMemory(db, "sess9", "other", TABLES)).rejects.toThrow(/transcript/);
  });
});

describe("session deletion (§3.5b)", () => {
  it("retires facts resting only on the conversation and returns the survivors", async () => {
    const file = "/home/u/.bitterbot/agents/main/sessions/s1.jsonl";
    insertChunk("sessA", "we talked about Lisbon", {
      source: "sessions",
      path: "sessions/s1.jsonl",
    });
    insertChunk("fact_from_s1", "Victor lives in Lisbon (extracted)", {
      source: "sessions",
      path: file,
    });
    insertChunk("sessOther", "other conversation", {
      source: "sessions",
      path: "sessions/s2.jsonl",
    });
    pin("identity.home_city", "Lisbon", "extraction", ["fact_from_s1"]);
    pin("identity.employer", "Acme", "owner", ["sessA"]);
    pin("identity.editor", "vim", "extraction", ["sessA", "sessOther"]);
    pin("identity.timezone", "WET", "extraction", [], `session:${file}#L4`);

    const result = await forgetSessionMemories(db, [file], TABLES, { store });

    expect(getMemory(db, "sessA")).toBeNull();
    expect(getMemory(db, "fact_from_s1")).toBeNull();
    expect(getMemory(db, "sessOther")).not.toBeNull();
    expect(factRow("identity.home_city")?.status).toBe("retired");
    expect(factRow("identity.timezone")?.status).toBe("retired");
    expect(factRow("identity.employer")?.status).toBe("active");
    expect(factRow("identity.editor")?.status).toBe("active");
    expect(result.survivors).toEqual(
      expect.arrayContaining([
        { key: "identity.employer", value: "Acme", reason: "owner" },
        { key: "identity.editor", value: "vim", reason: "other_evidence" },
      ]),
    );
    // A deleted conversation writes no text suppressions (nothing re-extracts it).
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_suppressions`).get()).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT event FROM memory_audit_log WHERE event = 'owner_forget_session'`).all(),
    ).toHaveLength(1);
  });
});

describe("event loop", () => {
  it("yields while planning and applies a large plan in batches", async () => {
    const file = "/tmp/sessions/big.jsonl";
    const N = 1500;
    for (let i = 0; i < N; i++) {
      insertChunk(`sess_${i}`, `turn ${i} of a long chat`, {
        source: "sessions",
        path: "sessions/big.jsonl",
      });
    }
    for (let i = 0; i < 3000; i++) {
      insertEdge(`rel_${i}`, [`sess_${i % N}`], `person${i}`, `place${i}`);
    }
    for (let i = 0; i < 300; i++) {
      pin(`project.thing_${i}`, `value_${i}`, "extraction", [`sess_${i}`]);
    }
    let ticks = 0;
    let running = true;
    const ticker = () => {
      if (!running) return;
      ticks += 1;
      setImmediate(ticker);
    };
    setImmediate(ticker);
    const result = await forgetSessionMemories(db, [file], TABLES, { store });
    running = false;

    expect(result.counts.chunks).toBe(N);
    expect(result.counts.edgesClosed).toBe(3000);
    expect(result.retiredFacts).toHaveLength(300);
    expect(result.batches).toBeGreaterThan(1);
    // The loop ran between windows and between batches.
    expect(ticks).toBeGreaterThan(10);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE source = 'sessions'`).get()).toEqual({
      n: 0,
    });
  });
});

describe("helpers", () => {
  it("matches values as whole words and reads session refs", () => {
    expect(textStatesValue("The endpoint is api.acme.com now", "api.acme.com")).toBe(true);
    expect(textStatesValue("The endpoint is api2.acme.com", "api.acme.com")).toBe(false);
    expect(sessionRefFile("session:/a/b/s1.jsonl#L12")).toBe("s1.jsonl");
    expect(sessionRefFile("a quote")).toBeNull();
  });

  it("plans the same thing twice with the same hash", async () => {
    pin("identity.home_city", "Lisbon", "extraction", ["fact_a"]);
    const targets = {
      mode: "forget" as const,
      chunks: [{ id: "fact_a", text: "Victor lives in Lisbon.", kind: "own" as const }],
    };
    expect((await planForgetCascade(db, targets)).hash).toBe(
      (await planForgetCascade(db, targets)).hash,
    );
  });
});

describe("propagation of a cascade retire", () => {
  it("an evidence_removed retire marks the old value stale like the owner's retire", async () => {
    const { canonicalChangeMarksStale, isOwnerDrivenRetire } =
      await import("./canonical-events.js");
    const base = {
      key: "identity.home_city",
      oldValue: "Lisbon",
      newValue: null,
      op: "retire" as const,
      tier: 3,
      source: "owner",
      scope: "global",
      evidence: { ref: null, chunkIds: [] },
      factId: "f1",
      at: 1,
    };
    expect(canonicalChangeMarksStale({ ...base, retireReason: "evidence_removed" })).toBe(true);
    expect(isOwnerDrivenRetire({ ...base, retireReason: "evidence_removed" })).toBe(true);
    expect(canonicalChangeMarksStale({ ...base, retireReason: "decay" })).toBe(false);
  });
});
