import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { createSqliteInterceptorStrikesStore } from "./interceptor-strikes-store.js";

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

describe("interceptor-strikes-store", () => {
  let conn: DatabaseSync;
  let store: ReturnType<typeof createSqliteInterceptorStrikesStore>;
  beforeEach(() => {
    conn = db();
    store = createSqliteInterceptorStrikesStore(conn);
  });

  it("recordStrike increments strikes and disables at 3", () => {
    const r1 = store.recordStrike("foo:1", "boom 1");
    const r2 = store.recordStrike("foo:1", "boom 2");
    const r3 = store.recordStrike("foo:1", "boom 3");
    expect(r1).toEqual({ strikes: 1, disabled: false });
    expect(r2).toEqual({ strikes: 2, disabled: false });
    expect(r3).toEqual({ strikes: 3, disabled: true });
  });

  it("loadDisabled returns only disabled ids", () => {
    store.recordStrike("a:1", "x");
    store.recordStrike("b:1", "x");
    store.recordStrike("b:1", "x");
    store.recordStrike("b:1", "x"); // → disabled
    expect(store.loadDisabled()).toEqual(["b:1"]);
  });

  it("clear removes the row", () => {
    store.recordStrike("a:1", "x");
    store.recordStrike("a:1", "x");
    store.recordStrike("a:1", "x"); // disabled
    expect(store.loadDisabled()).toEqual(["a:1"]);
    store.clear("a:1");
    expect(store.loadDisabled()).toEqual([]);
  });

  it("list returns rows ordered by interceptor_id", () => {
    store.recordStrike("zzz:1", "x");
    store.recordStrike("aaa:1", "x");
    const list = store.list();
    expect(list.map((r) => r.interceptorId)).toEqual(["aaa:1", "zzz:1"]);
  });
});
