/**
 * PLAN-43 Phase 3 (§3.3): the lineage-laundering gate. A copy or
 * near-duplicate of a commons skill is refused at listing time unless the
 * candidate cites that lineage BY AUTHOR; distinct skills and cited
 * derivatives pass. Hardened per the 2026-09-03 adversarial pass:
 * hash-first, fail-closed on a missing embedding, same-model comparison,
 * self-versions excluded, crystal-id citations rejected.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkListingLineage,
  contentSha256,
  LINEAGE_FLAG_COSINE,
  LINEAGE_NEAR_DUPLICATE_COSINE,
  normalizedContentSha256,
  resetLineageCache,
} from "./lineage-gate.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db: d, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
  ensureColumn(d, "chunks", "publish_visibility", "TEXT");
  ensureColumn(d, "chunks", "semantic_type", "TEXT");
  ensureColumn(d, "chunks", "provenance_chain", "TEXT");
  ensureColumn(d, "chunks", "governance_json", "TEXT");
  ensureColumn(d, "chunks", "stable_skill_id", "TEXT");
  return d;
}

function insert(
  d: DatabaseSync,
  id: string,
  text: string,
  embedding: number[] | null,
  opts: {
    peerOrigin?: string;
    shared?: boolean;
    provenance?: string[];
    model?: string;
    stableSkillId?: string;
  } = {},
): void {
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
       semantic_type, publish_visibility, provenance_chain, governance_json, stable_skill_id)
     VALUES (?, ?, 'memory', 0, 0, ?, ?, ?, ?, 0, 'skill', ?, ?, ?, ?)`,
  ).run(
    id,
    `skills/${id}`,
    `h-${id}`,
    opts.model ?? "test",
    text,
    embedding ? JSON.stringify(embedding) : "",
    opts.shared ? "shared" : null,
    JSON.stringify(opts.provenance ?? []),
    JSON.stringify({
      accessScope: "shared",
      ...(opts.peerOrigin ? { peerOrigin: opts.peerOrigin } : {}),
    }),
    opts.stableSkillId ?? null,
  );
}

const BASE = [1, 0, 0, 0];
const NEAR = [0.99, 0.14, 0, 0]; // cosine ≈ 0.99
const MID = [0.85, 0.53, 0, 0]; // cosine ≈ 0.85: flag tier
const FAR = [0, 1, 0, 0]; // cosine 0

describe("checkListingLineage", () => {
  let d: DatabaseSync;
  beforeEach(() => {
    resetLineageCache();
    d = db();
    insert(d, "commons-1", "# Commons skill\nDo the thing.", BASE, { peerOrigin: "pk-alice" });
  });

  it("refuses a near-duplicate of a peer-origin commons skill without cited lineage", () => {
    insert(d, "launder", "# Commons skill (reworded)\nDo the thing, but mine.", NEAR);
    const r = checkListingLineage(d, "launder");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("near-duplicate");
    expect(r.reason).toContain("cite the source author");
    expect(r.nearest?.crystalId).toBe("commons-1");
    expect(r.nearest?.authorPubkey).toBe("pk-alice");
    expect(r.nearest!.similarity).toBeGreaterThanOrEqual(LINEAGE_NEAR_DUPLICATE_COSINE);
    expect(r.contentSha256).toBe(
      contentSha256("# Commons skill (reworded)\nDo the thing, but mine."),
    );
  });

  it("allows the derivative when it cites the source's AUTHOR and returns who is owed", () => {
    insert(d, "cited", "# Derived\nDo the thing, improved.", NEAR, { provenance: ["pk-alice"] });
    const r = checkListingLineage(d, "cited");
    expect(r.ok).toBe(true);
    expect(r.lineageAuthorPubkey).toBe("pk-alice");
  });

  it("citing the source CRYSTAL ID (disclosed by the refusal) does not satisfy the gate", () => {
    insert(d, "id-cite", "# Derived\nDo the thing, improved.", NEAR, { provenance: ["commons-1"] });
    expect(checkListingLineage(d, "id-cite").ok).toBe(false);
  });

  it("hash-first: an exact copy is refused even with no embedding at all", () => {
    insert(d, "copy", "# Commons skill\nDo the thing.", null);
    const r = checkListingLineage(d, "copy");
    expect(r.ok).toBe(false);
    expect(r.nearest?.similarity).toBe(1);
    expect(r.nearest?.crystalId).toBe("commons-1");
  });

  it("hash-first: frontmatter, provenance trailers, and whitespace do not defeat the copy check", () => {
    const disguised =
      '---\nname: mine\n---\n\n#   Commons   skill\nDO THE THING.\n<!-- wiki-evolution-provenance {"x":1} -->';
    expect(normalizedContentSha256(disguised)).toBe(
      normalizedContentSha256("# Commons skill\nDo the thing."),
    );
    insert(d, "disguised", disguised, null);
    expect(checkListingLineage(d, "disguised").ok).toBe(false);
  });

  it("allows a genuinely different skill on the same topic", () => {
    insert(d, "distinct", "# Other skill\nSomething else entirely.", FAR);
    const r = checkListingLineage(d, "distinct");
    expect(r.ok).toBe(true);
    expect(r.flagged).toBeUndefined();
    expect(r.nearest?.similarity).toBeLessThan(LINEAGE_NEAR_DUPLICATE_COSINE);
  });

  it("flags (allows, records) a possible paraphrase in the 0.80-0.92 band", () => {
    insert(d, "para", "# Reworked commons\nDo roughly the thing, differently phrased.", MID);
    const r = checkListingLineage(d, "para");
    expect(r.ok).toBe(true);
    expect(r.flagged).toBe(true);
    expect(r.nearest!.similarity).toBeGreaterThanOrEqual(LINEAGE_FLAG_COSINE);
  });

  it("a copy of this node's OWN free-shared skill owes nobody lineage (self-owned commons)", () => {
    insert(d, "shared-local", "# Shared local\nText.", FAR, { shared: true });
    insert(d, "copycat", "# Shared local copy\nText.", FAR);
    const r = checkListingLineage(d, "copycat");
    expect(r.ok).toBe(true);
    expect(r.nearest?.crystalId).toBe("shared-local");
    expect(r.lineageAuthorPubkey).toBeUndefined();
  });

  it("fails CLOSED when the candidate has no embedding and a commons exists", () => {
    insert(d, "noemb", "# Unembedded\nNot a copy.", null);
    const r = checkListingLineage(d, "noemb");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("embedding not indexed yet");
  });

  it("an empty commons needs no comparison (fresh node lists without embedding latency)", () => {
    const fresh = db();
    insert(fresh, "only", "# Only skill", null);
    expect(checkListingLineage(fresh, "only").ok).toBe(true);
  });

  it("compares only against rows embedded by the SAME model", () => {
    insert(d, "other-model", "# Commons skill (reworded)\nDo the thing, but mine.", NEAR, {
      model: "other-embedder",
    });
    const r = checkListingLineage(d, "other-model");
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("same model");
  });

  it("other versions of the same local skill are self, not the commons", () => {
    resetLineageCache();
    const own = db();
    insert(own, "v1", "# Mine v1\nText.", BASE, { shared: true, stableSkillId: "stable-1" });
    insert(own, "v2", "# Mine v2\nText.", NEAR, { stableSkillId: "stable-1" });
    expect(checkListingLineage(own, "v2").ok).toBe(true);
  });
});
