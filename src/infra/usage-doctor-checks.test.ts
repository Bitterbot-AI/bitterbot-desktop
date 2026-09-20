import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetModelPricingMemoForTest } from "./model-pricing.js";
import {
  countHeartbeatDeliveries,
  heartbeatCostCheck,
  idleDayFloorCheck,
  unreadCacheWriteCheck,
} from "./usage-doctor-checks.js";
import { UsageLedger, resolveUsageEvent } from "./usage-ledger.js";
import { buildUsageLedgerSummary } from "./usage-summary.js";

const DAY = 24 * 60 * 60_000;
// Noon UTC so "today" is a stable partial day.
const NOW = Date.UTC(2026, 8, 19, 12);
type Input = Parameters<typeof resolveUsageEvent>[0];

async function seed(ledger: UsageLedger, rows: Array<Partial<Input> & { ts: number }>) {
  for (const r of rows) {
    const evt = await resolveUsageEvent({
      kind: "chat",
      feature: "agent/heartbeat",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { input: 2, output: 13, cacheWrite: 50_000 },
      cost: { cacheWrite: 0.31, total: 0.31 },
      cacheTtl: "5m",
      ...r,
    } as Input);
    ledger.insert(evt!);
  }
}

describe("usage doctor lines", () => {
  let ledger: UsageLedger;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => ledger.close());

  it("unread cache writes: warn at $1/day, fail at $5/day, lanes listed with their TTL", async () => {
    // 4 heartbeat ticks a day for 7 days: $1.24/day of unread cache writes.
    const rows: Array<Partial<Input> & { ts: number }> = [];
    for (let d = 0; d < 7; d += 1) {
      for (let i = 0; i < 4; i += 1) {
        rows.push({ ts: NOW - d * DAY - i * 3_600_000, sessionKey: "agent:main:main" });
      }
    }
    // The same model reading its cache fine in chat must not mask the heartbeat lane.
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        ts: NOW - i * 3_600_000 - 10,
        feature: "agent/turn",
        sessionKey: "agent:main:main",
        usage: { input: 5, cacheRead: 50_000, output: 200 },
        cost: { cacheRead: 0.02, total: 0.05 },
        cacheState: "hit",
      });
    }
    await seed(ledger, rows);
    const warnLine = unreadCacheWriteCheck({ ledger, nowMs: NOW });
    expect(warnLine.level).toBe("warn");
    expect(warnLine.message).toContain("Heartbeats $8.68 (28 req, 5m TTL)");
    expect(warnLine.message).toContain("$1.24/day");
    expect(warnLine.message).toContain("the 5m cache TTL");

    // 20 ticks a day: $6.20/day.
    for (let d = 0; d < 7; d += 1) {
      for (let i = 4; i < 20; i += 1) {
        rows.push({ ts: NOW - d * DAY - i * 60_000, sessionKey: "agent:main:main" });
      }
    }
    await seed(ledger, rows.slice(28 + 20));
    expect(unreadCacheWriteCheck({ ledger, nowMs: NOW }).level).toBe("error");
  });

  it("unread rule judges per session class: main-session heartbeat writes are not masked by keyed chat reads", async () => {
    const rows: Array<Partial<Input> & { ts: number }> = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push({ ts: NOW - i * 1_800_000, feature: "agent/turn", sessionKey: "agent:main:main" });
    }
    for (let i = 0; i < 30; i += 1) {
      rows.push({
        ts: NOW - i * 60_000 - 5,
        feature: "agent/turn",
        sessionKey: "agent:main:chat-123",
        usage: { input: 5, cacheRead: 50_000, output: 200 },
        cost: { cacheRead: 0.02, total: 0.05 },
      });
    }
    await seed(ledger, rows);
    const summary = buildUsageLedgerSummary({
      ledger,
      cfg: undefined,
      startMs: NOW - DAY,
      endMs: NOW,
      nowMs: NOW,
    });
    expect(summary.cacheHealth.unreadWriteUsd).toBeCloseTo(6 * 0.31, 6);
    expect(summary.cacheHealth.unreadByFeature[0]).toMatchObject({
      feature: "agent/turn",
      requests: 6,
      ttl: "5m",
    });
    const flag = summary.flags.find((f) => f.id === "cache-never-read");
    expect(flag?.tip).toContain("the 5m cache TTL");
    expect(flag?.tip).not.toContain("heartbeat interval");
  });

  it("heartbeat cost of pass: per delivered message, or no deliveries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-hb-cons-"));
    try {
      await seed(ledger, [{ ts: NOW - 1_000 }, { ts: NOW - DAY }, { ts: NOW - 2 * DAY }]);
      const none = heartbeatCostCheck({ ledger, nowMs: NOW, considerationsDir: dir });
      expect(none.level).toBe("info");
      expect(none.message).toContain("3 ticks cost $0.93 in 7d");
      expect(none.message).toContain("no deliveries");
      fs.writeFileSync(
        path.join(dir, "considerations-2026-09-18.ndjson"),
        [
          JSON.stringify({
            ts: NOW - DAY,
            category: "channel-route",
            subject: "heartbeat → telegram",
            decision: "acted",
            reason: "delivered heartbeat payload",
          }),
          JSON.stringify({
            ts: NOW - DAY,
            category: "trigger",
            subject: "interval",
            decision: "skipped",
            reason: "agent returned only an ack token",
          }),
          "",
        ].join("\n"),
      );
      expect(countHeartbeatDeliveries({ nowMs: NOW, days: 7, dir })).toBe(1);
      const one = heartbeatCostCheck({ ledger, nowMs: NOW, considerationsDir: dir });
      expect(one.message).toContain("cost of pass: $0.93 per delivered message (1 delivered)");
      // Money for nothing at >= $1/day with no deliveries is a warning.
      for (let i = 0; i < 30; i += 1) {
        await seed(ledger, [{ ts: NOW - 3 * DAY - i * 60_000 }]);
      }
      expect(heartbeatCostCheck({ ledger, nowMs: NOW, deliveries: 0 }).level).toBe("warn");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idle-day floor: the cheapest whole day with zero real turns, naming its top lane", async () => {
    const day = (n: number) => Date.UTC(2026, 8, 19 - n, 3);
    await seed(ledger, [
      // Yesterday: real chat (output > 20) plus heartbeats: not idle.
      {
        ts: day(1),
        feature: "agent/turn",
        usage: { input: 50, output: 300 },
        cost: { total: 0.2 },
      },
      { ts: day(1) + 1 },
      // Two days ago: 3 heartbeats + a dream call, no real turns.
      { ts: day(2) },
      { ts: day(2) + 1 },
      { ts: day(2) + 2 },
      {
        ts: day(2) + 3,
        feature: "memory/dream",
        usage: { input: 900, output: 200 },
        cost: { total: 0.01 },
      },
      // Three days ago: 2 heartbeats and a tiny ack-like chat row (not a real turn).
      { ts: day(3) },
      { ts: day(3) + 1 },
      {
        ts: day(3) + 2,
        feature: "agent/turn",
        usage: { input: 2, output: 3 },
        cost: { total: 0.01 },
      },
      // Today (partial) is cheaper but must be ignored.
      {
        ts: NOW - 1_000,
        feature: "memory/dream",
        usage: { input: 10, output: 5 },
        cost: { total: 0.001 },
      },
    ]);
    const line = idleDayFloorCheck({ ledger, nowMs: NOW });
    expect(line.level).toBe("info");
    expect(line.message).toContain("idle-day floor: $0.63/day (2026-09-16");
    expect(line.message).toContain("2 idle day(s) in 14d");
    expect(line.message).toContain("top lane that day: Heartbeats $0.62");
    expect(idleDayFloorCheck({ ledger: UsageLedger.openInMemory(), nowMs: NOW }).message).toContain(
      "no idle days",
    );
  });
});
