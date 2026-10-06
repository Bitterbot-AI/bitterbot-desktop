import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { UserModelManager } from "./user-model.js";
import {
  deletePreference,
  editMemory,
  exportMemories,
  forgetMemory,
  getMemory,
  listMemories,
  listPreferences,
  OwnerEditRefused,
} from "./owner-controls.js";

const TABLES = { ftsTable: "chunks_fts", vectorTable: null };
let db: DatabaseSync;

function insert(id: string, text: string, extra: Record<string, unknown> = {}) {
  const row = {
    id,
    path: extra.path ?? `memory/${id}`,
    source: extra.source ?? "memory",
    start_line: 0,
    end_line: 0,
    hash: id,
    model: "m",
    text,
    embedding: "[]",
    updated_at: 1,
    lifecycle: extra.lifecycle ?? "generated",
    lifecycle_state: extra.lifecycle_state ?? "active",
    semantic_type: extra.semantic_type ?? "fact",
    created_at: extra.created_at ?? 1,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO chunks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...(Object.values(row) as Array<string | number>));
  db.prepare(
    "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, 'm', 0, 0)",
  ).run(text, id, String(row.path), String(row.source));
}

const ftsIds = (term: string) =>
  (
    db.prepare("SELECT id FROM chunks_fts WHERE chunks_fts MATCH ?").all(term) as Array<{
      id: string;
    }>
  ).map((r) => r.id);

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: true,
  });
  // Created by UserModelManager in the real gateway.
  new UserModelManager(db);
  insert("fact_1", "Victor prefers dark roast coffee");
  insert("note_2", "The trip to Lisbon is in May");
  insert("abc123", "session transcript about coffee", {
    source: "sessions",
    path: "sessions/s1.jsonl",
  });
  insert("seed_frozen", "core value", { lifecycle: "frozen" });
  insert("fact_gone", "old fact", { lifecycle: "expired", lifecycle_state: "forgotten" });
});

describe("listing", () => {
  it("lists the agent's own memories, newest first, without forgotten ones", () => {
    const { memories } = listMemories(db);
    expect(memories.map((m) => m.id)).toEqual(["seed_frozen", "note_2", "fact_1"]);
    expect(memories.find((m) => m.id === "seed_frozen")?.editable).toBe(false);
    expect(memories.find((m) => m.id === "fact_1")).toMatchObject({ kind: "own", editable: true });
  });

  it("filters by kind and text, and pages", () => {
    expect(listMemories(db, { kind: "file" }).memories.map((m) => m.id)).toEqual(["abc123"]);
    expect(listMemories(db, { kind: "all", q: "COFFEE" }).memories.map((m) => m.id)).toEqual([
      "abc123",
      "fact_1",
    ]);
    expect(listMemories(db, { q: "100%" }).memories).toEqual([]);
    const first = listMemories(db, { limit: 2 });
    expect(first.memories).toHaveLength(2);
    const second = listMemories(db, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.memories.map((m) => m.id)).toEqual(["fact_1"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("forgetting", () => {
  it("removes the memory from the table and the keyword index, and records it without the text", () => {
    forgetMemory(db, "fact_1", TABLES);

    expect(getMemory(db, "fact_1")).toBeNull();
    expect(ftsIds("roast")).toEqual([]);
    const audit = db
      .prepare("SELECT event, actor, metadata FROM memory_audit_log WHERE chunk_id = 'fact_1'")
      .get() as {
      event: string;
      actor: string;
      metadata: string;
    };
    expect(audit).toMatchObject({ event: "owner_forget", actor: "owner" });
    expect(audit.metadata).not.toContain("roast");
  });

  it("refuses memories rebuilt from files, frozen ones and unknown ids", () => {
    expect(() => forgetMemory(db, "abc123", TABLES)).toThrow(/change the file instead/);
    expect(() => forgetMemory(db, "seed_frozen", TABLES)).toThrow(OwnerEditRefused);
    expect(() => forgetMemory(db, "fact_nope", TABLES)).toThrow(/no memory/);
    expect(getMemory(db, "abc123")).not.toBeNull();
  });
});

describe("editing", () => {
  it("replaces the text, re-indexes it for keyword search and marks it for re-embedding", () => {
    const edited = editMemory(db, "fact_1", "Victor prefers light roast now", TABLES);

    expect(edited).toMatchObject({ text: "Victor prefers light roast now", version: 2 });
    expect(ftsIds("light")).toEqual(["fact_1"]);
    expect(ftsIds("dark")).toEqual([]);
    const row = db
      .prepare("SELECT model, length(embedding) AS n FROM chunks WHERE id = 'fact_1'")
      .get() as {
      model: string;
      n: number;
    };
    expect(row).toEqual({ model: "pending", n: 0 });
  });

  it("refuses empty text and file memories", () => {
    expect(() => editMemory(db, "fact_1", "   ", TABLES)).toThrow(/empty/);
    expect(() => editMemory(db, "abc123", "x", TABLES)).toThrow(OwnerEditRefused);
  });
});

describe("export", () => {
  it("writes every memory with metadata and no embeddings, plus preferences", async () => {
    db.prepare(
      "INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at) VALUES ('p1','style','tone','brief',0.8,'[]',1,1)",
    ).run();
    const out = path.join(await mkdtemp(path.join(tmpdir(), "mem-export-")), "export.json");

    const result = await exportMemories(db, out, { agentId: "main", workingMemory: "# MEMORY" });

    expect(result).toMatchObject({ memories: 5, preferences: 1 });
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(parsed.memories.find((m: { id: string }) => m.id === "fact_gone").lifecycle).toBe(
      "forgotten",
    );
    expect(JSON.stringify(parsed)).not.toContain("embedding");
    expect(parsed.workingMemory).toBe("# MEMORY");
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe("preferences", () => {
  it("lists and removes a learned preference", () => {
    db.prepare(
      "INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at) VALUES ('p1','style','tone','brief',0.8,'[]',1,1)",
    ).run();
    expect(listPreferences(db)).toEqual([
      { category: "style", key: "tone", value: "brief", confidence: 0.8 },
    ]);
    expect(deletePreference(db, "style", "tone")).toBe(true);
    expect(listPreferences(db)).toEqual([]);
  });
});
