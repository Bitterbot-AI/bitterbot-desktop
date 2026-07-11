/**
 * PLAN-34 Phase 4 — the promotion gate's mechanical, ungameable legs.
 * Pure logic over injected rows; no LLM, no DB writes.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assessGrounding,
  emptyRejections,
  GROUNDING_SIMILARITY_FLOOR,
  loadSourceChunks,
  type PromotionCandidateInsight,
  type SourceChunkRow,
} from "./dream-insight-promotion.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

// Unit-vector embeddings so cosine similarity is exactly controllable.
const ALIGNED = [1, 0, 0, 0];
const NEAR = [0.95, 0.312, 0, 0]; // ~0.95 cosine to ALIGNED
const ORTHOGONAL = [0, 1, 0, 0];

function src(over: Partial<SourceChunkRow> & { id: string }): SourceChunkRow {
  return {
    embedding: ALIGNED,
    origin: "indexed",
    semanticType: "fact",
    sessionTrust: "first_party",
    ...over,
  };
}

function insight(over: Partial<PromotionCandidateInsight> = {}): PromotionCandidateInsight {
  return {
    id: "i1",
    content: "A hypothesis.",
    confidence: 0.8,
    mode: "simulation",
    embedding: ALIGNED,
    sourceChunkIds: ["a", "b", "c"],
    ...over,
  };
}

describe("assessGrounding", () => {
  it("promotes a well-grounded first-party insight with >= 2 non-dream ancestors", () => {
    const rej = emptyRejections();
    const g = assessGrounding(
      insight(),
      [src({ id: "a", embedding: ALIGNED }), src({ id: "b", embedding: NEAR })],
      rej,
    );
    expect(g).not.toBeNull();
    expect(g!.groundedSources).toHaveLength(2);
  });

  it("rejects ineligible modes (compression/exploration/mutation)", () => {
    const rej = emptyRejections();
    for (const mode of ["compression", "exploration", "mutation", "replay"]) {
      expect(assessGrounding(insight({ mode }), [src({ id: "a" })], rej)).toBeNull();
    }
    expect(rej.ineligibleMode).toBe(4);
  });

  it("fails closed on a missing insight embedding", () => {
    const rej = emptyRejections();
    expect(assessGrounding(insight({ embedding: [] }), [src({ id: "a" })], rej)).toBeNull();
    expect(rej.noEmbedding).toBe(1);
  });

  it("requires >= 2 sources above the similarity floor (citing everything cannot pass)", () => {
    const rej = emptyRejections();
    // Five offered inputs; only ONE is similar — top-half cutoff + floor
    // means < 2 grounded.
    const g = assessGrounding(
      insight({ sourceChunkIds: ["a", "b", "c", "d", "e"] }),
      [
        src({ id: "a", embedding: ALIGNED }),
        src({ id: "b", embedding: ORTHOGONAL }),
        src({ id: "c", embedding: ORTHOGONAL }),
        src({ id: "d", embedding: ORTHOGONAL }),
        src({ id: "e", embedding: ORTHOGONAL }),
      ],
      rej,
    );
    expect(g).toBeNull();
    expect(rej.insufficientGrounding).toBe(1);
  });

  it("requires >= 2 NON-dream ancestors (dream-on-dream grounding blocked)", () => {
    const rej = emptyRejections();
    const g = assessGrounding(
      insight(),
      [
        src({ id: "a", embedding: ALIGNED, origin: "dream" }),
        src({ id: "b", embedding: NEAR, origin: "dream" }),
      ],
      rej,
    );
    expect(g).toBeNull();
    expect(rej.insufficientNonDreamAncestors).toBe(1);
  });

  it("requires >= 1 first-party source", () => {
    const rej = emptyRejections();
    const g = assessGrounding(
      insight(),
      [
        src({ id: "a", embedding: ALIGNED, sessionTrust: "untrusted" }),
        src({ id: "b", embedding: NEAR, sessionTrust: null }),
      ],
      rej,
    );
    expect(g).toBeNull();
    expect(rej.noFirstPartySource).toBe(1);
  });

  it("the floor is enforced (a below-floor similar-but-not-enough source does not count)", () => {
    const rej = emptyRejections();
    // Both sources orthogonal → 0 similarity, below the 0.4 floor.
    expect(GROUNDING_SIMILARITY_FLOOR).toBe(0.4);
    const g = assessGrounding(
      insight(),
      [src({ id: "a", embedding: ORTHOGONAL }), src({ id: "b", embedding: ORTHOGONAL })],
      rej,
    );
    expect(g).toBeNull();
  });
});

describe("loadSourceChunks", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
  });

  it("drops promoted dream-insight chunks so they can never ground a new insight", () => {
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         origin, semantic_type, session_trust, created_at, updated_at)
       VALUES (?, ?, 'memory', 0, 0, ?, ?, 'test', '[1,0,0,0]', ?, ?, ?, ?, ?)`,
    );
    ins.run("real", "p", "real fact", "h1", "indexed", "fact", "first_party", now, now);
    ins.run("dreamy", "p", "a dream insight", "h2", "dream", "insight", "first_party", now, now);
    const loaded = loadSourceChunks(db, ["real", "dreamy"]);
    expect(loaded.map((c) => c.id)).toEqual(["real"]);
  });
});
