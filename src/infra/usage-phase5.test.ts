import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_BUST_REASONS, recordCacheTurn } from "../agents/prompt-cache-monitor.js";
import { usageRowToMetricAttributes } from "../observability/usage-metrics.js";
import {
  lookupLivePrice,
  normalizePricingKey,
  parseOpenRouterModels,
  setPricingSnapshotsForTest,
} from "./model-pricing-live.js";
import { priceUsage, resetModelPricingMemoForTest, resolveModelPricing } from "./model-pricing.js";
import { UsageLedger, resolveUsageEvent, setUsageLedgerForTest } from "./usage-ledger.js";
import { buildUsageLedgerSummary } from "./usage-summary.js";

const cfgWithOverride = {
  models: {
    providers: {
      acme: {
        models: [{ id: "priced", cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 } }],
      },
    },
  },
} as unknown as import("../config/config.js").BitterbotConfig;

describe("live pricing overlay", () => {
  afterEach(() => setPricingSnapshotsForTest([]));

  it("normalizes OpenRouter ids and native ids to one key", () => {
    expect(normalizePricingKey("anthropic", "claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(normalizePricingKey("Anthropic", "claude-sonnet-4-5-20250929")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(normalizePricingKey("google", "models/gemini-2.5-pro")).toBe("google/gemini-2-5-pro");
    expect(normalizePricingKey("meta-llama", "llama-3.3-70b-instruct:free")).toBe(
      "meta-llama/llama-3-3-70b-instruct",
    );
  });

  it("parses per-token strings into per-million prices incl. the 1h cache-write tier", () => {
    const snap = parseOpenRouterModels(
      {
        data: [
          {
            id: "anthropic/claude-sonnet-4.5",
            pricing: {
              prompt: "0.000003",
              completion: "0.000015",
              input_cache_read: "0.0000003",
              input_cache_write: "0.00000375",
              input_cache_write_1h: "0.000006",
            },
          },
          { id: "nopricing/model", pricing: {} },
          { id: "bad" },
        ],
      },
      1_000,
    );
    expect(Object.keys(snap.entries)).toEqual(["anthropic/claude-sonnet-4-5"]);
    const e = snap.entries["anthropic/claude-sonnet-4-5"]!;
    expect(e.input).toBeCloseTo(3, 9);
    expect(e.output).toBeCloseTo(15, 9);
    expect(e.cacheRead).toBeCloseTo(0.3, 9);
    expect(e.cacheWrite).toBeCloseTo(3.75, 9);
    expect(e.cacheWrite1h).toBeCloseTo(6, 9);
  });

  it("never lets a variant, a dated twin, or an unpriced entry overwrite a paid model", () => {
    const snap = parseOpenRouterModels(
      {
        data: [
          { id: "z-ai/glm-5.2", pricing: { prompt: "0.0000014", completion: "0.0000044" } },
          { id: "z-ai/glm-5.2:free", pricing: { prompt: "0", completion: "0" } },
          { id: "openai/gpt-4o", pricing: { prompt: "0.0000025", completion: "0.00001" } },
          {
            id: "openai/gpt-4o-2024-05-13",
            pricing: { prompt: "0.000005", completion: "0.000015" },
          },
          {
            id: "acme/dated-first-2025-01-01",
            pricing: { prompt: "0.000001", completion: "0.000001" },
          },
          { id: "acme/dated-first", pricing: { prompt: "0.000002", completion: "0.000002" } },
          { id: "acme/unknown", pricing: { prompt: "0", completion: "0" } },
        ],
      },
      1,
    );
    expect(snap.entries["z-ai/glm-5-2"]?.input).toBeCloseTo(1.4, 9);
    expect(snap.entries["openai/gpt-4o"]?.input).toBeCloseTo(2.5, 9);
    expect(snap.entries["acme/dated-first"]?.input).toBeCloseTo(2, 9);
    expect(snap.entries["acme/unknown"]).toBeUndefined();
  });

  it("answers with the snapshot in force at the event time", () => {
    setPricingSnapshotsForTest([
      {
        source: "openrouter",
        fetchedAt: 100,
        entries: { "x/m": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      },
      {
        source: "openrouter",
        fetchedAt: 200,
        entries: { "x/m": { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
      },
    ]);
    expect(lookupLivePrice("x", "m", 150)?.price.input).toBe(1);
    expect(lookupLivePrice("x", "m", 250)?.price.input).toBe(2);
    expect(lookupLivePrice("x", "m")?.price.input).toBe(2);
    expect(lookupLivePrice("x", "m", 50)?.price.input).toBe(1);
    expect(lookupLivePrice("x", "missing")).toBeUndefined();
  });

  it("is consulted only after override, catalog and local tiers miss", async () => {
    resetModelPricingMemoForTest();
    setPricingSnapshotsForTest([
      {
        source: "openrouter",
        fetchedAt: 1,
        entries: {
          "acme/priced": { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
          "acme/live-only": { input: 7, output: 9, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]);
    expect(
      (await resolveModelPricing({ provider: "acme", model: "priced", cfg: cfgWithOverride }))
        .source,
    ).toBe("override");
    const live = await resolveModelPricing({ provider: "acme", model: "live-only" });
    expect(live.source).toBe("live");
    expect(live.price.output).toBe(9);
    expect((await resolveModelPricing({ provider: "ollama", model: "live-only" })).source).toBe(
      "local",
    );
  });

  it("prices TTS per character and scales Anthropic 1h cache writes", async () => {
    resetModelPricingMemoForTest();
    const tts = await resolveModelPricing({ provider: "openai", model: "tts-1-hd", kind: "tts" });
    expect(tts.price.input).toBe(30);
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const usage = {
      input: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      output: 0,
      reasoning: 0,
      total: 1_000_000,
    };
    expect(
      priceUsage(price, usage, { cacheTtl: "5m", provider: "anthropic" }).cacheWrite,
    ).toBeCloseTo(3.75, 6);
    expect(
      priceUsage(price, usage, { cacheTtl: "1h", provider: "anthropic" }).cacheWrite,
    ).toBeCloseTo(6, 6);
    expect(priceUsage(price, usage, { cacheTtl: "1h", provider: "openai" }).cacheWrite).toBeCloseTo(
      3.75,
      6,
    );
  });
});

describe("cache monitor causes", () => {
  it("labels cold starts, prefix changes, expiry and growth", () => {
    const key = `s-${Math.random()}`;
    const t0 = 1_000_000;
    expect(recordCacheTurn(key, { input: 10, cacheWrite: 5000 }, t0)).toMatchObject({
      state: "write",
      reason: CACHE_BUST_REASONS.coldStart,
    });
    expect(recordCacheTurn(key, { input: 12, cacheRead: 5000 }, t0 + 1000)).toMatchObject({
      state: "hit",
      bust: false,
    });
    const busted = recordCacheTurn(key, { input: 12, cacheWrite: 5100 }, t0 + 2000);
    expect(busted).toMatchObject({
      bust: true,
      state: "write",
      reason: CACHE_BUST_REASONS.prefixChanged,
    });
    recordCacheTurn(key, { input: 12, cacheRead: 5100 }, t0 + 3000);
    const expired = recordCacheTurn(key, { input: 12, cacheWrite: 5100 }, t0 + 3000 + 6 * 60_000);
    expect(expired.reason).toBe(CACHE_BUST_REASONS.expired);
    recordCacheTurn(key, { input: 12, cacheRead: 5100 }, t0 + 10 * 60_000);
    const grew = recordCacheTurn(key, { input: 40, cacheWrite: 9000 }, t0 + 10 * 60_000 + 500);
    expect(grew).toMatchObject({ bust: false, reason: CACHE_BUST_REASONS.prefixGrew });
    const longTtl = `s-${Math.random()}`;
    recordCacheTurn(longTtl, { input: 10, cacheWrite: 5000 }, t0);
    recordCacheTurn(longTtl, { input: 10, cacheRead: 5000 }, t0 + 1000);
    expect(
      recordCacheTurn(longTtl, { input: 10, cacheWrite: 5000 }, t0 + 30 * 60_000, {
        ttlMs: 60 * 60_000,
      }).reason,
    ).toBe(CACHE_BUST_REASONS.prefixChanged);
  });
});

describe("ledger phase 5 columns and summary sections", () => {
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

  it("migrates an old schema by adding the new columns", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(
      `CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, dedupe_key TEXT, kind TEXT NOT NULL, feature TEXT NOT NULL, provider TEXT, model TEXT, api TEXT, agent_id TEXT, session_key TEXT, session_id TEXT, run_id TEXT, task_id TEXT, channel TEXT, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0, cost_total REAL NOT NULL DEFAULT 0, cost_source TEXT NOT NULL, price_input REAL, price_output REAL, price_cache_read REAL, price_cache_write REAL, duration_ms INTEGER, status TEXT NOT NULL DEFAULT 'ok', stop_reason TEXT, batch INTEGER NOT NULL DEFAULT 0, items INTEGER, source TEXT NOT NULL DEFAULT 'live')`,
    );
    const migrated = new UsageLedger(db);
    const cols = (
      db.prepare("PRAGMA table_info(usage_events)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["cost_computed", "cache_state", "cache_bust_reason", "cache_ttl"]),
    );
    migrated.close();
  });

  it("stores computed cost next to reported cost, cache state, and keeps per-item rows", async () => {
    const reported = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 1000, output: 500 },
      cost: { total: 0.5 },
      cacheState: "write",
      cacheBustReason: CACHE_BUST_REASONS.prefixChanged,
      cacheTtl: "5m",
      config: cfgWithOverride,
    });
    expect(reported?.costSource).toBe("provider");
    expect(reported?.cost.total).toBe(0.5);
    expect(reported?.costComputed).toBeCloseTo((1000 * 2 + 500 * 4) / 1_000_000, 9);
    expect(reported?.cacheState).toBe("write");
    expect(reported?.cacheTtl).toBe("5m");
    const perItem = await resolveUsageEvent({
      kind: "audio",
      feature: "media/audio",
      provider: "deepgram",
      model: "nova-3",
      usage: { total: 0 },
      items: 1,
    });
    expect(perItem).not.toBeNull();
    expect(perItem?.costSource).toBe("unpriced");
    const id = ledger.insert(reported!);
    expect(id).not.toBeNull();
    const row = ledger.events({ limit: 1 }).events[0]!;
    expect(row.costComputed).toBeCloseTo(reported!.costComputed!, 9);
    expect(row.cacheBustReason).toBe(CACHE_BUST_REASONS.prefixChanged);
  });

  it("summarizes cache health, burn rate, peak 5h block and tasks", async () => {
    const now = Date.UTC(2026, 8, 16, 12);
    const add = async (ts: number, extra: Partial<Parameters<typeof resolveUsageEvent>[0]>) => {
      const row = await resolveUsageEvent({
        ts,
        kind: "chat",
        feature: "agent/turn",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: { input: 10, cacheRead: 900, output: 50 },
        cost: { total: 0.01, cacheWrite: 0 },
        ...extra,
      } as Parameters<typeof resolveUsageEvent>[0]);
      ledger.insert(row!);
    };
    for (let i = 0; i < 12; i += 1) {
      await add(
        now - (12 - i) * 60_000,
        i === 5
          ? {
              usage: { input: 10, cacheWrite: 900, output: 50 },
              cost: { total: 0.05, cacheWrite: 0.04 },
              cacheState: "write",
              cacheBustReason: CACHE_BUST_REASONS.prefixChanged,
              taskId: "task-1",
              runId: "run-a",
            }
          : {
              cacheState: "hit",
              taskId: i % 2 ? "task-1" : undefined,
              runId: i % 2 ? `run-${i}` : undefined,
            },
      );
    }
    // An old expensive block two days ago sets the peak.
    await add(now - 2 * 24 * 3_600_000, { cost: { total: 2 } });
    const summary = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: now - 7 * 24 * 3_600_000,
      endMs: now,
      nowMs: now,
      taskInfo: (id) => ({ status: "running", goal: `goal for ${id}` }),
    });
    expect(summary.cacheHealth.requests).toBe(13);
    expect(summary.cacheHealth.busts).toBe(1);
    expect(summary.cacheHealth.wastedUsd).toBeCloseTo(0.04, 9);
    expect(summary.cacheHealth.warm).toBe(true);
    expect(summary.cacheHealth.reasons[0]).toEqual({
      reason: CACHE_BUST_REASONS.prefixChanged,
      count: 1,
    });
    expect(summary.live.window5h.calls).toBe(12);
    expect(summary.live.window5h.costPerHour).toBeGreaterThan(0);
    // The block started at the top of the hour of the first recent call and runs 5h, so the
    // projection extends the last hour's pace over the remaining time.
    expect(summary.live.window5h.endMs - summary.live.window5h.startMs).toBe(5 * 3_600_000);
    expect(summary.live.window5h.projectedCost).toBeGreaterThan(summary.live.window5h.cost);
    // The peak excludes the current block.
    expect(summary.live.peak5h?.cost).toBeCloseTo(2, 9);
    expect(summary.totals.computedCalls).toBe(13);
    // A finished block is superseded by the block of the latest call.
    const later = Date.UTC(2026, 8, 16, 20, 30);
    await add(later - 5 * 60_000, { cost: { total: 0.2 } });
    const moved = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: later - 7 * 24 * 3_600_000,
      endMs: later,
      nowMs: later,
    });
    expect(moved.live.window5h.startMs).toBe(Date.UTC(2026, 8, 16, 20));
    expect(moved.live.window5h.calls).toBe(1);
    expect(summary.byTask).toHaveLength(1);
    expect(summary.byTask[0]).toMatchObject({ taskId: "task-1", label: "goal for task-1" });
    expect(summary.byTask[0]!.runs).toBeGreaterThan(1);
    expect(summary.totals.reportedCalls).toBe(13);
    expect(summary.totals.costComputed).toBeGreaterThan(0);
  });

  it("maps a row to OTel GenAI attributes", async () => {
    const row = await resolveUsageEvent({
      kind: "embedding",
      feature: "memory/index",
      provider: "openai",
      model: "text-embedding-3-small",
      usage: { total: 100 },
    });
    const attrs = usageRowToMetricAttributes({ id: 1, ...row! });
    expect(attrs).toMatchObject({
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "text-embedding-3-small",
      "gen_ai.operation.name": "embeddings",
      "gen_ai.token.modality": "text",
      "bitterbot.feature": "memory/index",
    });
  });
});
