import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resetModelPricingMemoForTest } from "./model-pricing.js";
import { hotSetCheck, prefixStabilityCheck, spilledResultsCheck } from "./usage-doctor-checks.js";
import { UsageLedger, resolveUsageEvent } from "./usage-ledger.js";
import {
  buildPrefixStability,
  buildToolTelemetry,
  HOT_SET_PROMOTE_MIN_INDIRECT_PER_WEEK,
  renderToolTelemetry,
} from "./usage-tool-telemetry.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 20, 12);
const WINDOW = { startMs: NOW - 7 * DAY, endMs: NOW };

describe("tool_calls telemetry", () => {
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  it("counts direct / use_tool / native-search calls and names promotion candidates", () => {
    for (let i = 0; i < 12; i += 1) {
      ledger.insertToolCall({ ts: NOW - i * 3_600_000, tool: "read", via: "direct", ok: true });
    }
    for (let i = 0; i < 6; i += 1) {
      ledger.insertToolCall({
        ts: NOW - i * 3_600_000,
        tool: "browser",
        via: "use_tool",
        ok: i !== 0,
        errorClass: i === 0 ? "timeout" : undefined,
        durationMs: 120,
      });
    }
    ledger.insertToolCall({ ts: NOW - 10, tool: "canvas", via: "use_tool", ok: true });
    ledger.insertToolCall({ ts: NOW - 20, tool: "wallet", via: "native-search", ok: true });
    ledger.insertToolCall({ ts: NOW - 30, tool: "list_tools", via: "list_tools", ok: true });
    // Outside the window: ignored.
    ledger.insertToolCall({ ts: NOW - 9 * DAY, tool: "browser", via: "use_tool", ok: true });

    const t = buildToolTelemetry(ledger, WINDOW);
    expect(t.calls).toBe(21);
    expect(t.direct).toBe(12);
    expect(t.useTool).toBe(7);
    expect(t.useToolFailed).toBe(1);
    expect(t.nativeSearch).toBe(1);
    expect(t.listTools).toBe(1);
    expect(t.indirect[0]).toEqual({ tool: "browser", calls: 6, failed: 1 });
    expect(t.promote).toEqual(["browser"]);
    expect(t.promoteThreshold).toBe(HOT_SET_PROMOTE_MIN_INDIRECT_PER_WEEK);
    expect(t.errorClasses).toEqual([{ errorClass: "timeout", calls: 1 }]);

    const line = hotSetCheck({ ledger, nowMs: NOW });
    expect(line.level).toBe("warn");
    expect(line.message).toContain(
      "hot-set: 12 direct calls, 7 via use_tool (1 failed), 1 via native search in 7d",
    );
    expect(line.message).toContain("browser (6, 1 failed)");
    expect(line.message).toContain("Add browser to tools.hotSet");
  });

  it("scales the promotion threshold to the window and stays info below it", () => {
    for (let i = 0; i < 4; i += 1) {
      ledger.insertToolCall({ ts: NOW - i * DAY, tool: "browser", via: "use_tool", ok: true });
    }
    expect(buildToolTelemetry(ledger, WINDOW).promote).toEqual([]);
    expect(hotSetCheck({ ledger, nowMs: NOW }).level).toBe("info");
    // 30-day window needs ~21 indirect calls, not 5.
    for (let i = 4; i < 10; i += 1) {
      ledger.insertToolCall({ ts: NOW - i * DAY, tool: "browser", via: "use_tool", ok: true });
    }
    expect(buildToolTelemetry(ledger, { startMs: NOW - 30 * DAY, endMs: NOW }).promote).toEqual([]);
    expect(buildToolTelemetry(ledger, WINDOW).promote).toEqual(["browser"]);
  });

  it("reports spilled results with the average original size", () => {
    ledger.insertToolCall({
      ts: NOW - 1,
      tool: "exec",
      via: "direct",
      ok: true,
      resultChars: 20_000,
      spilled: true,
    });
    ledger.insertToolCall({
      ts: NOW - 2,
      tool: "read",
      via: "direct",
      ok: true,
      resultChars: 40_000,
      spilled: true,
    });
    ledger.insertToolCall({
      ts: NOW - 3,
      tool: "read",
      via: "direct",
      ok: true,
      resultChars: 500,
      spilled: false,
    });
    const t = buildToolTelemetry(ledger, WINDOW);
    expect(t.spilled.calls).toBe(2);
    expect(t.spilled.avgChars).toBe(30_000);
    const line = spilledResultsCheck({ ledger, nowMs: NOW });
    expect(line.level).toBe("info");
    expect(line.message).toBe("tool results spilled: 2 in 7d, avg 30,000 chars (exec 1, read 1)");
    expect(spilledResultsCheck({ ledger: UsageLedger.openInMemory(), nowMs: NOW })).toEqual({
      level: "ok",
      message: "tool results spilled: 0 in 7d",
    });
  });

  it("prunes tool_calls with the retention sweep and reads rows back typed", () => {
    ledger.insertToolCall({ ts: NOW - 400 * DAY, tool: "old", via: "direct", ok: true });
    ledger.insertToolCall({
      ts: NOW,
      tool: "new",
      via: "use_tool",
      ok: false,
      errorClass: "denied",
    });
    ledger.pruneOlderThan(NOW - 365 * DAY);
    const rows = ledger.toolCalls({});
    expect(rows.map((r) => r.tool)).toEqual(["new"]);
    expect(rows[0]).toMatchObject({
      via: "use_tool",
      ok: false,
      errorClass: "denied",
      spilled: false,
    });
  });
});

describe("prefix-stability telemetry", () => {
  type Input = Parameters<typeof resolveUsageEvent>[0];
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  async function turn(row: Partial<Input> & { ts: number; sessionKey: string }) {
    const evt = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { input: 5, cacheRead: 20_000, output: 100 },
      prefixDigest: "sys-A",
      toolsDigest: "tools-A",
      ...row,
    } as Input);
    ledger.insert(evt!);
    return evt!;
  }

  it("stores the digests on the row and flags a mid-session change with its tier", async () => {
    const stored = await turn({ ts: NOW - 50 * 60_000, sessionKey: "agent:main:main" });
    expect(stored.prefixDigest).toBe("sys-A");
    expect(stored.toolsDigest).toBe("tools-A");
    await turn({ ts: NOW - 40 * 60_000, sessionKey: "agent:main:main", toolsDigest: "tools-B" });
    await turn({ ts: NOW - 30 * 60_000, sessionKey: "agent:main:main", toolsDigest: "tools-B" });
    // A change after a gap longer than an hour is a cold start, not a mid-session bust.
    await turn({ ts: NOW - 5 * 3_600_000, sessionKey: "agent:main:other" });
    await turn({ ts: NOW - 2 * 3_600_000, sessionKey: "agent:main:other", prefixDigest: "sys-B" });
    // Rows without digests never count.
    await turn({
      ts: NOW - 20 * 60_000,
      sessionKey: "agent:main:legacy",
      prefixDigest: null,
      toolsDigest: null,
    });
    await turn({
      ts: NOW - 10 * 60_000,
      sessionKey: "agent:main:legacy",
      prefixDigest: null,
      toolsDigest: null,
    });

    const p = buildPrefixStability(ledger, WINDOW);
    expect(p.sessions).toBe(2);
    expect(p.changed).toHaveLength(1);
    expect(p.changed[0]).toMatchObject({
      sessionKey: "agent:main:main",
      turns: 3,
      changes: 1,
      tier: "tools",
    });

    const line = prefixStabilityCheck({ ledger, nowMs: NOW });
    expect(line.level).toBe("warn");
    expect(line.message).toContain(
      "prefix stability: 1 session(s) in 7d where the cached prefix changed mid-session (turns < 60 min apart)",
    );
    expect(line.message).toContain("agent:main:main, 3 turns, 1 change(s), likely tier: tools");
    expect(line.message).toContain("BITTERBOT_CACHE_TRACE=1");
  });

  it("is ok when every session kept its prefix and reports both tiers when both moved", async () => {
    await turn({ ts: NOW - 30 * 60_000, sessionKey: "agent:main:main" });
    await turn({ ts: NOW - 20 * 60_000, sessionKey: "agent:main:main" });
    expect(prefixStabilityCheck({ ledger, nowMs: NOW })).toEqual({
      level: "ok",
      message: "prefix stability: 1 session(s) in 7d, none changed their cached prefix mid-session",
    });
    await turn({
      ts: NOW - 10 * 60_000,
      sessionKey: "agent:main:main",
      prefixDigest: "sys-B",
      toolsDigest: "tools-B",
    });
    const p = buildPrefixStability(ledger, WINDOW);
    expect(p.changed[0]?.tier).toBe("both");
    const lines = renderToolTelemetry({
      tools: buildToolTelemetry(ledger, WINDOW),
      prefix: p,
      days: 7,
    });
    expect(lines[0]).toBe("Tool calls, last 7d: 0 (0 failed)");
    expect(lines.at(-1)).toContain("tip: a prompt section above the cache boundary is changing");
  });
});

describe("per-TTL cache-write split and batch pricing", () => {
  beforeEach(() => resetModelPricingMemoForTest());

  const cfg = {
    models: {
      providers: {
        anthropic: {
          models: [
            { id: "test-model", cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
          ],
        },
      },
    },
  } as unknown as import("../config/config.js").BitterbotConfig;

  it("sets cache_ttl from the split and prices the 1h share at 2x input", async () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };
    const mixed = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "test-model",
      usage,
      cacheTtl: "5m",
      cacheWrite5m: 500_000,
      cacheWrite1h: 500_000,
      config: cfg,
    });
    expect(mixed?.cacheTtl).toBe("1h");
    expect(mixed?.cacheWrite5m).toBe(500_000);
    expect(mixed?.cacheWrite1h).toBe(500_000);
    // Override price is trusted verbatim for the 5m share; the 1h share is 2/1.25 of it on Anthropic
    // only when the price is not an override, so an override prices both shares at 12.5.
    expect(mixed?.cost.cacheWrite).toBeCloseTo(12.5, 6);

    const catalog = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage,
      cacheWrite5m: 500_000,
      cacheWrite1h: 500_000,
    });
    const only5m = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 0,
    });
    expect(only5m?.cacheTtl).toBe("5m");
    // Half at the 5m rate, half at the 1h rate (2/1.25 of it) = 1.3x the all-5m cost.
    expect(catalog!.cost.cacheWrite / only5m!.cost.cacheWrite).toBeCloseTo(1.3, 6);
  });

  it("rescales only the 1h share of a library-reported cost", async () => {
    const evt = await resolveUsageEvent({
      kind: "chat",
      feature: "memory/dream",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000 },
      cost: { cacheWrite: 1, total: 1 },
      cacheWrite5m: 500,
      cacheWrite1h: 500,
    });
    expect(evt?.costSource).toBe("provider");
    expect(evt?.cost.cacheWrite).toBeCloseTo(1 + (2 / 1.25 - 1) * 0.5, 6);
  });

  it("prices batch rows at 50% with cache tokens as reported", async () => {
    const usage = { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 100_000 };
    const live = await resolveUsageEvent({
      kind: "chat",
      feature: "memory/dream",
      provider: "anthropic",
      model: "test-model",
      usage,
      config: cfg,
    });
    const batch = await resolveUsageEvent({
      kind: "chat",
      feature: "memory/dream",
      provider: "anthropic",
      model: "test-model",
      usage,
      batch: true,
      config: cfg,
    });
    expect(batch?.batch).toBe(true);
    expect(batch?.usage.cacheRead).toBe(200_000);
    expect(batch?.usage.cacheWrite).toBe(100_000);
    expect(batch!.cost.total).toBeCloseTo(live!.cost.total / 2, 6);
    expect(batch!.costComputed!).toBeCloseTo(live!.costComputed! / 2, 6);
  });
});

describe("usage:v3 migration", () => {
  it("adds the new columns and the tool_calls table to a pre-existing database", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, dedupe_key TEXT,
      kind TEXT NOT NULL, feature TEXT NOT NULL, provider TEXT, model TEXT, api TEXT, agent_id TEXT,
      session_key TEXT, session_id TEXT, run_id TEXT, task_id TEXT, channel TEXT,
      input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0, cost_source TEXT NOT NULL, price_input REAL,
      price_output REAL, price_cache_read REAL, price_cache_write REAL, duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ok', stop_reason TEXT, batch INTEGER NOT NULL DEFAULT 0,
      items INTEGER, source TEXT NOT NULL DEFAULT 'live'
    ); CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.exec(
      `INSERT INTO usage_events (ts, day, kind, feature, cost_source) VALUES (1, '2026-01-01', 'chat', 'agent/turn', 'unpriced')`,
    );
    const ledger = new UsageLedger(db);
    const cols = new Set(
      (
        db.prepare("PRAGMA table_info(usage_events)").all() as unknown as Array<{ name: string }>
      ).map((c) => c.name),
    );
    for (const c of [
      "cache_write_5m",
      "cache_write_1h",
      "prefix_digest",
      "tools_digest",
      "cache_ttl",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
    expect(ledger.rows({})[0]).toMatchObject({
      prefixDigest: null,
      toolsDigest: null,
      cacheWrite5m: null,
    });
    ledger.insertToolCall({ ts: 2, tool: "read", via: "direct", ok: true });
    expect(ledger.toolCalls({})).toHaveLength(1);
    ledger.close();
  });
});
