/**
 * PLAN-52: the usage ledger tags rows with the agent runtime engine. Since
 * Phase 6 the resolved engine is always `bitterbot`; the column and the
 * comparison stay so rows written before the switch can still be read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectRuntimeEngineChecks } from "../commands/doctor-agent-runtime.js";
import type { BitterbotConfig } from "../config/config.js";
import { resetModelPricingMemoForTest } from "./model-pricing.js";
import {
  UsageLedger,
  flushUsageLedger,
  recordUsage,
  resolveUsageEvent,
  setUsageLedgerForTest,
} from "./usage-ledger.js";

const cfg = {
  agents: {
    defaults: { runtime: { engine: "bitterbot" } },
    list: [{ id: "main" }, { id: "drill", runtime: { engine: "pi" } }],
  },
  models: {
    providers: {
      acme: {
        baseUrl: "https://acme.invalid",
        models: [
          {
            id: "priced",
            name: "priced",
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
} as unknown as BitterbotConfig;

describe("usage ledger: runtime engine", () => {
  let ledger: UsageLedger;

  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
    setUsageLedgerForTest(ledger);
  });
  afterEach(() => {
    setUsageLedgerForTest(null);
    ledger.close();
  });

  it("resolves the engine as bitterbot for every agent; null without an agent", async () => {
    const base = {
      kind: "chat" as const,
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
    };
    const usage = { input: 1000, output: 100 };
    expect(
      (await resolveUsageEvent({ ...base, usage, agentId: "main", config: cfg }))?.engine,
    ).toBe("bitterbot");
    expect(
      (await resolveUsageEvent({ ...base, usage, agentId: "drill", config: cfg }))?.engine,
    ).toBe("bitterbot");
    expect((await resolveUsageEvent({ ...base, usage, config: cfg }))?.engine).toBeNull();
    expect(
      (
        await resolveUsageEvent({
          ...base,
          usage,
          agentId: "main",
          engine: "pi",
          config: cfg,
        })
      )?.engine,
    ).toBe("pi");
  });

  it("stores the engine, filters by it, and compares engines", async () => {
    // Rows tagged "pi" stand for rows written before the engine was removed.
    const record = (
      agentId: string,
      runId: string,
      durationMs: number,
      status?: "error",
      engine?: string,
    ) =>
      recordUsage({
        kind: "chat",
        feature: "agent/turn",
        provider: "acme",
        model: "priced",
        agentId,
        runId,
        durationMs,
        status,
        engine,
        usage: { input: 1_000_000, output: 0 },
        config: cfg,
      });
    record("main", "run-a", 100, undefined, "pi");
    record("main", "run-a", 300, undefined, "pi");
    record("main", "run-b", 200, "error", "pi");
    record("drill", "run-c", 50);
    recordUsage({
      kind: "embedding",
      feature: "memory/embed",
      provider: "acme",
      model: "priced",
      usage: { input: 10 },
      config: cfg,
    });
    await flushUsageLedger();
    ledger.insertToolCall({ runId: "run-a", tool: "read", via: "native", ok: true });
    ledger.insertToolCall({ runId: "run-a", tool: "exec", via: "native", ok: false });
    ledger.insertToolCall({ runId: "run-c", tool: "read", via: "native", ok: true });

    expect(ledger.rows({ engine: "bitterbot" }).map((row) => row.runId)).toEqual(["run-c"]);
    expect(ledger.rows({ engine: "pi" })).toHaveLength(3);

    const comparison = ledger.engineComparison();
    expect(comparison.map((row) => row.engine)).toEqual(["bitterbot", "pi"]);
    const pi = comparison.find((row) => row.engine === "pi")!;
    expect(pi).toMatchObject({
      runs: 2,
      modelCalls: 3,
      errorCalls: 1,
      durationP50Ms: 200,
      durationP95Ms: 300,
      toolCalls: 2,
      toolErrors: 1,
      toolErrorRate: 0.5,
    });
    expect(pi.costUsd).toBeCloseTo(3);
    expect(pi.costPerRunUsd).toBeCloseTo(1.5);
    const owned = comparison.find((row) => row.engine === "bitterbot")!;
    expect(owned).toMatchObject({
      runs: 1,
      modelCalls: 1,
      toolCalls: 1,
      toolErrors: 0,
      toolErrorRate: 0,
    });
    expect(ledger.engineComparison({ agentId: "drill" }).map((row) => row.engine)).toEqual([
      "bitterbot",
    ]);
  });

  it("adds the engine column to a database created before it existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-usage-engine-"));
    try {
      const file = path.join(dir, "usage.sqlite");
      const first = UsageLedger.open(file);
      first.close();
      const raw = new DatabaseSync(file);
      raw.exec("ALTER TABLE usage_events DROP COLUMN engine");
      const before = raw.prepare("PRAGMA table_info(usage_events)").all() as Array<{
        name: string;
      }>;
      expect(before.some((column) => column.name === "engine")).toBe(false);
      raw.close();
      const reopened = UsageLedger.open(file);
      expect(reopened.engineComparison()).toEqual([]);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor: runtime engine lines", () => {
  it("names the one engine; a legacy pi override no longer shows", () => {
    const lines = collectRuntimeEngineChecks({ config: cfg }).map((check) => check.message);
    expect(lines).toEqual(["Runtime engine: bitterbot (default)"]);
    expect(collectRuntimeEngineChecks({}).map((check) => check.message)).toEqual([
      "Runtime engine: bitterbot (default)",
    ]);
  });

  it("prints the comparison only when both engines have runs", () => {
    const row = {
      engine: "pi",
      runs: 10,
      modelCalls: 20,
      costUsd: 1,
      costPerRunUsd: 0.1,
      errorCalls: 1,
      durationP50Ms: 1200,
      durationP95Ms: 4000,
      toolCalls: 40,
      toolErrors: 2,
      toolErrorRate: 0.05,
    };
    expect(collectRuntimeEngineChecks({ config: cfg, comparison: [row] })).toHaveLength(1);
    const both = collectRuntimeEngineChecks({
      config: cfg,
      comparison: [row, { ...row, engine: "bitterbot", toolErrorRate: null, durationP50Ms: null }],
    }).map((check) => check.message);
    expect(both).toHaveLength(3);
    expect(both[1]).toContain(
      "pi: 10 runs, $0.1000/run, model call p50 1200 ms p95 4000 ms, tool errors 5.0% (2/40)",
    );
    expect(both[2]).toContain("bitterbot: 10 runs");
    expect(both[2]).toContain("p50 n/a");
    expect(both[2]).toContain("tool errors n/a");
  });
});
