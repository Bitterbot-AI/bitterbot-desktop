/**
 * PLAN-59 Phase 0: the evidence telemetry writer.
 *
 * Off writes nothing; observe writes at most topK rows and never the query
 * text; digests are stable under one key and differ across keys; surfacing
 * events are idempotent; outcomes label the latest delivered row; prune honours
 * the retention boundary; stats match COUNT(*); a database without the tables
 * makes every method a no-op instead of throwing.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  EVIDENCE_DEFAULTS,
  EvidenceTelemetry,
  resolveEvidenceConfig,
} from "./evidence-telemetry.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

const quiet = { debug: () => {}, warn: () => {} };

function openDb(file = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(file);
  if (file !== ":memory:") {
    // the migration chain is 79 transactions; no fsync needed for a scratch file
    db.exec("PRAGMA synchronous = OFF");
  }
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);

const results = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    chunkId: `chunk-${i}`,
    rank: i + 1,
    score: 1 / (i + 1),
    channelRanks: { vector: i + 1, keyword: n - i },
  }));

let tmp: string | null = null;
afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe("resolveEvidenceConfig", () => {
  it("defaults to shadow / 90 days / topK 10", () => {
    expect(EVIDENCE_DEFAULTS).toEqual({ mode: "shadow", retentionDays: 90, topK: 10 });
    expect(resolveEvidenceConfig(undefined, quiet)).toEqual(EVIDENCE_DEFAULTS);
    expect(resolveEvidenceConfig({}, quiet)).toEqual(EVIDENCE_DEFAULTS);
  });

  it("accepts every mode and bounds the numbers", () => {
    expect(resolveEvidenceConfig({ mode: "off" }, quiet).mode).toBe("off");
    expect(resolveEvidenceConfig({ mode: "shadow" }, quiet).mode).toBe("shadow");
    expect(resolveEvidenceConfig({ retentionDays: 7, topK: 3 }, quiet)).toMatchObject({
      retentionDays: 7,
      topK: 3,
    });
    expect(resolveEvidenceConfig({ topK: 5000 }, quiet).topK).toBe(200);
    expect(resolveEvidenceConfig({ topK: 2.9 }, quiet).topK).toBe(2);
  });

  it("falls back to the default on a mode typo, retention 0 and garbage numbers", () => {
    const warned: string[] = [];
    const log = { debug: () => {}, warn: (m: string) => warned.push(m) };
    expect(resolveEvidenceConfig({ mode: "shadwo" }, log).mode).toBe("shadow");
    expect(warned).toHaveLength(1);
    expect(resolveEvidenceConfig({ retentionDays: 0 }, quiet).retentionDays).toBe(90);
    expect(resolveEvidenceConfig({ retentionDays: -3 }, quiet).retentionDays).toBe(90);
    expect(resolveEvidenceConfig({ retentionDays: "abc" }, quiet).retentionDays).toBe(90);
    expect(resolveEvidenceConfig({ topK: 0 }, quiet).topK).toBe(10);
    expect(resolveEvidenceConfig("nonsense", quiet)).toEqual(EVIDENCE_DEFAULTS);
    expect(resolveEvidenceConfig(null, quiet)).toEqual(EVIDENCE_DEFAULTS);
  });
});

describe("EvidenceTelemetry", () => {
  it("off mode writes nothing and returns null ids", async () => {
    const db = openDb();
    const t = new EvidenceTelemetry(db, { mode: "off" }, quiet);
    expect(t.isEnabled()).toBe(false);
    expect(t.recordRetrieval({ query: "hello", results: results(3) })).toBeNull();
    expect(t.recordSurfacing({ eventId: "e1", kind: "x", stage: "delivered" })).toBe(false);
    expect(
      t.recordSurfacingOutcome({ refId: "r", outcome: "dismissed", provenance: "explicit" }),
    ).toBe(false);
    expect(t.recordDecisionTrace({ kind: "k", legacy: 1, proposed: 2 })).toBeNull();
    expect(count(db, "retrieval_hits")).toBe(0);
    expect(count(db, "surfacing_events")).toBe(0);
    expect(count(db, "decision_traces")).toBe(0);
    expect(count(db, "evidence_meta")).toBe(1); // schema_note from the migration only
    expect(t.stats()).toMatchObject({ mode: "off", retrievalHits: 0, oldestAt: null });
    expect(await t.prune()).toEqual({ retrievalHits: 0, surfacingEvents: 0, decisionTraces: 0 });
  });

  it("observe writes at most topK rows per search and never the query text", () => {
    tmp = path.join(os.tmpdir(), `evidence-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, "t.sqlite");
    const sentinel = "ZEBRAFISH-QUANTUM-SENTINEL-7731";
    // a real file so the bytes can be inspected afterwards
    const onDisk = openDb(file);
    const t = new EvidenceTelemetry(onDisk, { mode: "observe", topK: 4 }, quiet);
    const qid = t.recordRetrieval({
      query: sentinel,
      sessionKey: "session-A",
      caller: "memory_search",
      results: results(9),
      embeddingModel: "mock",
    });
    expect(qid).toMatch(/^[0-9a-f]{16}$/);
    const rows = onDisk
      .prepare(`SELECT * FROM retrieval_hits ORDER BY rank`)
      .all() as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.chunk_id)).toEqual(["chunk-0", "chunk-1", "chunk-2", "chunk-3"]);
    expect(rows.every((r) => r.query_id === qid)).toBe(true);
    expect(rows[0]).toMatchObject({
      caller: "memory_search",
      query_len: sentinel.length,
      embedding_model: "mock",
      scoring_version: "gccrf-v2",
      injected: null,
      cited: null,
    });
    expect(rows[0]!.session_digest).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0]!.query_digest).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(rows[2]!.channel_ranks_json as string)).toEqual({ vector: 3, keyword: 7 });
    // fewer results than topK: one row per result
    t.recordRetrieval({ query: "two", results: results(2) });
    expect(count(onDisk, "retrieval_hits")).toBe(6);
    // empty result list: nothing written, null id
    expect(t.recordRetrieval({ query: "none", results: [] })).toBeNull();
    // no session key: NULL digest
    t.recordRetrieval({ query: "three", results: results(1) });
    const last = onDisk
      .prepare(`SELECT session_digest FROM retrieval_hits ORDER BY id DESC LIMIT 1`)
      .get() as { session_digest: string | null };
    expect(last.session_digest).toBeNull();
    onDisk.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    onDisk.close();
    const bytes = readFileSync(file).toString("latin1");
    expect(bytes.includes(sentinel)).toBe(false);
    expect(bytes.includes("session-A")).toBe(false);
  });

  it("digests are stable under one key and differ across keys; the key is created once", () => {
    const a = openDb();
    const ta = new EvidenceTelemetry(a, { mode: "observe" }, quiet);
    const d1 = ta.digest("same input");
    const d2 = ta.digest("same input");
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{32}$/);
    expect(ta.digest("other input")).not.toBe(d1);
    // a second writer on the same database reads the same key
    expect(new EvidenceTelemetry(a, { mode: "observe" }, quiet).digest("same input")).toBe(d1);
    expect(
      (
        a.prepare(`SELECT COUNT(*) AS c FROM evidence_meta WHERE key = 'digest_key'`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    const b = openDb();
    expect(new EvidenceTelemetry(b, { mode: "observe" }, quiet).digest("same input")).not.toBe(d1);
  });

  it("surfacing events are idempotent on event_id and outcomes label the latest delivered row", () => {
    const db = openDb();
    const t = new EvidenceTelemetry(db, { mode: "observe" }, quiet);
    expect(
      t.recordSurfacing({
        eventId: "cf:f1:1",
        kind: "curiosity_finding",
        refId: "f1",
        opportunityId: "target-1",
        stage: "delivered",
        sessionKey: "s",
        costUsd: 0.002,
        now: 1000,
      }),
    ).toBe(true);
    expect(
      t.recordSurfacing({ eventId: "cf:f1:1", kind: "curiosity_finding", stage: "delivered" }),
    ).toBe(false);
    expect(count(db, "surfacing_events")).toBe(1);
    const row = db.prepare(`SELECT * FROM surfacing_events`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      arm: "legacy",
      outcome: null,
      label_provenance: null,
      cost_usd: 0.002,
      created_at: 1000,
    });
    // silence is unknown: nothing labelled the row yet
    expect(row.outcome).toBeNull();
    // label by the opportunity (the dismiss RPC carries the target id)
    expect(
      t.recordSurfacingOutcome({
        refId: "target-1",
        outcome: "dismissed",
        provenance: "explicit",
        now: 2000,
      }),
    ).toBe(true);
    expect(count(db, "surfacing_events")).toBe(1);
    expect(
      db.prepare(`SELECT outcome, label_provenance, outcome_at FROM surfacing_events`).get(),
    ).toEqual({ outcome: "dismissed", label_provenance: "explicit", outcome_at: 2000 });
    // label by event id
    t.recordSurfacing({
      eventId: "pr:c9:1",
      kind: "proactive_recall",
      refId: "c9",
      stage: "delivered",
    });
    expect(
      t.recordSurfacingOutcome({ eventId: "pr:c9:1", outcome: "useful", provenance: "inferred" }),
    ).toBe(true);
    expect(
      (
        db.prepare(`SELECT outcome FROM surfacing_events WHERE event_id = 'pr:c9:1'`).get() as {
          outcome: string;
        }
      ).outcome,
    ).toBe("useful");
    // no matching row: a responded row is created
    expect(
      t.recordSurfacingOutcome({
        refId: "never-delivered",
        outcome: "dismissed",
        provenance: "explicit",
        kind: "curiosity_target",
        now: 3000,
      }),
    ).toBe(true);
    const made = db
      .prepare(`SELECT * FROM surfacing_events WHERE ref_id = 'never-delivered'`)
      .get() as Record<string, unknown>;
    expect(made).toMatchObject({
      stage: "responded",
      kind: "curiosity_target",
      outcome: "dismissed",
      label_provenance: "explicit",
      created_at: 3000,
    });
    // neither ref nor event id: nothing
    expect(t.recordSurfacingOutcome({ outcome: "dismissed", provenance: "explicit" })).toBe(false);
    // the latest delivered row wins over an older one with the same ref
    t.recordSurfacing({ eventId: "cf:f2:1", kind: "k", refId: "f2", stage: "delivered", now: 10 });
    t.recordSurfacing({ eventId: "cf:f2:2", kind: "k", refId: "f2", stage: "delivered", now: 20 });
    t.recordSurfacing({ eventId: "cf:f2:3", kind: "k", refId: "f2", stage: "visible", now: 30 });
    t.recordSurfacingOutcome({ refId: "f2", outcome: "answered", provenance: "explicit" });
    expect(
      (
        db.prepare(`SELECT outcome FROM surfacing_events WHERE event_id = 'cf:f2:2'`).get() as {
          outcome: string | null;
        }
      ).outcome,
    ).toBe("answered");
    expect(
      (
        db.prepare(`SELECT outcome FROM surfacing_events WHERE event_id = 'cf:f2:1'`).get() as {
          outcome: string | null;
        }
      ).outcome,
    ).toBeNull();
  });

  it("stores stage details as canonical JSON and a guarded label never overwrites or creates a row", () => {
    const db = openDb();
    const t = new EvidenceTelemetry(db, { mode: "observe" }, quiet);
    t.recordSurfacing({
      eventId: "assigned:pr:c1:1",
      kind: "proactive_recall",
      refId: "c1",
      arm: "withhold",
      stage: "assigned",
      details: { carryOver: false, blockId: 7 },
      now: 1000,
    });
    t.recordSurfacing({
      eventId: "pr:c1:1",
      kind: "proactive_recall",
      refId: "c1",
      arm: "withhold",
      stage: "delivered",
      now: 1000,
    });
    expect(
      (
        db
          .prepare(`SELECT details_json FROM surfacing_events WHERE event_id = 'assigned:pr:c1:1'`)
          .get() as { details_json: string }
      ).details_json,
    ).toBe('{"blockId":7,"carryOver":false}');
    expect(
      (
        db
          .prepare(`SELECT details_json FROM surfacing_events WHERE event_id = 'pr:c1:1'`)
          .get() as {
          details_json: string | null;
        }
      ).details_json,
    ).toBeNull();
    // guarded label on an unlabelled row: applied
    expect(
      t.recordSurfacingOutcome({
        eventId: "pr:c1:1",
        outcome: "explicit_retrieval",
        provenance: "shadow_crossover",
        onlyIfUnlabelled: true,
        now: 2000,
      }),
    ).toBe(true);
    // the owner's explicit label replaces it (ungarded), and the guarded marker then leaves it alone
    t.recordSurfacingOutcome({ eventId: "pr:c1:1", outcome: "dismissed", provenance: "explicit" });
    expect(
      t.recordSurfacingOutcome({
        eventId: "pr:c1:1",
        outcome: "explicit_retrieval",
        provenance: "shadow_crossover",
        onlyIfUnlabelled: true,
      }),
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT outcome, label_provenance FROM surfacing_events WHERE event_id = 'pr:c1:1'`,
        )
        .get(),
    ).toEqual({ outcome: "dismissed", label_provenance: "explicit" });
    // guarded with no matching row: no responded row is created
    expect(
      t.recordSurfacingOutcome({
        refId: "nothing-here",
        outcome: "explicit_retrieval",
        provenance: "shadow_crossover",
        onlyIfUnlabelled: true,
      }),
    ).toBe(false);
    expect(count(db, "surfacing_events")).toBe(2);
  });

  it("decision traces are shadow-only and diverged compares canonical forms (or the decision key)", () => {
    const db = openDb();
    const observe = new EvidenceTelemetry(db, { mode: "observe" }, quiet);
    expect(
      observe.recordDecisionTrace({ kind: "k", legacy: { a: 1 }, proposed: { a: 2 } }),
    ).toBeNull();
    expect(count(db, "decision_traces")).toBe(0);
    const shadow = new EvidenceTelemetry(db, { mode: "shadow" }, quiet);
    expect(shadow.isShadow()).toBe(true);
    // same content, different key order: not diverged
    expect(
      shadow.recordDecisionTrace({
        kind: "dream_seed_rank",
        legacy: { ids: ["a", "b"], limit: 2 },
        proposed: { limit: 2, ids: ["a", "b"] },
      }),
    ).toBe(false);
    expect(
      shadow.recordDecisionTrace({
        kind: "dream_seed_rank",
        legacy: { ids: ["a", "b"] },
        proposed: { ids: ["b", "a"] },
      }),
    ).toBe(true);
    // decision key: weights differ, selection does not
    expect(
      shadow.recordDecisionTrace({
        kind: "dream_mode_select",
        legacy: { selected: ["replay"], weights: { replay: 1.3 } },
        proposed: { selected: ["replay"], weights: { replay: 1.0 } },
        decisionKey: "selected",
      }),
    ).toBe(false);
    const rows = db
      .prepare(
        `SELECT kind, diverged, scoring_version, legacy_json FROM decision_traces ORDER BY id`,
      )
      .all() as unknown as Array<{
      kind: string;
      diverged: number;
      scoring_version: string;
      legacy_json: string;
    }>;
    expect(rows.map((r) => r.diverged)).toEqual([0, 1, 0]);
    expect(rows.every((r) => r.scoring_version === "gccrf-v2")).toBe(true);
    expect(rows[0]!.legacy_json).toBe(canonicalJson({ limit: 2, ids: ["a", "b"] }));
    // observe mode still records retrieval and surfacing; shadow is a superset
    expect(shadow.recordRetrieval({ query: "q", results: results(1) })).not.toBeNull();
  });

  it("uses the persisted gccrf_state scoring version when present", () => {
    const db = openDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS gccrf_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`,
    );
    db.prepare(
      `INSERT INTO gccrf_state (key, value, updated_at) VALUES ('scoring_version', 'gccrf-v9', 1)`,
    ).run();
    const t = new EvidenceTelemetry(db, { mode: "observe" }, quiet);
    t.recordRetrieval({ query: "q", results: results(1) });
    expect(
      (
        db.prepare(`SELECT scoring_version FROM retrieval_hits`).get() as {
          scoring_version: string;
        }
      ).scoring_version,
    ).toBe("gccrf-v9");
    t.recordRetrieval({ query: "q", results: results(1), scoringVersion: "explicit" });
    expect(
      (
        db.prepare(`SELECT scoring_version FROM retrieval_hits ORDER BY id DESC LIMIT 1`).get() as {
          scoring_version: string;
        }
      ).scoring_version,
    ).toBe("explicit");
  });

  it("prune removes rows older than retention, leaves newer ones, and chunks large deletes", async () => {
    const db = openDb();
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const t = new EvidenceTelemetry(db, { mode: "shadow", retentionDays: 10, topK: 200 }, quiet);
    // 2500 old retrieval rows (exceeds one 2000 chunk) + 5 fresh
    t.recordRetrieval({ query: "old", results: results(200), now: now - 11 * day });
    for (let i = 0; i < 12; i++) {
      t.recordRetrieval({ query: `old-${i}`, results: results(200), now: now - 20 * day });
    }
    t.recordRetrieval({ query: "edge-old", results: results(1), now: now - 10 * day - 1 });
    t.recordRetrieval({ query: "edge-new", results: results(1), now: now - 10 * day });
    t.recordRetrieval({ query: "fresh", results: results(3), now });
    t.recordSurfacing({ eventId: "old", kind: "k", stage: "delivered", now: now - 30 * day });
    t.recordSurfacing({ eventId: "new", kind: "k", stage: "delivered", now: now - day });
    t.recordDecisionTrace({ kind: "k", legacy: 1, proposed: 1, now: now - 30 * day });
    t.recordDecisionTrace({ kind: "k", legacy: 1, proposed: 2, now });
    expect(count(db, "retrieval_hits")).toBe(2600 + 1 + 1 + 3);
    const pruned = await t.prune(now);
    expect(pruned).toEqual({ retrievalHits: 2601, surfacingEvents: 1, decisionTraces: 1 });
    expect(count(db, "retrieval_hits")).toBe(4);
    expect(
      (db.prepare(`SELECT MIN(created_at) AS m FROM retrieval_hits`).get() as { m: number }).m,
    ).toBe(now - 10 * day);
    expect(count(db, "surfacing_events")).toBe(1);
    expect(count(db, "decision_traces")).toBe(1);
    // a second prune is a no-op; an empty table prunes to zero
    expect(await t.prune(now)).toEqual({ retrievalHits: 0, surfacingEvents: 0, decisionTraces: 0 });
    db.exec(`DELETE FROM retrieval_hits`);
    expect((await t.prune(now)).retrievalHits).toBe(0);
    // off mode still prunes (switching off should not freeze old rows)
    const off = new EvidenceTelemetry(db, { mode: "off", retentionDays: 10 }, quiet);
    expect((await off.prune(now + 365 * day)).surfacingEvents).toBe(1);
  });

  it("inserts that interleave with a yielding prune leave a consistent table", async () => {
    const db = openDb();
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const t = new EvidenceTelemetry(db, { mode: "observe", retentionDays: 10, topK: 200 }, quiet);
    // 4500 old rows: prune needs three chunks, yielding twice
    for (let i = 0; i < 22; i++) {
      t.recordRetrieval({ query: `old-${i}`, results: results(200), now: now - 30 * day });
    }
    t.recordRetrieval({ query: "old-tail", results: results(100), now: now - 30 * day });
    const pruning = t.prune(now);
    // these land between the prune's chunks; some old, some fresh
    let freshInserted = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.recordRetrieval({ query: `during-old-${i}`, results: results(3), now: now - 20 * day });
      t.recordRetrieval({ query: `during-fresh-${i}`, results: results(2), now });
      freshInserted += 2;
    }
    const pruned = await pruning;
    // a second pass catches old rows inserted after the first pass finished its last chunk
    const second = await t.prune(now);
    expect(pruned.retrievalHits + second.retrievalHits).toBe(4500 + 6 * 3);
    expect(count(db, "retrieval_hits")).toBe(freshInserted);
    expect(
      (db.prepare(`SELECT MIN(created_at) AS m FROM retrieval_hits`).get() as { m: number }).m,
    ).toBe(now);
  });

  it("stats matches COUNT(*) and the oldest created_at", () => {
    const db = openDb();
    const t = new EvidenceTelemetry(db, { mode: "shadow" }, quiet);
    t.recordRetrieval({ query: "a", results: results(2), now: 500 });
    t.recordSurfacing({ eventId: "e", kind: "k", stage: "delivered", now: 300 });
    t.recordDecisionTrace({ kind: "k", legacy: 1, proposed: 2, now: 900 });
    expect(t.stats()).toEqual({
      mode: "shadow",
      available: true,
      retrievalHits: 2,
      surfacingEvents: 1,
      decisionTraces: 1,
      oldestAt: 300,
    });
  });

  it("a database without the tables makes every method a no-op and never throws", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
    const t = new EvidenceTelemetry(db, { mode: "shadow" }, quiet);
    expect(t.isEnabled()).toBe(false);
    expect(t.isShadow()).toBe(false);
    expect(t.digest("x")).toBeNull();
    expect(t.recordRetrieval({ query: "q", results: results(3) })).toBeNull();
    expect(t.recordSurfacing({ eventId: "e", kind: "k", stage: "delivered" })).toBe(false);
    expect(
      t.recordSurfacingOutcome({ refId: "r", outcome: "useful", provenance: "explicit" }),
    ).toBe(false);
    expect(t.recordDecisionTrace({ kind: "k", legacy: 1, proposed: 2 })).toBeNull();
    expect(await t.prune()).toEqual({ retrievalHits: 0, surfacingEvents: 0, decisionTraces: 0 });
    expect(t.stats()).toMatchObject({ available: false, retrievalHits: 0 });
    // only some of the tables: still unavailable
    db.exec(`CREATE TABLE retrieval_hits (id INTEGER PRIMARY KEY)`);
    expect(new EvidenceTelemetry(db, { mode: "observe" }, quiet).isEnabled()).toBe(false);
  });

  it("a failing statement is swallowed (closed database) and huge result lists are capped", () => {
    const db = openDb();
    const t = new EvidenceTelemetry(db, { mode: "observe", topK: 200 }, quiet);
    const huge = results(5000);
    expect(t.recordRetrieval({ query: "big", results: huge })).not.toBeNull();
    expect(count(db, "retrieval_hits")).toBe(200);
    // writes inside a caller's open transaction join it instead of failing
    db.exec("BEGIN");
    expect(t.recordRetrieval({ query: "nested", results: results(2) })).not.toBeNull();
    db.exec("COMMIT");
    expect(count(db, "retrieval_hits")).toBe(202);
    db.close();
    expect(() => t.recordRetrieval({ query: "after close", results: results(1) })).not.toThrow();
    expect(t.recordRetrieval({ query: "after close", results: results(1) })).toBeNull();
    expect(() => t.stats()).not.toThrow();
  });
});
