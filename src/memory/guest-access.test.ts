import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  filterGuestResults,
  guestMayReadPath,
  maxSensitivity,
  tagSensitivity,
} from "./guest-access.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import type { MemorySearchResult } from "./types.js";

let db: DatabaseSync;

function put(id: string, path: string, text: string, governance: object | null, source = "memory") {
  db.prepare(
    "INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, governance_json) VALUES (?, ?, ?, 1, 5, 'h', 'm', ?, '[]', 0, ?)",
  ).run(id, path, source, text, governance ? JSON.stringify(governance) : null);
}

const hit = (
  path: string,
  source: MemorySearchResult["source"] = "memory",
): MemorySearchResult => ({
  path,
  startLine: 1,
  endLine: 5,
  score: 1,
  snippet: "",
  source,
});

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
});

describe("tagSensitivity", () => {
  it("tags secrets confidential, personal details personal, the rest normal", () => {
    expect(tagSensitivity("the staging api key is abc")).toBe("confidential");
    expect(tagSensitivity("my seed phrase is in the safe")).toBe("confidential");
    expect(tagSensitivity("Victor's birthday is in May")).toBe("personal");
    expect(tagSensitivity("I think the launch should slip")).toBe("personal");
    expect(tagSensitivity("The repo uses pnpm and vitest")).toBe("normal");
    // A word that only looks like a secret term does not trip it.
    expect(tagSensitivity("count the tokens in the prompt")).toBe("normal");
  });

  it("keeps the more restrictive tag", () => {
    expect(maxSensitivity("personal", "normal")).toBe("personal");
    expect(maxSensitivity("normal", "confidential")).toBe("confidential");
  });
});

describe("guest filtering", () => {
  beforeEach(() => {
    put("a", "memory/stack.md", "The repo uses pnpm and vitest", { sensitivity: "normal" });
    put("b", "memory/health.md", "Taking a new medication since June", { sensitivity: "normal" });
    put("c", "memory/notes.md", "Lunch spot list", { sensitivity: "personal" });
    put("d", "memory/insight.md", "Prefers short replies", null);
    put("e", "sessions/x.jsonl", "chat text", { sensitivity: "normal" }, "sessions");
    put("f", "MEMORY.md", "working memory", { sensitivity: "normal" });
  });

  it("returns only explicitly normal memories whose text is still normal", () => {
    const kept = filterGuestResults(db, [
      hit("memory/stack.md"),
      hit("memory/health.md"),
      hit("memory/notes.md"),
      hit("memory/insight.md"),
      hit("sessions/x.jsonl", "sessions"),
      hit("MEMORY.md"),
      hit("memory/missing.md"),
    ]);
    expect(kept.map((r) => r.path)).toEqual(["memory/stack.md"]);
  });

  it("lets a guest read a file only when every memory in it is safe", () => {
    expect(guestMayReadPath(db, "memory/stack.md")).toBe(true);
    expect(guestMayReadPath(db, "./memory/stack.md")).toBe(true);
    expect(guestMayReadPath(db, "memory/health.md")).toBe(false);
    expect(guestMayReadPath(db, "MEMORY.md")).toBe(false);
    expect(guestMayReadPath(db, "memory/unknown.md")).toBe(false);
  });
});
