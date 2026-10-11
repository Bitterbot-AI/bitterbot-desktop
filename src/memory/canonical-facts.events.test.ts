/**
 * PLAN-55 Phase 2: the ledger emits `canonical:changed` once per change of a
 * key's current value, after its statements ran, and never for a write that
 * changed nothing (rejected, held, plain re-confirmation).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalChangeMarksStale, type CanonicalChangeEvent } from "./canonical-events.js";
import { CanonicalFactsStore } from "./canonical-facts.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

let db: DatabaseSync;
let store: CanonicalFactsStore;
let events: CanonicalChangeEvent[];

const KEY = "infra.deploy_endpoint";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  store = new CanonicalFactsStore(db);
  events = [];
  store.onChanged((e) => events.push(e));
});

describe("canonical:changed emission", () => {
  it("emits add with no old value", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction", evidenceRef: "q" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: KEY,
      op: "add",
      oldValue: null,
      newValue: "api.acme.com",
      tier: 1,
      source: "extraction",
      scope: "global",
      evidence: { ref: "q", chunkIds: [] },
    });
    expect(events[0]!.factId).toBe(store.get(KEY)!.id);
  });

  it("emits supersede with old and new value, the new row id and the writer's tier", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" });
    store.pin({ key: KEY, value: "api2.acme.com", source: "owner", evidenceChunkIds: ["c1"] });
    const e = events.at(-1)!;
    expect(e).toMatchObject({
      op: "supersede",
      oldValue: "api.acme.com",
      newValue: "api2.acme.com",
      tier: 3,
      evidence: { chunkIds: ["c1"] },
    });
    expect(e.factId).toBe(store.get(KEY)!.id);
    expect(canonicalChangeMarksStale(e)).toBe(true);
  });

  it("does not emit for a re-confirmation, a rejection or a held agent supersede", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "owner" });
    events.length = 0;
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }); // strengthen
    store.pin({ key: KEY, value: "other.acme.com", source: "extraction" }); // tier reject
    const held = store.pin({ key: KEY, value: "agent.acme.com", source: "agent_pin" });
    expect(held.op).toBe("held");
    expect(events).toEqual([]);
  });

  it("emits retire with the reason; only the owner's retire marks the old value stale", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    store.retire(KEY, { reason: "decay" });
    const decay = events.at(-1)!;
    expect(decay).toMatchObject({ op: "retire", retireReason: "decay", newValue: null });
    expect(canonicalChangeMarksStale(decay)).toBe(false);

    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }); // reactivates
    expect(events.at(-1)).toMatchObject({ op: "reactivate", newValue: "api.acme.com" });

    store.retire(KEY, { reason: "owner" });
    const owner = events.at(-1)!;
    expect(owner).toMatchObject({
      op: "retire",
      retireReason: "owner",
      oldValue: "api.acme.com",
      tier: 3,
    });
    expect(canonicalChangeMarksStale(owner)).toBe(true);
  });

  it("emits unretire with the value that is current again", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    store.retire(KEY, { reason: "owner" });
    store.unretire(KEY);
    expect(events.at(-1)).toMatchObject({
      op: "unretire",
      oldValue: null,
      newValue: "api.acme.com",
      tier: 3,
    });
  });

  it("a throwing listener does not break the write or the other listeners", () => {
    const seen: string[] = [];
    store.onChanged(() => {
      throw new Error("boom");
    });
    store.onChanged((e) => seen.push(e.op));
    const res = store.pin({ key: KEY, value: "api.acme.com", source: "owner" });
    expect(res.op).toBe("add");
    expect(seen).toEqual(["add"]);
  });

  it("unsubscribes", () => {
    const off = store.onChanged(() => {
      throw new Error("should not run");
    });
    off();
    expect(() => store.pin({ key: KEY, value: "x.acme.com", source: "owner" })).not.toThrow();
  });

  it("writes every change to the outbox in the writer's transaction, with the old evidence", () => {
    store.pin({
      key: KEY,
      value: "api.acme.com",
      source: "extraction",
      evidenceChunkIds: ["c-old"],
    });
    store.pin({ key: KEY, value: "api2.acme.com", source: "owner", evidenceChunkIds: ["c-new"] });
    expect(events.at(-1)!.oldEvidence).toEqual({ ref: null, chunkIds: ["c-old"] });
    const rows = db
      .prepare(`SELECT id, key, event_json, propagated_at FROM canonical_change_outbox ORDER BY id`)
      .all() as Array<{
      id: number;
      key: string;
      event_json: string;
      propagated_at: number | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(events.at(-1)!.outboxId).toBe(rows[1]!.id);
    expect(JSON.parse(rows[1]!.event_json)).toMatchObject({
      op: "supersede",
      oldValue: "api.acme.com",
    });
    expect(rows.every((r) => r.propagated_at === null)).toBe(true);

    // A rolled-back write leaves no outbox row.
    db.exec("SAVEPOINT t");
    store.pin({ key: KEY, value: "api3.acme.com", source: "owner" });
    db.exec("ROLLBACK TO t");
    db.exec("RELEASE t");
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM canonical_change_outbox`).get() as { n: number }).n,
    ).toBe(2);
  });
});
