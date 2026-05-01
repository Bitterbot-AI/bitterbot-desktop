import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock loadConfig before importing the tool — the module reads config eagerly
// at execute() time, so we need a controlled fixture.
let currentConfig: Record<string, unknown> = {};
vi.mock("../../config/config.js", () => ({
  loadConfig: () => currentConfig,
}));

// Mock the marketplace memory module — most of these tests don't need a real
// marketplace; the few that do swap in a real DatabaseSync per-test.
vi.mock("../../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: async () => ({
      getMarketplaceEconomics: () => mockedMarketplace,
    }),
  },
}));

let mockedMarketplace: { getDb: () => unknown } | null = null;

// Mock viem so we don't hit the chain in `peers` scope tests.
vi.mock("viem", () => ({
  createPublicClient: () => ({
    readContract: async () => [BigInt(7), BigInt(85), 2],
  }),
  http: () => ({}),
  recoverMessageAddress: async () => "0x" + "a".repeat(40),
}));
vi.mock("viem/chains", () => ({
  base: { id: 8453 },
  baseSepolia: { id: 84532 },
}));

import { DatabaseSync } from "node:sqlite";
import { ensureA2aSchema } from "../../gateway/a2a/task-store.js";
import { __resetA2aStatusCacheForTests, createA2aStatusTool } from "./a2a-status-tool.js";

let tmpDir: string;
const tool = createA2aStatusTool();

beforeEach(() => {
  __resetA2aStatusCacheForTests();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "a2a-status-test-"));
  process.env.BITTERBOT_STATE_DIR = tmpDir;
  mockedMarketplace = null;
  currentConfig = { a2a: { enabled: true } };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BITTERBOT_STATE_DIR;
});

async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool.execute!("call-1", args, undefined as never, undefined as never);
  // jsonResult returns { content: [{ type: "text", text: "<json>" }] }
  const content = (result as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(content);
}

function makeMarketplaceDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE marketplace_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_crystal_id TEXT NOT NULL,
      buyer_peer_id TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      tx_hash TEXT UNIQUE,
      direction TEXT NOT NULL,
      purchased_at INTEGER NOT NULL
    );
    CREATE TABLE revenue_payment_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_usdc REAL NOT NULL,
      status TEXT NOT NULL,
      release_after INTEGER
    );
  `);
  return db;
}

describe("a2a_status — disabled state", () => {
  it("returns enabled=false with a hint when a2a is disabled", async () => {
    currentConfig = { a2a: { enabled: false } };
    const r = await callTool({});
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(false);
    expect(Array.isArray(r.hints)).toBe(true);
    expect(String((r.hints as string[])[0])).toMatch(/disabled/i);
  });
});

describe("a2a_status — summary scope (default)", () => {
  it("returns config snapshot, inbound/outbound/earnings sections, no peer lookup", async () => {
    const r = await callTool({});
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.agentCardUrl).toContain("/.well-known/agent.json");
    expect(r.config).toBeDefined();
    expect(r.inbound).toBeDefined();
    expect(r.outbound).toBeDefined();
    expect(r.earnings).toBeDefined();
    expect(r.peerReputation).toBeUndefined();
  });

  it("warns when payment is enabled but no x402 address is set", async () => {
    currentConfig = {
      a2a: { enabled: true, payment: { enabled: true } },
    };
    const r = await callTool({ scope: "summary" });
    const hints = r.hints as string[];
    expect(hints.some((h) => /no x402.address/i.test(h))).toBe(true);
  });

  it("warns when payment is off (default)", async () => {
    const r = await callTool({});
    const hints = r.hints as string[];
    expect(hints.some((h) => /Payment gate is off/i.test(h))).toBe(true);
  });
});

describe("a2a_status — inbound scope", () => {
  it("counts tasks by state and returns recent rows", async () => {
    mkdirSync(path.join(tmpDir, "a2a"), { recursive: true });
    const realDbPath = path.join(tmpDir, "a2a", "tasks.db");
    const realDb = new DatabaseSync(realDbPath);
    ensureA2aSchema(realDb);
    const now = Date.now();
    realDb
      .prepare(`INSERT INTO a2a_tasks (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("t1", "completed", now - 1000, now - 500);
    realDb
      .prepare(`INSERT INTO a2a_tasks (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("t2", "working", now, now);
    realDb.close();

    const r = await callTool({ scope: "inbound" });
    const inb = r.inbound as {
      tasksTotal: number;
      tasksByState: Record<string, number>;
      recentTasks: Array<{ id: string; state: string }>;
    };
    expect(inb.tasksTotal).toBe(2);
    expect(inb.tasksByState.completed).toBe(1);
    expect(inb.tasksByState.working).toBe(1);
    expect(inb.recentTasks[0].id).toBe("t2");
  });
});

describe("a2a_status — outbound scope (spend caps + recent purchases)", () => {
  it("computes remainingUsdcToday against the rolling 24h window", async () => {
    const db = makeMarketplaceDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO marketplace_purchases (skill_crystal_id, buyer_peer_id, amount_usdc, tx_hash, direction, purchased_at)
       VALUES (?, ?, ?, ?, 'purchase', ?)`,
    ).run("skill-a", "peer-self", 0.4, "0xtx1", now - 1000);
    db.prepare(
      `INSERT INTO marketplace_purchases (skill_crystal_id, buyer_peer_id, amount_usdc, tx_hash, direction, purchased_at)
       VALUES (?, ?, ?, ?, 'purchase', ?)`,
    ).run("skill-b", "peer-self", 0.3, "0xtx2", now - 500);
    mockedMarketplace = { getDb: () => db };
    currentConfig = {
      a2a: {
        enabled: true,
        marketplace: { client: { dailySpendLimitUsdc: 1.0, maxTaskCostUsdc: 0.5 } },
      },
    };

    const r = await callTool({ scope: "outbound" });
    const out = r.outbound as {
      purchasesTotal: number;
      spentUsdcRolling24h: number;
      remainingUsdcToday: number;
      recentPurchases: Array<{ skillId: string }>;
    };
    expect(out.purchasesTotal).toBe(2);
    expect(out.spentUsdcRolling24h).toBeCloseTo(0.7, 6);
    expect(out.remainingUsdcToday).toBeCloseTo(0.3, 6);
    expect(out.recentPurchases[0].skillId).toBe("skill-b");
  });

  it("hint fires when daily cap is exhausted", async () => {
    const db = makeMarketplaceDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO marketplace_purchases (skill_crystal_id, buyer_peer_id, amount_usdc, tx_hash, direction, purchased_at)
       VALUES (?, ?, ?, ?, 'purchase', ?)`,
    ).run("s1", "p1", 2.0, "0xtx", now - 1000);
    mockedMarketplace = { getDb: () => db };
    currentConfig = {
      a2a: { enabled: true, marketplace: { client: { dailySpendLimitUsdc: 1.0 } } },
    };
    const r = await callTool({ scope: "outbound" });
    const hints = r.hints as string[];
    expect(hints.some((h) => /Daily outbound spend cap reached/i.test(h))).toBe(true);
  });
});

describe("a2a_status — earnings scope", () => {
  it("reports sales today + pending payouts from the revenue_payment_queue", async () => {
    const db = makeMarketplaceDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO marketplace_purchases (skill_crystal_id, buyer_peer_id, amount_usdc, tx_hash, direction, purchased_at)
       VALUES (?, ?, ?, ?, 'sale', ?)`,
    ).run("skill-x", "peer-other", 0.05, "0xa", now - 500);
    db.prepare(
      `INSERT INTO revenue_payment_queue (amount_usdc, status, release_after)
       VALUES (?, ?, ?)`,
    ).run(0.045, "held", now + 48 * 3600 * 1000);
    mockedMarketplace = { getDb: () => db };

    const r = await callTool({ scope: "earnings" });
    const e = r.earnings as {
      salesToday: number;
      earnedUsdcToday: number;
      pendingRevenueShares: number;
      pendingPayoutsUsdc: number;
      nextPayoutAt?: string;
    };
    expect(e.salesToday).toBe(1);
    expect(e.earnedUsdcToday).toBeCloseTo(0.05, 6);
    expect(e.pendingRevenueShares).toBe(1);
    expect(e.pendingPayoutsUsdc).toBeCloseTo(0.045, 6);
    expect(e.nextPayoutAt).toBeTruthy();

    const hints = r.hints as string[];
    expect(hints.some((h) => /Pending revenue payouts/i.test(h))).toBe(true);
  });
});

describe("a2a_status — peerLookup + ERC-8004 reputation cache", () => {
  it("explicit peerLookup returns mocked reputation and is cached on next call", async () => {
    const r1 = await callTool({
      scope: "summary",
      peerLookup: { erc8004TokenId: "42", chain: "base" },
    });
    const peers1 = r1.peerReputation as Array<{
      tokenId: string;
      count: number;
      averageScore: number;
      cached: boolean;
    }>;
    expect(peers1[0].tokenId).toBe("42");
    expect(peers1[0].count).toBe(7);
    expect(peers1[0].averageScore).toBeCloseTo(0.85, 6);
    expect(peers1[0].cached).toBe(false);

    const r2 = await callTool({
      scope: "summary",
      peerLookup: { erc8004TokenId: "42", chain: "base" },
    });
    const peers2 = r2.peerReputation as Array<{ cached: boolean }>;
    expect(peers2[0].cached).toBe(true);
  });

  it("ttl=0 forces every call to re-fetch (cache disabled)", async () => {
    currentConfig = {
      a2a: {
        enabled: true,
        erc8004: { enabled: true, tokenId: "1", chain: "base", cacheTtlMs: 0 },
      },
    };
    const r1 = await callTool({ scope: "summary" });
    const r2 = await callTool({ scope: "summary" });
    const id1 = (r1.identity as { reputation: { cached: boolean } }).reputation;
    const id2 = (r2.identity as { reputation: { cached: boolean } }).reputation;
    expect(id1.cached).toBe(false);
    expect(id2.cached).toBe(false);
  });

  it("own identity reputation is fetched on summary when erc8004 is configured", async () => {
    currentConfig = {
      a2a: {
        enabled: true,
        erc8004: { enabled: true, tokenId: "1", chain: "base-sepolia" },
      },
    };
    const r = await callTool({ scope: "summary" });
    const id = r.identity as { tokenId: string; chain: string; reputation: { count: number } };
    expect(id.tokenId).toBe("1");
    expect(id.chain).toBe("base-sepolia");
    expect(id.reputation.count).toBe(7);
  });
});

describe("a2a_status — recentLimit clamping", () => {
  it("clamps invalid recentLimit to default", async () => {
    const r = await callTool({ scope: "outbound", recentLimit: -5 });
    expect(r.ok).toBe(true);
  });
});
