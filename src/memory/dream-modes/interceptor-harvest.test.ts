import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { runInterceptorHarvest } from "./interceptor-harvest.js";

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

function insertRec(
  d: DatabaseSync,
  args: {
    id: string;
    ts: number;
    toolName: string;
    channel: string;
    paramsKey?: string;
    outcome?: string | null;
    hormonalCortisol?: number;
  },
): void {
  const params = { [args.paramsKey ?? "query"]: "x" };
  d.prepare(
    `INSERT INTO intervention_records (
       id, ts, session_key, skill, interceptor_id, channel, tool_name,
       intervention_type, action_original_json, intervention_json,
       state_summary_json, record_json, outcome_tag
     ) VALUES (?, ?, 's', 'h', 'h:1', ?, ?, 'modify', ?, '{}', ?, '{}', ?)`,
  ).run(
    args.id,
    args.ts,
    args.channel,
    args.toolName,
    JSON.stringify({ toolName: args.toolName, params }),
    JSON.stringify({
      hormonal: { cortisol: args.hormonalCortisol ?? 0.5 },
      channel: args.channel,
    }),
    args.outcome ?? null,
  );
}

describe("interceptor-harvest", () => {
  let conn: DatabaseSync;
  let tmpDir: string;
  beforeEach(() => {
    conn = db();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-test-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("ignores clusters below MIN_CLUSTER_SIZE", async () => {
    insertRec(conn, {
      id: "a",
      ts: Date.now(),
      toolName: "t",
      channel: "internal",
      outcome: "downstream-failure",
    });
    insertRec(conn, {
      id: "b",
      ts: Date.now(),
      toolName: "t",
      channel: "internal",
      outcome: "downstream-failure",
    });
    // Only 2 records → cluster below threshold of 3.
    const result = await runInterceptorHarvest({
      db: conn,
      cycleId: "c1",
      synthesizeFn: null,
      embedFn: null,
      llmCall: null,
      nowMs: Date.now(),
      maxRecords: 100,
      stagingDirOverride: tmpDir,
    });
    expect(result.insights).toHaveLength(0);
  });

  it("clusters and emits a heuristic insight when failure rate is high enough", async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      insertRec(conn, {
        id: `r${i}`,
        ts: now - i * 1000,
        toolName: "memory_search",
        channel: "internal",
        outcome: "downstream-failure",
      });
    }
    const result = await runInterceptorHarvest({
      db: conn,
      cycleId: "c1",
      synthesizeFn: null,
      embedFn: null,
      llmCall: null,
      nowMs: now,
      maxRecords: 100,
      stagingDirOverride: tmpDir,
    });
    expect(result.insights.length).toBeGreaterThanOrEqual(1);
    expect(result.insights[0]?.mode).toBe("interceptor_harvest");
    expect(result.recordsAnalyzed).toBeGreaterThanOrEqual(4);
  });

  it("stages a SKILL.md candidate when LLM is available and returns valid JSON", async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      insertRec(conn, {
        id: `r${i}`,
        ts: now - i * 1000,
        toolName: "memory_search",
        channel: "internal",
        outcome: "downstream-failure",
      });
    }
    const validJson = JSON.stringify({
      id: "auto-cluster:default",
      skill: "auto-cluster",
      priority: 70,
      tools: ["memory_search"],
      maxFiresPerEpisode: 3,
      activation: {
        description: "memory_search with query=x",
        conditions: ["toolName memory_search", "query equals x"],
      },
      intervention: {
        type: "modify",
        description: "rewrite",
        reason: "auto-cluster gap",
      },
      rationale: "auto-clustered failure",
    });
    const result = await runInterceptorHarvest({
      db: conn,
      cycleId: "c1",
      synthesizeFn: null,
      embedFn: null,
      llmCall: async () => validJson,
      nowMs: now,
      maxRecords: 100,
      stagingDirOverride: tmpDir,
    });
    expect(result.llmCalls).toBeGreaterThan(0);
    const stagedPath = path.join(tmpDir, "auto-cluster", "SKILL.md");
    expect(fs.existsSync(stagedPath)).toBe(true);
  });
});
