import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCooldown,
  maybeRunGraphOptimization,
  materializeGateValues,
} from "./graph-optimization-hook.js";
import { insertTrainingPair } from "./graph-optimizer.js";
import { _clearGraphReaderCache } from "./graph-reader.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { _clearQueryPlanCache } from "./query-planner.js";
import { requireNodeSqlite } from "./sqlite.js";
import { createDefaultGate, deserializeGate } from "./structural-gate.js";

function openDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function seedGraph(kg: KnowledgeGraphManager) {
  kg.upsertEntity({ name: "Root", type: "concept" });
  kg.upsertEntity({ name: "Bridge", type: "concept" });
  kg.upsertEntity({ name: "Leaf", type: "concept" });
  kg.upsertRelationship(
    {
      sourceName: "Root",
      sourceType: "concept",
      targetName: "Bridge",
      targetType: "concept",
      relationType: "related_to",
      weight: 0.8,
    },
    ["chunk-bridge"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Bridge",
      sourceType: "concept",
      targetName: "Leaf",
      targetType: "concept",
      relationType: "related_to",
      weight: 0.8,
    },
    ["chunk-leaf"],
  );
}

describe("graph-optimization-hook", () => {
  let dir: string;

  beforeEach(() => {
    _resetCooldown();
    _clearQueryPlanCache();
    _clearGraphReaderCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sage-hook-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops when disabled", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const r = maybeRunGraphOptimization(db, kg, { enabled: false });
    expect(r).toBeNull();
  });

  it("no-ops when training pairs are below the threshold", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedGraph(kg);
    insertTrainingPair(db, "Root", "chunk-leaf");
    const r = maybeRunGraphOptimization(db, kg, {
      enabled: true,
      minTrainingPairs: 50,
      gateFilePath: path.join(dir, "gate.json"),
    });
    expect(r).toBeNull();
  });

  it("runs and persists when preconditions hold", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedGraph(kg);
    for (let i = 0; i < 6; i++) {
      insertTrainingPair(db, "Root Bridge", "chunk-leaf");
    }
    const gateFilePath = path.join(dir, "gate.json");
    const r = maybeRunGraphOptimization(db, kg, {
      enabled: true,
      minTrainingPairs: 4,
      gateFilePath,
      cooldownMs: 0,
      optimizer: { population: 4, generations: 2 },
    });
    expect(r).not.toBeNull();
    expect(r!.evaluations).toBeGreaterThan(0);
    expect(fs.existsSync(gateFilePath)).toBe(true);
    const restored = deserializeGate(JSON.parse(fs.readFileSync(gateFilePath, "utf8")));
    expect(restored).not.toBeNull();
  });

  it("respects the cooldown window", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedGraph(kg);
    for (let i = 0; i < 6; i++) {
      insertTrainingPair(db, "Root", "chunk-bridge");
    }
    const gateFilePath = path.join(dir, "gate.json");
    const cfg = {
      enabled: true,
      minTrainingPairs: 4,
      gateFilePath,
      cooldownMs: 60 * 60_000,
      optimizer: { population: 4, generations: 1 },
    };
    const first = maybeRunGraphOptimization(db, kg, cfg);
    expect(first).not.toBeNull();
    const second = maybeRunGraphOptimization(db, kg, cfg);
    expect(second).toBeNull();
  });
});

describe("materializeGateValues", () => {
  it("writes gate_value for every active relationship that has features", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedGraph(kg);
    const gate = createDefaultGate(1);
    const updated = materializeGateValues(db, gate);
    expect(updated).toBeGreaterThan(0);
    const rows = db
      .prepare(`SELECT gate_value FROM relationships WHERE valid_until IS NULL`)
      .all() as Array<{ gate_value: number | null }>;
    for (const r of rows) {
      expect(r.gate_value).not.toBeNull();
      expect(Number.isFinite(r.gate_value!)).toBe(true);
      expect(r.gate_value!).toBeGreaterThanOrEqual(0);
      expect(r.gate_value!).toBeLessThanOrEqual(2.5);
    }
  });
});
