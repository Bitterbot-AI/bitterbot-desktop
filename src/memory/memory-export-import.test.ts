/**
 * PLAN-55 Phase 3: export version 2 and import (v1 and v2), on isolated
 * in-memory databases.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalFactsStore } from "./canonical-facts.js";
import { ensureDreamSchema } from "./dream-schema.js";
import { writeMemoryExport } from "./memory-export.js";
import { importMemories, MemoryImportRefused, parseMemoryExport } from "./memory-import.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  addSuppression,
  chunkTextHash,
  factKeyValueHash,
  preferenceKeyHash,
} from "./memory-suppressions.js";
import { UserModelManager } from "./user-model.js";

function freshDb(): { db: DatabaseSync; store: CanonicalFactsStore } {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: true,
  });
  ensureDreamSchema(db);
  new UserModelManager(db);
  return { db, store: new CanonicalFactsStore(db) };
}

function insertChunk(
  db: DatabaseSync,
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const row: Record<string, unknown> = {
    id,
    path: `memory/${id}`,
    source: "memory",
    start_line: 0,
    end_line: 0,
    hash: `h_${id}`,
    model: "m",
    text,
    embedding: "[0.1,0.2]",
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
}

async function exportToString(
  db: DatabaseSync,
  extra: { workingMemory?: string; genome?: string } = {},
) {
  let out = "";
  const stats = await writeMemoryExport(
    db,
    (piece) => {
      out += piece;
    },
    { agentId: "main", ...extra },
  );
  return { text: out, stats, doc: JSON.parse(out) as Record<string, unknown> };
}

const TABLES = { ftsTable: "chunks_fts" };

let src: { db: DatabaseSync; store: CanonicalFactsStore };

beforeEach(() => {
  src = freshDb();
  insertChunk(src.db, "fact_1", "Victor lives in Lisbon.");
  insertChunk(src.db, "note_2", "The trip to Porto is in May.");
  insertChunk(src.db, "abc_session", "transcript words", {
    source: "sessions",
    path: "sessions/s1.jsonl",
  });
  src.store.pin({
    key: "identity.home_city",
    value: "Porto",
    source: "extraction",
    evidenceChunkIds: ["fact_1"],
  });
  src.store.pin({
    key: "identity.home_city",
    value: "Lisbon",
    source: "owner",
    evidenceChunkIds: ["fact_1"],
  });
  src.store.pin({ key: "project.repo", value: "bitterbot-desktop", source: "extraction" });
  src.db
    .prepare(
      `INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
       VALUES ('p1', 'style', 'tone', 'brief', 0.8, '["fact_1"]', 1, 1)`,
    )
    .run();
  src.db
    .prepare(
      `INSERT INTO entities (id, name, entity_type, first_seen_at, last_seen_at) VALUES ('e1','victor','person',1,1),('e2','lisbon','place',1,1)`,
    )
    .run();
  src.db
    .prepare(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, valid_from, evidence_chunk_ids, created_at, updated_at)
       VALUES ('r1','e1','e2','lives_in',1,'["fact_1"]',1,1)`,
    )
    .run();
  src.db
    .prepare(
      `INSERT INTO dream_insights (id, content, embedding, source_chunk_ids, dream_cycle_id, created_at, updated_at)
       VALUES ('ins_1', 'Victor is settled', '[1,2,3]', '["fact_1"]', 'c1', 1, 1)`,
    )
    .run();
});

describe("export v2", () => {
  it("writes every section, keeps the v1 fields, and leaves embeddings out", async () => {
    const { doc, stats } = await exportToString(src.db, {
      workingMemory: "# MEMORY",
      genome: "# GENOME",
    });
    expect(doc.version).toBe(2);
    expect(doc.format).toBe("bitterbot-memory-export");
    // v1 fields, same names and shapes.
    for (const k of [
      "exportedAt",
      "agentId",
      "memories",
      "facts",
      "preferences",
      "workingMemory",
    ]) {
      expect(doc).toHaveProperty(k);
    }
    const memories = doc.memories as Array<Record<string, unknown>>;
    expect(memories.map((m) => m.id).toSorted()).toEqual(["abc_session", "fact_1", "note_2"]);
    expect(memories.find((m) => m.id === "fact_1")).toMatchObject({
      kind: "own",
      text: "Victor lives in Lisbon.",
    });
    // Facts: all statuses, with history and evidence.
    const facts = doc.facts as Array<Record<string, unknown>>;
    expect(
      facts
        .filter((f) => f.key === "identity.home_city")
        .map((f) => f.status)
        .toSorted(),
    ).toEqual(["active", "superseded"]);
    expect(facts[0]).toHaveProperty("evidence_chunk_ids");
    expect((doc.knowledgeGraph as { relationships: unknown[] }).relationships).toHaveLength(1);
    expect((doc.knowledgeGraph as { entities: unknown[] }).entities).toHaveLength(2);
    expect(doc.dreamInsights as unknown[]).toHaveLength(1);
    for (const k of [
      "curiosityFindings",
      "conflicts",
      "directives",
      "suppressions",
      "auditLog",
      "chunkSupersessions",
    ]) {
      expect(Array.isArray(doc[k]), k).toBe(true);
    }
    expect(doc.genome).toBe("# GENOME");
    expect(JSON.stringify(doc)).not.toContain('"embedding"');
    expect(stats).toMatchObject({
      memories: 3,
      preferences: 1,
      relationships: 1,
      dreamInsights: 1,
    });
  });

  it("redacts credential-shaped text everywhere it could hide", async () => {
    insertChunk(
      src.db,
      "note_secret",
      "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwx1234",
    );
    const { text, doc } = await exportToString(src.db, {
      workingMemory: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv",
      genome: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    });
    expect(text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234");
    expect(text).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(text).not.toContain("MIIEvQIBADANBg");
    expect(text).toContain("[redacted]");
    expect(doc.redactions as number).toBeGreaterThanOrEqual(4);
  });
});

describe("import", () => {
  it("round-trips a v2 export into a fresh database", async () => {
    const { doc } = await exportToString(src.db);
    const dst = freshDb();
    const result = await importMemories(dst.db, doc, {
      actor: "owner",
      store: dst.store,
      tables: TABLES,
    });

    expect(result.version).toBe(2);
    expect(result.memories).toMatchObject({ imported: 2, fileBacked: 1 });
    const chunks = dst.db
      .prepare(`SELECT id, text, source, origin, model FROM chunks ORDER BY id`)
      .all();
    expect(chunks).toEqual([
      {
        id: "fact_1",
        text: "Victor lives in Lisbon.",
        source: "memory",
        origin: "import",
        model: "pending",
      },
      {
        id: "note_2",
        text: "The trip to Porto is in May.",
        source: "memory",
        origin: "import",
        model: "pending",
      },
    ]);
    // Keyword-searchable at once.
    expect(
      dst.db.prepare(`SELECT id FROM chunks_fts WHERE chunks_fts MATCH 'Porto'`).all(),
    ).toEqual([{ id: "note_2" }]);
    // Facts with history; the owner's fact keeps the owner tier, the rest is `import`.
    const facts = (db: DatabaseSync) =>
      db
        .prepare(
          `SELECT key, value, status, valid_until IS NULL AS cur FROM canonical_facts ORDER BY key, valid_from, cur`,
        )
        .all();
    expect(facts(dst.db)).toEqual(facts(src.db));
    expect(dst.store.get("identity.home_city")).toMatchObject({ value: "Lisbon", source: "owner" });
    expect(dst.store.get("project.repo")).toMatchObject({ source: "import" });
    expect(dst.db.prepare(`SELECT category, key, value FROM user_preferences`).all()).toEqual([
      { category: "style", key: "tone", value: "brief" },
    ]);
    expect(
      dst.db.prepare(`SELECT event FROM memory_audit_log WHERE event = 'owner_import'`).all(),
    ).toHaveLength(1);

    // Importing the same export again changes nothing.
    const again = await importMemories(dst.db, doc, {
      actor: "owner",
      store: dst.store,
      tables: TABLES,
    });
    expect(again.memories).toMatchObject({ imported: 0, duplicate: 2 });
    expect(again.facts).toMatchObject({ imported: 0, duplicate: 2 });
    expect(again.preferences).toMatchObject({ imported: 0, duplicate: 1 });
  });

  it("still reads a version 1 export", async () => {
    const v1 = {
      exportedAt: "2026-10-01T00:00:00.000Z",
      agentId: "main",
      memories: [
        {
          id: "fact_9",
          kind: "own",
          source: "sessions",
          path: "/x/s.jsonl",
          semanticType: "fact",
          lifecycle: "generated",
          importance: 0.5,
          createdAt: 1,
          updatedAt: 1,
          text: "Victor drinks dark roast.",
        },
        {
          id: "fact_gone",
          kind: "own",
          source: "memory",
          path: null,
          semanticType: "fact",
          lifecycle: "forgotten",
          importance: 0.5,
          createdAt: 1,
          updatedAt: 1,
          text: "old",
        },
      ],
      facts: [
        {
          key: "preference.coffee",
          value: "dark roast",
          statement: "coffee: dark roast",
          category: "preference",
          confidence: 0.8,
          status: "active",
          valid_from: 1,
          valid_until: null,
          superseded_by: null,
          source: "extraction",
          scope: "global",
          evidence_ref: null,
        },
      ],
      preferences: [
        {
          category: "style",
          key: "tone",
          value: "brief",
          confidence: 0.8,
          created_at: 1,
          updated_at: 1,
        },
      ],
      workingMemory: null,
    };
    const dst = freshDb();
    const result = await importMemories(dst.db, parseMemoryExport(JSON.stringify(v1)), {
      actor: "owner",
      store: dst.store,
      tables: TABLES,
    });
    expect(result.version).toBe(1);
    expect(result.memories).toMatchObject({ imported: 1, forgotten: 1 });
    expect(dst.store.get("preference.coffee")).toMatchObject({
      value: "dark roast",
      source: "import",
    });
    expect(result.preferences.imported).toBe(1);
  });

  it("keeps an owner fact at the owner tier only when the owner imports", async () => {
    const { doc } = await exportToString(src.db);
    const dst = freshDb();
    await importMemories(dst.db, doc, { actor: "system", store: dst.store, tables: TABLES });
    expect(dst.store.get("identity.home_city")).toMatchObject({
      value: "Lisbon",
      source: "import",
    });
  });

  it("never replaces a higher-tier active fact; an equal tier goes through the ledger", async () => {
    const { doc } = await exportToString(src.db);
    const dst = freshDb();
    dst.store.pin({ key: "identity.home_city", value: "Madrid", source: "agent_pin" });
    dst.store.pin({ key: "project.repo", value: "other-repo", source: "extraction" });
    const result = await importMemories(dst.db, doc, {
      actor: "system",
      store: dst.store,
      tables: TABLES,
    });
    expect(dst.store.get("identity.home_city")?.value).toBe("Madrid");
    expect(result.facts.lowerTier).toBe(1);
    expect(dst.store.get("project.repo")).toMatchObject({
      value: "bitterbot-desktop",
      source: "import",
    });
  });

  it("honours this agent's suppressions", async () => {
    const { doc } = await exportToString(src.db);
    const dst = freshDb();
    addSuppression(dst.db, { kind: "chunk_hash", hash: chunkTextHash("Victor lives in Lisbon.") });
    addSuppression(dst.db, {
      kind: "fact_key_value",
      hash: factKeyValueHash("project.repo", "bitterbot-desktop"),
    });
    addSuppression(dst.db, { kind: "preference_key", hash: preferenceKeyHash("style", "tone") });
    const result = await importMemories(dst.db, doc, {
      actor: "owner",
      store: dst.store,
      tables: TABLES,
    });
    expect(result.memories.suppressed).toBe(1);
    expect(result.facts.suppressed).toBe(1);
    expect(result.preferences.suppressed).toBe(1);
    expect(dst.db.prepare(`SELECT id FROM chunks`).all()).toEqual([{ id: "note_2" }]);
    expect(dst.store.get("project.repo")).toBeNull();
  });

  it("a dry run counts and writes nothing", async () => {
    const { doc } = await exportToString(src.db);
    const dst = freshDb();
    const result = await importMemories(dst.db, doc, {
      actor: "owner",
      dryRun: true,
      store: dst.store,
      tables: TABLES,
    });
    expect(result).toMatchObject({
      dryRun: true,
      memories: { imported: 2 },
      facts: { imported: 2 },
    });
    expect(dst.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get()).toEqual({ n: 0 });
    expect(dst.db.prepare(`SELECT COUNT(*) AS n FROM canonical_facts`).get()).toEqual({ n: 0 });
    expect(dst.db.prepare(`SELECT COUNT(*) AS n FROM memory_audit_log`).get()).toEqual({ n: 0 });
  });

  it("refuses what is not an export, and an export over the size cap", async () => {
    const dst = freshDb();
    await expect(
      importMemories(dst.db, { hello: 1 }, { actor: "owner", store: dst.store, tables: TABLES }),
    ).rejects.toBeInstanceOf(MemoryImportRefused);
    expect(() => parseMemoryExport("{not json")).toThrow(/not JSON/);
    expect(() => parseMemoryExport(JSON.stringify({ memories: [] }), 10)).toThrow(/capped at/);
  });

  it("refuses secret-shaped facts and counts invalid items", async () => {
    const dst = freshDb();
    const result = await importMemories(
      dst.db,
      {
        memories: [{ id: "fact_x" }],
        facts: [{ key: "infra.api_token", value: "sk-ant-api03-abcdefghijklmnopqrstuv" }],
      },
      { actor: "owner", store: dst.store, tables: TABLES },
    );
    expect(result.memories.invalid).toBe(1);
    expect(result.facts.secret).toBe(1);
    expect(dst.store.get("infra.api_token")).toBeNull();
  });
});
