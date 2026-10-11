/**
 * PLAN-55 Phase 2: the canonical:changed dispatcher. Off the write path,
 * in order, only for committed writes, one failing consumer never stops the
 * others, and the whole chain from an owner correction lands in every store.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../tasks/store.js";
import { readTaskStaleFacts } from "../tasks/types.js";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { CanonicalFactsStore } from "./canonical-facts.js";
import { CanonicalPropagation, isCanonicalChangeCommitted } from "./canonical-propagation.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { inSavepoint } from "./memory-suppressions.js";
import { UserModelManager } from "./user-model.js";

let db: DatabaseSync;
let store: CanonicalFactsStore;
let tasks: TaskStore;
let kg: KnowledgeGraphManager;
let propagation: CanonicalPropagation;

const KEY = "infra.deploy_endpoint";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  new UserModelManager(db);
  store = new CanonicalFactsStore(db);
  tasks = new TaskStore(new DatabaseSync(":memory:"));
  kg = new KnowledgeGraphManager(db);
  propagation = new CanonicalPropagation({
    getDb: () => db,
    getKnowledgeGraph: () => kg,
    getDirectives: () => null,
    getTaskStore: () => tasks,
  });
  store.onChanged((e) => propagation.enqueue(e));
});

afterEach(() => {
  propagation.close();
});

function chunk(id: string, text: string): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, 'memory/n.md', 'memory', 1, 1, ?, 'm', ?, '[]', 1)`,
  ).run(id, `h-${id}`, text);
}

const marked = (): string[] =>
  (
    db.prepare(`SELECT chunk_id FROM chunk_supersessions ORDER BY chunk_id`).all() as Array<{
      chunk_id: string;
    }>
  ).map((r) => r.chunk_id);

describe("CanonicalPropagation", () => {
  it("runs nothing inside the write; everything after idle()", async () => {
    chunk("old", "deploy endpoint: api.acme.com");
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    store.pin({ key: KEY, value: "api2.acme.com", source: "owner" });
    expect(marked()).toEqual([]); // still queued: the turn is not blocked
    await propagation.idle();
    expect(marked()).toEqual(["old"]);
  });

  it("end to end: one owner correction reaches search, preferences, graph and tasks", async () => {
    chunk("old", "deploy endpoint: api.acme.com");
    db.prepare(
      `INSERT INTO user_preferences (id, category, key, value, created_at, updated_at)
       VALUES ('p', 'infra', 'deploy_endpoint', 'api.acme.com', 1, 1)`,
    ).run();
    kg.upsertRelationship({
      sourceName: "deploy pipeline",
      sourceType: "concept",
      targetName: "api.acme.com",
      targetType: "concept",
      relationType: "uses",
    });
    const task = tasks.create({ goal: "Push the build to api.acme.com", doneCriteria: "live" });
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    store.pin({ key: KEY, value: "api2.acme.com", source: "owner" });
    await propagation.idle();

    expect(marked()).toEqual(["old"]);
    expect(
      (db.prepare(`SELECT value FROM user_preferences WHERE id = 'p'`).get() as { value: string })
        .value,
    ).toBe("api2.acme.com");
    const open = db
      .prepare(
        `SELECT t.name FROM relationships r JOIN entities t ON t.id = r.target_entity_id
          WHERE r.valid_until IS NULL`,
      )
      .all() as Array<{ name: string }>;
    expect(open.map((r) => r.name)).toEqual(["api2.acme.com"]);
    expect(readTaskStaleFacts(tasks.get(task.id)!)).toHaveLength(1);

    // Re-pin back to the old value undoes the marks and flags.
    store.pin({ key: KEY, value: "api.acme.com", source: "owner" });
    await propagation.idle();
    expect(marked()).toEqual([]);
    expect(readTaskStaleFacts(tasks.get(task.id)!)).toEqual([]);
  });

  it("propagates nothing for a write that rolled back", async () => {
    chunk("old", "deploy endpoint: api.acme.com");
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    await propagation.idle();
    expect(() =>
      inSavepoint(db, "test_rollback", () => {
        store.pin({ key: KEY, value: "api2.acme.com", source: "owner" });
        throw new Error("caller failed after the pin");
      }),
    ).toThrow("caller failed");
    expect(store.get(KEY)!.value).toBe("api.acme.com");
    const outcomes: string[] = [];
    propagation.onOutcome((o) => outcomes.push(o.skipped ?? "ran"));
    await propagation.idle();
    expect(outcomes).toEqual(["not_committed"]);
    expect(marked()).toEqual([]);
  });

  it("isCanonicalChangeCommitted reads the row, per op", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "owner" });
    const fact = store.get(KEY)!;
    const base: CanonicalChangeEvent = {
      key: KEY,
      oldValue: null,
      newValue: "api.acme.com",
      op: "add",
      tier: 3,
      source: "owner",
      scope: "global",
      evidence: { ref: null, chunkIds: [] },
      factId: fact.id,
      at: 1,
    };
    expect(isCanonicalChangeCommitted(db, base)).toBe(true);
    expect(isCanonicalChangeCommitted(db, { ...base, factId: "missing" })).toBe(false);
    expect(isCanonicalChangeCommitted(db, { ...base, op: "retire", newValue: null })).toBe(false);
    store.retire(KEY, { reason: "owner" });
    expect(isCanonicalChangeCommitted(db, { ...base, op: "retire", newValue: null })).toBe(true);
  });

  it("a failing consumer is logged and the others still run", async () => {
    chunk("old", "deploy endpoint: api.acme.com");
    const task = tasks.create({ goal: "Push to api.acme.com", doneCriteria: "live" });
    // The graph consumer throws outright: its getter fails.
    const p2 = new CanonicalPropagation({
      getDb: () => db,
      getKnowledgeGraph: () => {
        throw new Error("graph unavailable");
      },
      getDirectives: () => null,
      getTaskStore: () => tasks,
    });
    store.onChanged((e) => p2.enqueue(e));
    propagation.close();
    const outcomes: Array<{ errors: Record<string, string> }> = [];
    p2.onOutcome((o) => outcomes.push({ errors: o.errors as Record<string, string> }));
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    store.pin({ key: KEY, value: "api2.acme.com", source: "owner" });
    await p2.idle();
    expect(outcomes.at(-1)!.errors.graph).toContain("graph unavailable");
    expect(marked()).toEqual(["old"]);
    expect(readTaskStaleFacts(tasks.get(task.id)!)).toHaveLength(1);
    p2.close();
  });

  it("handles events in order and stops after close()", async () => {
    const seen: string[] = [];
    propagation.onOutcome((o) => seen.push(`${o.event.op}:${o.event.newValue}`));
    store.pin({ key: KEY, value: "a.acme.com", source: "owner" });
    store.pin({ key: KEY, value: "b.acme.com", source: "owner" });
    store.pin({ key: KEY, value: "c.acme.com", source: "owner" });
    await propagation.idle();
    expect(seen).toEqual(["add:a.acme.com", "supersede:b.acme.com", "supersede:c.acme.com"]);
    propagation.close();
    store.pin({ key: KEY, value: "d.acme.com", source: "owner" });
    await propagation.idle();
    expect(seen).toHaveLength(3);
  });
});
