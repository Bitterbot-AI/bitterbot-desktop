import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMBEDDING_PRICES_PER_MILLION,
  priceUsage,
  resetModelPricingMemoForTest,
  resolveModelPricing,
} from "./model-pricing.js";
import {
  budgetWindowBounds,
  checkUsageBudgetAlerts,
  evaluateUsageBudgets,
  isBackgroundUsagePaused,
  onUsageBudgetAlert,
} from "./usage-budgets.js";
import {
  UsageLedger,
  flushUsageLedger,
  getUsageLedger,
  onUsageEvent,
  recordUsage,
  resolveUsageEvent,
  setUsageLedgerConfigEnabledForTest,
  setUsageLedgerForTest,
  stopUsageLedger,
  toUsageBuckets,
} from "./usage-ledger.js";
import {
  parseTranscriptLine,
  reconcileTranscripts,
  transcriptSessionId,
} from "./usage-reconcile.js";
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

describe("model pricing", () => {
  beforeEach(() => resetModelPricingMemoForTest());

  it("prefers config overrides and ignores all-zero costs", async () => {
    const hit = await resolveModelPricing({
      provider: "acme",
      model: "priced",
      cfg: cfgWithOverride,
    });
    expect(hit.source).toBe("override");
    expect(hit.price.input).toBe(2);
  });

  it("prices vendored embedding models and marks local inference as free-by-construction", async () => {
    const openai = await resolveModelPricing({
      provider: "openai",
      model: "text-embedding-3-small",
      kind: "embedding",
    });
    expect(openai.source).toBe("embedding-catalog");
    expect(openai.price.input).toBe(EMBEDDING_PRICES_PER_MILLION["openai/text-embedding-3-small"]);
    const gemini = await resolveModelPricing({
      provider: "gemini",
      model: "models/gemini-embedding-001",
      kind: "embedding",
    });
    expect(gemini.source).toBe("embedding-catalog");
    const local = await resolveModelPricing({
      provider: "ollama",
      model: "nomic-embed-text",
      kind: "embedding",
    });
    expect(local.source).toBe("local");
    const unknown = await resolveModelPricing({
      provider: "voyage",
      model: "voyage-99",
      kind: "embedding",
    });
    expect(unknown.source).toBe("unpriced");
  });

  it("resolves chat models from the vendored catalog", async () => {
    const haiku = await resolveModelPricing({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(haiku.source).toBe("catalog");
    expect(haiku.price.input).toBeGreaterThan(0);
    expect(haiku.price.cacheRead).toBeGreaterThan(0);
  });

  it("prices exclusive buckets per million and halves for batch", () => {
    const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    const usage = {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 1_000_000,
      reasoning: 0,
      total: 4_000_000,
    };
    expect(priceUsage(price, usage).total).toBeCloseTo(7.35, 6);
    expect(priceUsage(price, usage, { batch: true }).total).toBeCloseTo(3.675, 6);
  });
});

describe("toUsageBuckets", () => {
  it("keeps exclusive buckets, clamps reasoning to output, and treats total-only usage as input", () => {
    expect(
      toUsageBuckets({ input: 10, cacheRead: 5, cacheWrite: 2, output: 3, reasoning: 99 }),
    ).toEqual({
      input: 10,
      cacheRead: 5,
      cacheWrite: 2,
      output: 3,
      reasoning: 3,
      total: 20,
    });
    expect(toUsageBuckets({ total: 42 })).toEqual({
      input: 42,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 42,
    });
    expect(toUsageBuckets(undefined).total).toBe(0);
  });
});

describe("UsageLedger", () => {
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

  it("records, prices, dedupes and emits", async () => {
    const seen: Array<{ id: number; feature: string }> = [];
    const off = onUsageEvent((evt) => seen.push({ id: evt.id, feature: evt.feature }));
    recordUsage({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 1000, output: 500 },
      dedupeKey: "s1:1",
      config: cfgWithOverride,
    });
    // Same dedupe key → ignored.
    recordUsage({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 1000, output: 500 },
      dedupeKey: "s1:1",
      config: cfgWithOverride,
    });
    // Provider-reported cost wins over the table.
    recordUsage({
      kind: "chat",
      feature: "agent/subagent",
      provider: "acme",
      model: "priced",
      usage: { input: 10, output: 10 },
      cost: { total: 0.5, input: 0.25, output: 0.25 },
      config: cfgWithOverride,
    });
    // Zero usage → dropped.
    recordUsage({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 0 },
    });
    await flushUsageLedger();
    off();

    expect(ledger.count()).toBe(2);
    expect(seen.map((s) => s.feature)).toEqual(["agent/turn", "agent/subagent"]);
    const page = ledger.events({ limit: 10 });
    const [sub, turn] = page.events;
    expect(turn?.costSource).toBe("override");
    expect(turn?.cost.total).toBeCloseTo((1000 * 2 + 500 * 4) / 1_000_000, 9);
    expect(turn?.price?.input).toBe(2);
    expect(sub?.costSource).toBe("provider");
    expect(sub?.cost.total).toBe(0.5);
  });

  it("marks local and estimated rows and never throws for unknown models", async () => {
    const localRow = await resolveUsageEvent({
      kind: "embedding",
      feature: "memory/index",
      provider: "local",
      model: "embeddinggemma",
      usage: { total: 300 },
      costSource: "local",
    });
    expect(localRow?.costSource).toBe("local");
    expect(localRow?.cost.total).toBe(0);
    const est = await resolveUsageEvent({
      kind: "embedding",
      feature: "memory/search",
      provider: "gemini",
      model: "gemini-embedding-001",
      usage: { total: 1_000_000 },
      costSource: "estimated",
    });
    expect(est?.costSource).toBe("estimated");
    expect(est?.cost.total).toBeCloseTo(0.15, 6);
    const unknown = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "nobody",
      model: "mystery",
      usage: { input: 5, output: 5 },
    });
    expect(unknown?.costSource).toBe("unpriced");
    expect(unknown?.cost.total).toBe(0);
  });

  it("filters, pages and prunes", async () => {
    const base = Date.UTC(2026, 8, 10);
    for (let i = 0; i < 5; i += 1) {
      const row = await resolveUsageEvent({
        ts: base + i * 3_600_000,
        kind: i % 2 === 0 ? "chat" : "embedding",
        feature: i % 2 === 0 ? "agent/turn" : "memory/index",
        provider: "acme",
        model: "priced",
        agentId: i < 3 ? "main" : "other",
        usage: { input: 100 * (i + 1), output: 10 },
        config: cfgWithOverride,
      });
      ledger.insert(row!);
    }
    expect(ledger.rows({ kind: "embedding" })).toHaveLength(2);
    expect(ledger.rows({ agentId: "other" })).toHaveLength(2);
    const first = ledger.events({ limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextBeforeId).not.toBeNull();
    const second = ledger.events({ limit: 2, beforeId: first.nextBeforeId! });
    expect(second.events[0]?.id).toBeLessThan(first.events[1]!.id);
    expect(ledger.spend({ startMs: base, endMs: base + 10 * 3_600_000 })).toBeGreaterThan(0);
    expect(ledger.pruneOlderThan(base + 2 * 3_600_000 + 1)).toBe(3);
    expect(ledger.count()).toBe(2);
  });
});

describe("budgets", () => {
  let ledger: UsageLedger;
  const cfg = {
    usage: {
      budgets: {
        mode: "enforce",
        daily: { usd: 1 },
        perFeature: { "memory/dream": { usd: 0.5 } },
        perModel: { "acme/priced": { usd: 100 } },
      },
    },
  } as unknown as import("../config/config.js").BitterbotConfig;

  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  it("computes UTC windows", () => {
    const wed = Date.UTC(2026, 8, 16, 15); // Wednesday
    expect(budgetWindowBounds("daily", wed)).toEqual({
      startMs: Date.UTC(2026, 8, 16),
      endMs: Date.UTC(2026, 8, 17),
    });
    expect(budgetWindowBounds("weekly", wed)).toEqual({
      startMs: Date.UTC(2026, 8, 14),
      endMs: Date.UTC(2026, 8, 21),
    });
    expect(budgetWindowBounds("monthly", wed)).toEqual({
      startMs: Date.UTC(2026, 8, 1),
      endMs: Date.UTC(2026, 9, 1),
    });
  });

  it("evaluates, alerts once per rung, and pauses only background lanes", async () => {
    const now = Date.UTC(2026, 8, 16, 12);
    const insert = async (feature: string, total: number) => {
      const row = await resolveUsageEvent({
        ts: now - 60_000,
        kind: "chat",
        feature,
        provider: "acme",
        model: "priced",
        usage: { input: 1 },
        cost: { total },
      });
      ledger.insert(row!);
    };
    await insert("agent/turn", 0.6);
    let summary = evaluateUsageBudgets({ ledger, cfg, nowMs: now });
    const daily = summary.budgets.find((b) => b.id === "global:daily")!;
    expect(daily.level).toBe(50);
    expect(daily.exceeded).toBe(false);
    expect(daily.projectedUsd).toBeCloseTo(1.2, 6);
    expect(summary.backgroundPaused).toBe(false);

    const alerts: number[] = [];
    const off = onUsageBudgetAlert((a) => alerts.push(a.status.level));
    expect(checkUsageBudgetAlerts({ ledger, cfg, nowMs: now }).map((a) => a.status.id)).toEqual([
      "global:daily",
    ]);
    expect(checkUsageBudgetAlerts({ ledger, cfg, nowMs: now })).toHaveLength(0);

    await insert("memory/dream", 0.6);
    const fired = checkUsageBudgetAlerts({ ledger, cfg, nowMs: now });
    expect(fired.map((a) => a.status.id).toSorted()).toEqual([
      "feature:memory/dream",
      "global:daily",
    ]);
    off();
    expect(alerts).toEqual([50, 100, 100]);

    summary = evaluateUsageBudgets({ ledger, cfg, nowMs: now });
    expect(summary.backgroundPaused).toBe(true);
    expect(isBackgroundUsagePaused({ ledger, cfg, feature: "memory/dream", nowMs: now })).toBe(
      true,
    );
    expect(isBackgroundUsagePaused({ ledger, cfg, feature: "agent/turn", nowMs: now })).toBe(false);
    const warnCfg = {
      usage: { budgets: { mode: "warn", daily: { usd: 1 } } },
    } as unknown as import("../config/config.js").BitterbotConfig;
    expect(
      isBackgroundUsagePaused({ ledger, cfg: warnCfg, feature: "memory/dream", nowMs: now }),
    ).toBe(false);
  });
});

describe("reconcile", () => {
  let dir: string;
  let ledger: UsageLedger;

  beforeEach(() => {
    resetModelPricingMemoForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-usage-"));
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses transcript names and assistant lines", () => {
    expect(transcriptSessionId("abc.jsonl")).toBe("abc");
    expect(transcriptSessionId("abc-topic-7.jsonl")).toBe("abc-topic-7");
    expect(transcriptSessionId("abc.jsonl.deleted.2026-09-01T00:00:00Z")).toBe("abc");
    expect(transcriptSessionId("sessions.json")).toBeNull();
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-09-08T08:23:43.054Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-8",
        api: "anthropic-messages",
        usage: {
          input: 2,
          output: 13,
          cacheRead: 0,
          cacheWrite: 50832,
          totalTokens: 50847,
          cost: {
            total: 0.318035,
            input: 1e-5,
            output: 0.000325,
            cacheRead: 0,
            cacheWrite: 0.3177,
          },
        },
        stopReason: "stop",
        timestamp: 1788855820258,
      },
    });
    const parsed = parseTranscriptLine(line, "abc");
    expect(parsed?.dedupeKey).toBe("abc:1788855820258");
    expect(parsed?.cost?.total).toBeCloseTo(0.318035, 9);
    expect(
      parseTranscriptLine(
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "bitterbot",
            model: "delivery-mirror",
            usage: { input: 0, output: 0 },
          },
        }),
        "abc",
      ),
    ).toBeNull();
    expect(parseTranscriptLine("not json", "abc")).toBeNull();
  });

  it("backfills incrementally with byte cursors and dedupes against live rows", async () => {
    const sessionsDir = path.join(dir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, "s1.jsonl");
    const mk = (ts: number, total: number) =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(ts).toISOString(),
        message: {
          role: "assistant",
          provider: "acme",
          model: "priced",
          usage: { input: 10, output: 5, cost: { total } },
          timestamp: ts,
          stopReason: "stop",
        },
      }) + "\n";
    const t0 = Date.UTC(2026, 8, 1);
    fs.writeFileSync(file, mk(t0, 0.1) + mk(t0 + 1000, 0.2));
    // A live row for the second message already exists.
    const live = await resolveUsageEvent({
      ts: t0 + 1000,
      kind: "chat",
      feature: "agent/subagent",
      provider: "acme",
      model: "priced",
      usage: { input: 10, output: 5 },
      cost: { total: 0.2 },
    });
    ledger.insert({ ...live!, dedupeKey: "s1:" + (t0 + 1000) });

    const first = await reconcileTranscripts({ ledger, stateDir: dir });
    expect(first).toEqual({ files: 1, rows: 1, skipped: 1 });
    expect(ledger.count()).toBe(2);
    // Live attribution survives.
    expect(ledger.rows({ feature: "agent/subagent" })).toHaveLength(1);

    // Unchanged file → nothing re-read.
    expect((await reconcileTranscripts({ ledger, stateDir: dir })).rows).toBe(0);

    // Append one line plus a torn tail; only the complete line lands, the tail waits.
    fs.appendFileSync(
      file,
      mk(t0 + 2000, 0.3) +
        '{"type":"message","timestamp":"2026-09-01T00:00:03.000Z","message":{"role":"assistant","provider":"acme","model":"priced","usage":{"input":1,"outp',
    );
    expect((await reconcileTranscripts({ ledger, stateDir: dir })).rows).toBe(1);
    fs.appendFileSync(file, 'ut":1},"timestamp":' + (t0 + 3000) + "}}\n");
    expect((await reconcileTranscripts({ ledger, stateDir: dir })).rows).toBe(1);
    expect(ledger.count()).toBe(4);
    expect(ledger.getMeta("reconcile:lastAt")).not.toBeNull();
  });
});

describe("summary", () => {
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  it("pivots by model, feature, kind, agent and day with cache hit rate and flags", async () => {
    const day1 = Date.UTC(2026, 8, 10, 12);
    const day2 = Date.UTC(2026, 8, 11, 12);
    const add = async (input: Partial<Parameters<typeof resolveUsageEvent>[0]>) => {
      const row = await resolveUsageEvent({
        kind: "chat",
        feature: "agent/turn",
        provider: "acme",
        model: "priced",
        usage: { input: 100, output: 50 },
        config: cfgWithOverride,
        ...input,
      } as Parameters<typeof resolveUsageEvent>[0]);
      ledger.insert(row!);
    };
    await add({ ts: day1, usage: { input: 100, cacheRead: 900, output: 50 } });
    await add({
      ts: day1,
      kind: "embedding",
      feature: "memory/index",
      provider: "openai",
      model: "text-embedding-3-small",
      usage: { total: 5000 },
    });
    await add({
      ts: day2,
      agentId: "other",
      provider: "nobody",
      model: "mystery",
      usage: { input: 10, output: 1 },
    });

    const summary = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: Date.UTC(2026, 8, 10),
      endMs: Date.UTC(2026, 8, 12) - 1,
      nowMs: day2,
    });
    expect(summary.totals.calls).toBe(3);
    expect(summary.days).toBe(2);
    expect(summary.daily.map((d) => d.date)).toEqual(["2026-09-10", "2026-09-11"]);
    expect(summary.daily[0]?.byModel).toHaveLength(2);
    expect(summary.daily[0]?.byKind.map((k) => k.kind).toSorted()).toEqual(["chat", "embedding"]);
    const priced = summary.byModel.find((m) => m.model === "priced")!;
    expect(priced.cacheHitRate).toBeCloseTo(0.9, 6);
    expect(priced.pricingSources).toEqual(["override"]);
    const embed = summary.byKind.find((k) => k.key === "embedding")!;
    expect(embed.usage.total).toBe(5000);
    expect(embed.cost.total).toBeCloseTo((5000 * 0.02) / 1_000_000, 12);
    expect(summary.byFeature.find((f) => f.key === "memory/index")?.label).toContain(
      "Memory indexing",
    );
    expect(summary.byAgent.map((a) => a.key).toSorted()).toEqual(["other", "unknown"]);
    expect(summary.unpricedModels).toEqual([
      { provider: "nobody", model: "mystery", calls: 1, tokens: 11 },
    ]);
    expect(summary.flags.some((f) => f.id === "unpriced-models")).toBe(true);
    expect(summary.ledger.events).toBe(3);
  });
});

describe("ledger latches", () => {
  afterEach(() => setUsageLedgerForTest(null));

  it("honors usage.ledger.enabled=false even for lazy CLI-style recording", async () => {
    const ledger = UsageLedger.openInMemory();
    setUsageLedgerForTest(ledger);
    setUsageLedgerConfigEnabledForTest(false);
    recordUsage({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 5, output: 5 },
    });
    await flushUsageLedger();
    expect(ledger.count()).toBe(0);
    ledger.close();
  });

  it("does not reopen after stopUsageLedger and drains before close", async () => {
    const ledger = UsageLedger.openInMemory();
    setUsageLedgerForTest(ledger);
    setUsageLedgerConfigEnabledForTest(true);
    recordUsage({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 5, output: 5 },
      config: cfgWithOverride,
    });
    await flushUsageLedger();
    expect(ledger.count()).toBe(1);
    stopUsageLedger();
    expect(getUsageLedger()).toBeNull();
    recordUsage({
      kind: "chat",
      feature: "agent/turn",
      provider: "acme",
      model: "priced",
      usage: { input: 5, output: 5 },
    });
    await flushUsageLedger();
    expect(getUsageLedger()).toBeNull();
  });
});

describe("reconcile multibyte boundary", () => {
  it("keeps a byte-accurate cursor when a torn tail contains multibyte characters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-usage-mb-"));
    const ledger = UsageLedger.openInMemory();
    try {
      const sessionsDir = path.join(dir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, "mb.jsonl");
      const t0 = Date.UTC(2026, 8, 2);
      const line = (ts: number) =>
        JSON.stringify({
          type: "message",
          timestamp: new Date(ts).toISOString(),
          message: {
            role: "assistant",
            provider: "acme",
            model: "priced",
            usage: { input: 3, output: 2, cost: { total: 0.01 } },
            timestamp: ts,
            content: [{ type: "text", text: "héllo — ünïcode ✓ 日本語" }],
          },
        }) + "\n";
      // Complete line + a torn tail that ends in the middle of a multibyte sequence.
      const torn = line(t0 + 1000);
      const tornBytes = Buffer.from(torn, "utf8");
      const cut = tornBytes.subarray(0, tornBytes.indexOf(Buffer.from("日本語", "utf8")) + 4);
      fs.writeFileSync(file, Buffer.concat([Buffer.from(line(t0), "utf8"), cut]));
      expect((await reconcileTranscripts({ ledger, stateDir: dir })).rows).toBe(1);
      fs.appendFileSync(file, tornBytes.subarray(cut.length));
      expect((await reconcileTranscripts({ ledger, stateDir: dir })).rows).toBe(1);
      expect(ledger.count()).toBe(2);
    } finally {
      ledger.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
