/**
 * PLAN-33 Phase 3 — canonical promotion dream mode.
 *
 * Contract: during calm cycles, factual crystals are batched through the LLM
 * and canonical hits are pinned at LOW confidence with source `promotion`;
 * a promotion can strengthen anything but can never overwrite a deliberate
 * pin; junk output is dropped; the cursor makes re-runs idempotent; high
 * cortisol skips the cycle entirely.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalFactsStore } from "../canonical-facts.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runCanonicalPromotion } from "./canonical-promotion.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function insertFact(db: DatabaseSync, id: string, text: string, layer = "world_fact"): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, lifecycle, semantic_type, epistemic_layer, created_at, updated_at)
     VALUES (?, 'sessions/s.jsonl', 'sessions', 0, 0, ?, ?, 'pending', '[]',
       0.5, 'generated', 'fact', ?, 1, 1)`,
  ).run(id, text, `hash-${id}`, layer);
}

describe("runCanonicalPromotion", () => {
  let db: DatabaseSync;
  let store: CanonicalFactsStore;

  beforeEach(() => {
    db = makeDb();
    store = new CanonicalFactsStore(db);
    insertFact(db, "c1", "The project repository is github.com/Bitterbot-AI/bitterbot-desktop.");
    insertFact(db, "c2", "The gateway tunnel is a2a.bitterbot.ai.");
    insertFact(db, "c3", "We spent the afternoon debugging.", "experience"); // ineligible layer
  });

  it("pins LLM-identified canonical facts at promotion confidence", async () => {
    const llmCall = async (prompt: string) => {
      expect(prompt).toContain("MOST FACTS ARE NOT CANONICAL");
      return JSON.stringify({
        canonical: [
          { i: 1, key: "project.repo", value: "github.com/Bitterbot-AI/bitterbot-desktop" },
        ],
      });
    };
    const result = await runCanonicalPromotion({
      db,
      store,
      llmCall,
      hormones: { cortisol: 0.2 },
      maxChunks: 30,
    });
    expect(result.factsPromoted).toBe(1);
    const fact = store.get("project.repo");
    expect(fact?.value).toBe("github.com/Bitterbot-AI/bitterbot-desktop");
    expect(fact?.source).toBe("promotion");
    expect(fact?.confidence).toBe(0.6); // enters low; live confirmation ratifies
    expect(fact?.evidenceChunkIds).toContain("c1");
  });

  it("cannot overwrite a deliberate pin (trust tiers), but strengthens a match", async () => {
    store.pin({
      key: "project.repo",
      value: "github.com/Bitterbot-AI/bitterbot-desktop",
      source: "agent_pin",
      confidence: 0.95,
    });
    const llmCall = async () =>
      JSON.stringify({
        canonical: [
          { i: 1, key: "project.repo", value: "github.com/SomeoneElse/wrong-repo" }, // contradiction
          { i: 2, key: "infra.gateway", value: "a2a.bitterbot.ai" }, // fresh promotion
        ],
      });
    const result = await runCanonicalPromotion({
      db,
      store,
      llmCall,
      hormones: null,
      maxChunks: 30,
    });
    // The contradiction was rejected; the fresh promotion landed.
    expect(result.factsPromoted).toBe(1);
    expect(store.get("project.repo")?.value).toBe("github.com/Bitterbot-AI/bitterbot-desktop");
    expect(store.get("project.repo")?.source).toBe("agent_pin");
    expect(store.get("infra.gateway")?.source).toBe("promotion");
  });

  it("drops junk output and tolerates malformed JSON", async () => {
    let call = 0;
    const llmCall = async () => {
      call += 1;
      return call === 1
        ? `{"canonical":[{"i":99,"key":"a.b","value":"x"},{"i":1,"key":"???","value":"x"},{"i":1,"key":"a.b"}]}`
        : "not json at all";
    };
    const result = await runCanonicalPromotion({
      db,
      store,
      llmCall,
      hormones: null,
      maxChunks: 30,
    });
    expect(result.factsPromoted).toBe(0);
    expect(store.listActive().length).toBe(0);
  });

  it("advances the cursor so re-runs never re-scan (idempotent drain)", async () => {
    let calls = 0;
    const llmCall = async () => {
      calls += 1;
      return `{"canonical":[]}`;
    };
    const first = await runCanonicalPromotion({
      db,
      store,
      llmCall,
      hormones: null,
      maxChunks: 30,
    });
    expect(first.chunksProcessed).toBeGreaterThan(0);
    const second = await runCanonicalPromotion({
      db,
      store,
      llmCall,
      hormones: null,
      maxChunks: 30,
    });
    expect(second.chunksProcessed).toBe(0); // backlog drained, nothing re-scanned
    expect(second.llmCalls).toBe(0);
  });

  it("skips under high cortisol — no memory restructuring under stress", async () => {
    const result = await runCanonicalPromotion({
      db,
      store,
      llmCall: async () => "{}",
      hormones: { cortisol: 0.9 },
      maxChunks: 30,
    });
    expect(result.skippedCortisol).toBe(true);
    expect(result.chunksProcessed).toBe(0);
  });

  it("only scans world_fact/directive layers", async () => {
    const seen: string[] = [];
    const llmCall = async (prompt: string) => {
      seen.push(prompt);
      return `{"canonical":[]}`;
    };
    await runCanonicalPromotion({ db, store, llmCall, hormones: null, maxChunks: 30 });
    const all = seen.join("\n");
    expect(all).toContain("project repository");
    expect(all).not.toContain("afternoon debugging"); // experience layer excluded
  });
});
