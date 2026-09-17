import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_BUST_REASONS, recordCacheTurn } from "../agents/prompt-cache-monitor.js";
import { buildEndocrineStateSection } from "../agents/system-prompt.js";
import { nudgeHeartbeatIfDueSoon } from "./heartbeat-runner.js";
import { resetModelPricingMemoForTest } from "./model-pricing.js";
import { getUsageBudgetPressure, resetUsageBudgetPressureForTest } from "./usage-budgets.js";
import { buildUsageExplanation, buildUsageWhatIf } from "./usage-insights.js";
import {
  UsageLedger,
  backfillComputedCost,
  resolveUsageEvent,
  setUsageLedgerForTest,
} from "./usage-ledger.js";
import { loadSessionAttribution, reconcileTranscripts } from "./usage-reconcile.js";
import { buildRunawayRuns, buildUsageLedgerSummary } from "./usage-summary.js";

const cfgWithOverride = {
  models: {
    providers: {
      acme: {
        models: [
          { id: "priced", cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 } },
          { id: "cheap", cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0.6 } },
        ],
      },
    },
  },
} as unknown as import("../config/config.js").BitterbotConfig;

type Input = Parameters<typeof resolveUsageEvent>[0];

async function seed(ledger: UsageLedger, rows: Array<Partial<Input> & { ts: number }>) {
  for (const r of rows) {
    const resolved = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 100, output: 50 },
      config: cfgWithOverride,
      ...r,
    } as Input);
    ledger.insert(resolved!);
  }
}

describe("phase 6: SQL aggregation matches row-level math", () => {
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  it("sums exclusive buckets and cost per pivot without loading rows, excluding TTS chars", async () => {
    const t0 = Date.UTC(2026, 8, 20, 10);
    await seed(ledger, [
      {
        ts: t0,
        usage: { input: 100, cacheRead: 900, output: 50 },
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      {
        ts: t0 + 60_000,
        model: "cheap",
        usage: { input: 10, output: 10 },
        agentId: "main",
        sessionKey: "agent:main:main",
        taskId: "t1",
        runId: "r1",
      },
      {
        ts: t0 + 120_000,
        kind: "tts",
        feature: "tts/synthesis",
        provider: "openai",
        model: "tts-1",
        usage: { input: 5000, total: 5000 },
        items: 5000,
      },
      {
        ts: t0 + 180_000,
        kind: "embedding",
        feature: "memory/index",
        provider: "openai",
        model: "text-embedding-3-small",
        usage: { total: 4000 },
      },
    ]);
    const summary = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: t0 - 1,
      endMs: t0 + 3_600_000,
      nowMs: t0 + 3_600_000,
    });
    expect(summary.totals.calls).toBe(4);
    // TTS characters are not tokens.
    expect(summary.totals.usage.total).toBe(100 + 900 + 50 + 20 + 4000);
    expect(summary.totals.usage.cacheRead).toBe(900);
    expect(summary.byKind.map((k) => k.key).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "chat",
      "embedding",
      "tts",
    ]);
    expect(summary.byModel.find((m) => m.model === "tts-1")?.usage.total).toBe(0);
    expect(summary.byModel.find((m) => m.model === "tts-1")?.cost.total).toBeCloseTo(
      (5000 * 15) / 1_000_000,
      9,
    );
    expect(summary.bySession[0]).toMatchObject({ sessionKey: "agent:main:main", calls: 2 });
    expect(summary.bySession[0]!.models[0]).toBe("acme/priced");
    expect(summary.byTask[0]).toMatchObject({ taskId: "t1", runs: 1 });
    expect(summary.daily.find((d) => d.date === "2026-09-20")?.byModel.length).toBe(4);
    const u = summary.totals.usage;
    expect(summary.energy.wh).toBeCloseTo(
      (u.input + u.cacheWrite) * 0.0003 + u.cacheRead * 0.00003 + u.output * 0.001,
      9,
    );
  });

  it("flags cache writes that are never read back", async () => {
    const t0 = Date.UTC(2026, 8, 20, 10);
    const rows: Array<Partial<Input> & { ts: number }> = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push({
        ts: t0 + i * 30 * 60_000,
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: { input: 5, cacheWrite: 50_000, output: 20 },
        cost: { total: 0.32, cacheWrite: 0.31 },
        cacheState: "write",
        cacheBustReason: i > 0 ? CACHE_BUST_REASONS.writeNeverRead : CACHE_BUST_REASONS.coldStart,
        cacheTtl: "5m",
      });
    }
    // Same model, a chat lane that reads its cache fine: must not mask the heartbeat waste.
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        ts: t0 + i * 60_000 + 10,
        feature: "agent/turn",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: { input: 5, cacheRead: 50_000, output: 20 },
        cost: { total: 0.02 },
        cacheState: "hit",
      });
    }
    await seed(
      ledger,
      rows.map((r) => (r.feature ? r : { ...r, feature: "agent/heartbeat" })),
    );
    const summary = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: t0 - 1,
      endMs: t0 + 4 * 3_600_000,
      nowMs: t0 + 4 * 3_600_000,
    });
    expect(summary.cacheHealth.busts).toBe(0);
    expect(summary.cacheHealth.unreadWriteUsd).toBeCloseTo(6 * 0.31, 6);
    expect(summary.cacheHealth.unreadByFeature[0]).toMatchObject({
      feature: "agent/heartbeat",
      requests: 6,
    });
    expect(summary.cacheHealth.warm).toBe(false);
    expect(summary.flags.some((f) => f.id === "cache-never-read")).toBe(true);
  });

  it("detects runaway runs against the median", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({
      run_id: `r${i}`,
      session_key: null,
      feature: "agent/turn",
      cost: i === 11 ? 12 : 0.5,
      calls: i === 11 ? 80 : 3,
      first_ts: i,
      last_ts: i,
    }));
    const flagged = buildRunawayRuns(runs);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ runId: "r11", calls: 80 });
    expect(flagged[0]!.multiple).toBeCloseTo(24, 6);
  });

  it("counts cost per verified outcome from the task store", async () => {
    const t0 = Date.UTC(2026, 8, 20, 10);
    await seed(ledger, [
      { ts: t0, taskId: "done-1", runId: "a", cost: { total: 1 }, usage: { input: 1 } },
      { ts: t0 + 1, taskId: "done-1", runId: "b", cost: { total: 1 }, usage: { input: 1 } },
      { ts: t0 + 2, taskId: "failed-1", runId: "c", cost: { total: 3 }, usage: { input: 1 } },
      { ts: t0 + 3, taskId: "running-1", runId: "d", cost: { total: 9 }, usage: { input: 1 } },
      {
        ts: t0 + 4,
        taskId: "done-2",
        runId: "e",
        model: "cheap",
        cost: { total: 0.5 },
        usage: { input: 1 },
      },
    ]);
    const status: Record<string, string> = {
      "done-1": "completed",
      "failed-1": "failed",
      "running-1": "running",
      "done-2": "completed",
    };
    const summary = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: t0 - 1,
      endMs: t0 + 3_600_000,
      nowMs: t0 + 3_600_000,
      taskInfo: (id) => (status[id] ? { status: status[id]!, goal: `goal ${id}` } : undefined),
    });
    expect(summary.outcomes).toMatchObject({
      tasks: 3,
      succeeded: 2,
      failed: 1,
      costTotal: 5.5,
      costOnFailures: 3,
    });
    expect(summary.outcomes.costPerSuccess).toBeCloseTo(2.75, 9);
    const priced = summary.outcomes.byModel.find((m) => m.model === "priced")!;
    expect(priced).toMatchObject({ tasks: 2, succeeded: 1, failed: 1 });
    expect(summary.byTask.find((t) => t.taskId === "done-1")?.label).toBe("goal done-1");
    expect(summary.flags.some((f) => f.id === "failed-task-spend")).toBe(true);
  });
});

describe("phase 6: what-if replay and explain", () => {
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  it("re-prices chat rows under another model and leaves embeddings out", async () => {
    const t0 = Date.UTC(2026, 8, 20, 10);
    await seed(ledger, [
      { ts: t0, usage: { input: 1_000_000, output: 0 } },
      {
        ts: t0 + 1,
        kind: "embedding",
        feature: "memory/index",
        provider: "openai",
        model: "text-embedding-3-small",
        usage: { total: 1_000_000 },
      },
    ]);
    const res = await buildUsageWhatIf({
      ledger,
      cfg: cfgWithOverride,
      startMs: t0 - 1,
      endMs: t0 + 10,
      targetProvider: "acme",
      targetModel: "cheap",
    });
    expect(res.calls).toBe(1);
    expect(res.actualCost).toBeCloseTo(2, 6);
    expect(res.projectedCost).toBeCloseTo(0.5, 6);
    expect(res.savingsPct).toBeCloseTo(0.75, 6);
    const unknown = await buildUsageWhatIf({
      ledger,
      cfg: cfgWithOverride,
      startMs: t0 - 1,
      endMs: t0 + 10,
      targetProvider: "nobody",
      targetModel: "mystery",
    });
    expect(unknown.target.source).toBe("unpriced");
    expect(unknown.caveat).toContain("No known price");
  });

  it("explains a window against the one before it", async () => {
    const day = 24 * 3_600_000;
    const t0 = Date.UTC(2026, 8, 20);
    await seed(ledger, [
      { ts: t0 - day + 1000, cost: { total: 1 }, usage: { input: 1 } },
      { ts: t0 + 1000, cost: { total: 2 }, usage: { input: 1 }, sessionKey: "agent:main:main" },
      { ts: t0 + 2000, feature: "memory/dream", cost: { total: 2 }, usage: { input: 1 } },
    ]);
    const ex = buildUsageExplanation({
      ledger,
      startMs: t0,
      endMs: t0 + day - 1,
      sessionInfo: () => ({ label: "Main chat" }),
    });
    expect(ex.cost).toBeCloseTo(4, 6);
    expect(ex.priorCost).toBeCloseTo(1, 6);
    expect(ex.changePct).toBeCloseTo(3, 6);
    expect(ex.lines[0]).toContain("up 300%");
    expect(ex.lines.some((l) => l.includes("Dream engine"))).toBe(true);
    expect(ex.lines.some((l) => l.includes("Main chat"))).toBe(true);
  });
});

describe("phase 6: reconcile attribution, relabel and computed-cost backfill", () => {
  let dir: string;
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-usage6-"));
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maps transcripts to session keys, channels and features from sessions.json", async () => {
    const sessionsDir = path.join(dir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": {
          sessionId: "s-main",
          origin: { provider: "heartbeat" },
          lastTo: "heartbeat",
        },
        "agent:main:heartbeat": { sessionId: "s-hb", lastTo: "heartbeat" },
        "agent:main:telegram:group:123": { sessionId: "s-tg", lastChannel: "telegram" },
        "agent:main:subagent:abc": { sessionId: "s-sub" },
      }),
    );
    const attribution = loadSessionAttribution(sessionsDir);
    // The shared main session mixes user turns and heartbeats: never relabeled as heartbeat.
    expect(attribution.get("s-main")).toMatchObject({
      sessionKey: "agent:main:main",
      feature: "agent/turn",
    });
    expect(attribution.get("s-hb")).toMatchObject({
      sessionKey: "agent:main:heartbeat",
      feature: "agent/heartbeat",
    });
    expect(attribution.get("s-tg")).toMatchObject({ channel: "telegram", feature: "agent/turn" });
    expect(attribution.get("s-sub")?.feature).toBe("agent/subagent");

    const line = (sessionId: string, ts: number) =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(ts).toISOString(),
        message: {
          role: "assistant",
          provider: "acme",
          model: "priced",
          usage: { input: 10, output: 5, cost: { total: 0.1 } },
          timestamp: ts,
        },
      }) + "\n";
    const t0 = Date.UTC(2026, 8, 1);
    fs.writeFileSync(path.join(sessionsDir, "s-tg.jsonl"), line("s-tg", t0));
    fs.writeFileSync(path.join(sessionsDir, "s-main.jsonl"), line("s-main", t0 + 1000));
    // A row imported before attribution existed (no session key, generic feature).
    const legacy = await resolveUsageEvent({
      ts: t0 + 5000,
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      agentId: "main",
      sessionId: "s-main",
      usage: { input: 1, output: 1 },
      source: "reconcile",
    });
    ledger.insert({ ...legacy!, dedupeKey: "s-main:legacy" });

    await reconcileTranscripts({ ledger, stateDir: dir });
    const rows = ledger.rows({});
    const tg = rows.find((r) => r.sessionId === "s-tg")!;
    expect(tg.sessionKey).toBe("agent:main:telegram:group:123");
    expect(tg.channel).toBe("telegram");
    const heartbeats = rows.filter((r) => r.sessionId === "s-main");
    expect(heartbeats).toHaveLength(2);
    // Legacy row now carries the session key too.
    expect(
      heartbeats.every((r) => r.feature === "agent/turn" && r.sessionKey === "agent:main:main"),
    ).toBe(true);
    expect(ledger.getMeta("relabel:v2:main")).toBe("1");
  });

  it("fills cost_computed on rows that were written without a table price", async () => {
    const t0 = Date.UTC(2026, 8, 1);
    const row = await resolveUsageEvent({
      ts: t0,
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 1000, output: 500 },
      cost: { total: 0.9 },
    });
    // Simulate a pre-Phase-5 row: no computed cost.
    ledger.insert({ ...row!, costComputed: null });
    expect(ledger.uncomputedIdentities()).toHaveLength(1);
    const updated = await backfillComputedCost(ledger, cfgWithOverride);
    expect(updated).toBe(1);
    const stored = ledger.events({ limit: 1 }).events[0]!;
    expect(stored.costComputed).toBeCloseTo((1000 * 2 + 500 * 4) / 1_000_000, 9);
    expect(ledger.uncomputedIdentities()).toHaveLength(0);
  });
});

describe("phase 6: budget pressure, prompt line, heartbeat nudge, cache reasons", () => {
  afterEach(() => {
    resetUsageBudgetPressureForTest();
    setUsageLedgerForTest(null);
  });

  it("turns budget ratio into a prompt line only when pressure is meaningful", async () => {
    const ledger = UsageLedger.openInMemory();
    setUsageLedgerForTest(ledger);
    const now = Date.UTC(2026, 8, 20, 12);
    const row = await resolveUsageEvent({
      ts: now - 1000,
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 1 },
      cost: { total: 0.9 },
    });
    ledger.insert(row!);
    const cfg = {
      usage: { budgets: { daily: { usd: 1 } } },
    } as unknown as import("../config/config.js").BitterbotConfig;
    const pressure = getUsageBudgetPressure({ ledger, cfg, nowMs: now });
    expect(pressure.pressure).toBeCloseTo(0.9, 6);
    expect(pressure.label).toBe("global:daily");
    const lines = buildEndocrineStateSection({
      endocrineState: {
        dopamine: 0.1,
        cortisol: 0.1,
        oxytocin: 0.1,
        briefing: "",
        budgetPressure: 0.9,
        budgetLabel: "global:daily",
      },
      isMinimal: false,
    });
    expect(
      lines.some((l) => l.includes("90% of the spend budget") && l.includes("fewer tool calls")),
    ).toBe(true);
    const quiet = buildEndocrineStateSection({
      endocrineState: {
        dopamine: 0.1,
        cortisol: 0.1,
        oxytocin: 0.1,
        briefing: "",
        budgetPressure: 0.2,
      },
      isMinimal: false,
    });
    expect(quiet.some((l) => l.includes("spend budget"))).toBe(false);
    ledger.close();
  });

  it("does not nudge heartbeats when no runner is active", () => {
    expect(nudgeHeartbeatIfDueSoon(5 * 60_000)).toBe(false);
  });

  it("labels consecutive write-only turns as never-read cache", () => {
    const key = `s-${Math.random()}`;
    const t0 = 1_000_000;
    recordCacheTurn(key, { input: 5, cacheWrite: 50_000 }, t0);
    const second = recordCacheTurn(key, { input: 5, cacheWrite: 50_000 }, t0 + 30 * 60_000);
    expect(second).toMatchObject({
      bust: false,
      state: "write",
      reason: CACHE_BUST_REASONS.writeNeverRead,
    });
  });
});
