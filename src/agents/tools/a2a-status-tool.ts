import { Type } from "@sinclair/typebox";
/**
 * a2a_status — agent introspection into the A2A subsystem.
 *
 * Read-only snapshot of inbound tasks (who's paying us, what's running),
 * outbound spend (our daily/per-task caps), earnings + revenue payouts,
 * and (when ERC-8004 is configured) live reputation reads with TTL caching.
 *
 * Mirrors the network_status pattern: one tool, scope-faceted, cheap-by-default.
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../config/config.js";
import { ensureA2aSchema } from "../../gateway/a2a/task-store.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const A2A_STATUS_SCOPES = ["summary", "inbound", "outbound", "earnings", "peers", "all"] as const;

const A2aStatusSchema = Type.Object({
  scope: Type.Optional(stringEnum(A2A_STATUS_SCOPES)),
  /** Limit on rows returned in `recentTasks` / `recentPurchases`. Default 5, max 50. */
  recentLimit: Type.Optional(Type.Number()),
  /** Optional explicit ERC-8004 reputation lookup. Triggers a chain read (cached). */
  peerLookup: Type.Optional(
    Type.Object({
      erc8004TokenId: Type.String(),
      chain: Type.Optional(stringEnum(["base", "base-sepolia"])),
    }),
  ),
});

const CANONICAL_ERC8004_REPUTATION: Record<"base" | "base-sepolia", string> = {
  base: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  "base-sepolia": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
};

type ReputationCacheEntry = {
  count: number;
  averageScore: number;
  fetchedAt: number;
};
const reputationCache = new Map<string, ReputationCacheEntry>();

export function __resetA2aStatusCacheForTests(): void {
  reputationCache.clear();
}

export function createA2aStatusTool(): AnyAgentTool {
  return {
    label: "A2A status",
    name: "a2a_status",
    description:
      "Snapshot the A2A subsystem. Scope: summary (default — config + today's totals), " +
      "inbound (recent tasks + state breakdown), outbound (spend caps + recent purchases), " +
      "earnings (sales + pending revenue payouts), peers (live ERC-8004 reputation for active " +
      "buyers/sellers), all (everything). Optional peerLookup={erc8004TokenId,chain} fetches " +
      "reputation for a specific peer. ERC-8004 reads are TTL-cached (a2a.erc8004.cacheTtlMs).",
    parameters: A2aStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const scope =
        (readStringParam(params, "scope") as (typeof A2A_STATUS_SCOPES)[number] | undefined) ??
        "summary";
      const recentLimit = clampRecentLimit(params.recentLimit);
      const peerLookupRaw = params.peerLookup;
      const peerLookup =
        peerLookupRaw && typeof peerLookupRaw === "object" && peerLookupRaw !== null
          ? (peerLookupRaw as { erc8004TokenId?: string; chain?: "base" | "base-sepolia" })
          : undefined;

      const cfg = loadConfig();
      const a2a = cfg.a2a ?? {};
      const enabled = a2a.enabled === true;

      // A2A is the agent's own subsystem; if it's off, a status call should
      // still tell the agent the truth so the user can act on it.
      if (!enabled) {
        return jsonResult({
          ok: true,
          enabled: false,
          hints: [
            "A2A is disabled. Set `a2a.enabled` to true to accept inbound tasks and publish an Agent Card.",
          ],
        });
      }

      let tasksDb: DatabaseSync | null = null;
      try {
        tasksDb = openA2aTasksDb();
        const marketplace = await loadMarketplace(cfg);

        const result: Record<string, unknown> = {
          ok: true,
          enabled: true,
          agentCardUrl: buildAgentCardUrl(cfg),
        };

        if (scope === "summary" || scope === "all") {
          result.config = buildConfigSnapshot(a2a);
        }

        if (scope === "summary" || scope === "inbound" || scope === "all") {
          result.inbound = buildInboundSnapshot(tasksDb, recentLimit);
        }

        if (scope === "summary" || scope === "outbound" || scope === "all") {
          result.outbound = buildOutboundSnapshot(marketplace, a2a, recentLimit);
        }

        if (scope === "summary" || scope === "earnings" || scope === "all") {
          result.earnings = buildEarningsSnapshot(marketplace);
        }

        // Identity (own reputation) is fetched on summary/all when configured —
        // most actionable single fact for the agent to surface.
        if (
          (scope === "summary" || scope === "all" || scope === "peers") &&
          a2a.erc8004?.enabled &&
          a2a.erc8004.tokenId
        ) {
          const chain = a2a.erc8004.chain ?? "base";
          const ttlMs = a2a.erc8004.cacheTtlMs ?? 5 * 60 * 1000;
          result.identity = {
            tokenId: a2a.erc8004.tokenId,
            registry: a2a.erc8004.registry ?? CANONICAL_ERC8004_REPUTATION[chain],
            chain,
            reputation: await fetchReputationCached(a2a.erc8004.tokenId, chain, ttlMs),
          };
        }

        // Peer reputation lookups: explicit peerLookup, or scope=peers/all
        // walks active recent purchases and resolves any embedded tokenIds.
        if (peerLookup?.erc8004TokenId) {
          const chain = peerLookup.chain ?? a2a.erc8004?.chain ?? "base";
          const ttlMs = a2a.erc8004?.cacheTtlMs ?? 5 * 60 * 1000;
          result.peerReputation = [
            {
              tokenId: peerLookup.erc8004TokenId,
              chain,
              ...(await fetchReputationCached(peerLookup.erc8004TokenId, chain, ttlMs)),
            },
          ];
        }

        result.hints = buildHints(a2a, result);

        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: `a2a_status failed: ${message}` });
      } finally {
        // Release the SQLite handle so the file isn't held open after the
        // tool returns — Windows refuses to unlink open DB files.
        try {
          tasksDb?.close();
        } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function buildConfigSnapshot(a2a: NonNullable<ReturnType<typeof loadConfig>["a2a"]>) {
  return {
    paymentEnabled: a2a.payment?.enabled === true,
    paymentAddress: a2a.payment?.x402?.address,
    minPaymentUsdc: a2a.payment?.x402?.minPayment,
    bearerAuth: (a2a.authentication?.type ?? "bearer") === "bearer",
    skillsExposed: a2a.skills?.expose ?? "all",
    erc8004Enabled: a2a.erc8004?.enabled === true,
  };
}

function buildInboundSnapshot(db: DatabaseSync, recentLimit: number) {
  const sinceMidnight = startOfTodayMs();
  const total = (db.prepare(`SELECT COUNT(*) as c FROM a2a_tasks`).get() as { c: number }).c;
  const today = (
    db.prepare(`SELECT COUNT(*) as c FROM a2a_tasks WHERE created_at >= ?`).get(sinceMidnight) as {
      c: number;
    }
  ).c;
  const byState = db
    .prepare(`SELECT status, COUNT(*) as c FROM a2a_tasks GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const recent = db
    .prepare(
      `SELECT id, status, context_id, created_at, updated_at
       FROM a2a_tasks ORDER BY created_at DESC LIMIT ?`,
    )
    .all(recentLimit) as Array<{
    id: string;
    status: string;
    context_id: string | null;
    created_at: number;
    updated_at: number;
  }>;
  return {
    tasksTotal: total,
    tasksToday: today,
    tasksByState: Object.fromEntries(byState.map((r) => [r.status, r.c])),
    recentTasks: recent.map((r) => ({
      id: r.id,
      state: r.status,
      contextId: r.context_id ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
  };
}

function buildOutboundSnapshot(
  marketplace: { db: DatabaseSync } | null,
  a2a: NonNullable<ReturnType<typeof loadConfig>["a2a"]>,
  recentLimit: number,
) {
  const dailyCap = a2a.marketplace?.client?.dailySpendLimitUsdc ?? 2.0;
  const perTaskCap = a2a.marketplace?.client?.maxTaskCostUsdc ?? 0.5;
  if (!marketplace) {
    return {
      purchasesTotal: 0,
      purchasesToday: 0,
      spentUsdcToday: 0,
      dailyLimitUsdc: dailyCap,
      perTaskLimitUsdc: perTaskCap,
      remainingUsdcToday: dailyCap,
      recentPurchases: [],
    };
  }
  const sinceMidnight = startOfTodayMs();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const totalsRow = marketplace.db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc), 0) as total
       FROM marketplace_purchases WHERE direction = 'purchase'`,
    )
    .get() as { c: number; total: number };
  const todayRow = marketplace.db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc), 0) as total
       FROM marketplace_purchases WHERE direction = 'purchase' AND purchased_at >= ?`,
    )
    .get(sinceMidnight) as { c: number; total: number };
  const rollingRow = marketplace.db
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) as total
       FROM marketplace_purchases WHERE direction = 'purchase' AND purchased_at >= ?`,
    )
    .get(oneDayAgo) as { total: number };
  const recent = marketplace.db
    .prepare(
      `SELECT skill_crystal_id, amount_usdc, buyer_peer_id, tx_hash, purchased_at
       FROM marketplace_purchases WHERE direction = 'purchase'
       ORDER BY purchased_at DESC LIMIT ?`,
    )
    .all(recentLimit) as Array<{
    skill_crystal_id: string;
    amount_usdc: number;
    buyer_peer_id: string;
    tx_hash: string;
    purchased_at: number;
  }>;
  const remaining = Math.max(0, dailyCap - rollingRow.total);
  return {
    purchasesTotal: totalsRow.c,
    purchasesToday: todayRow.c,
    spentUsdcToday: round6(todayRow.total),
    spentUsdcRolling24h: round6(rollingRow.total),
    dailyLimitUsdc: dailyCap,
    perTaskLimitUsdc: perTaskCap,
    remainingUsdcToday: round6(remaining),
    recentPurchases: recent.map((r) => ({
      skillId: r.skill_crystal_id,
      amountUsdc: r.amount_usdc,
      peerId: r.buyer_peer_id,
      txHash: r.tx_hash,
      purchasedAt: new Date(r.purchased_at).toISOString(),
    })),
  };
}

function buildEarningsSnapshot(
  marketplace: { db: DatabaseSync; getQueueStats?: () => unknown } | null,
) {
  if (!marketplace) {
    return {
      salesTotal: 0,
      salesToday: 0,
      earnedUsdcToday: 0,
      earnedUsdcAllTime: 0,
      pendingRevenueShares: 0,
      pendingPayoutsUsdc: 0,
    };
  }
  const sinceMidnight = startOfTodayMs();
  const totalsRow = marketplace.db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc), 0) as total
       FROM marketplace_purchases WHERE direction = 'sale'`,
    )
    .get() as { c: number; total: number };
  const todayRow = marketplace.db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc), 0) as total
       FROM marketplace_purchases WHERE direction = 'sale' AND purchased_at >= ?`,
    )
    .get(sinceMidnight) as { c: number; total: number };
  // Pending payouts: revenue_payment_queue may not exist on older installs.
  let pendingShares = 0;
  let pendingPayoutsUsdc = 0;
  let nextPayoutAt: string | undefined;
  try {
    const queueRow = marketplace.db
      .prepare(
        `SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc), 0) as total, MIN(release_after) as next
         FROM revenue_payment_queue WHERE status = 'held'`,
      )
      .get() as { c: number; total: number; next: number | null };
    pendingShares = queueRow.c;
    pendingPayoutsUsdc = round6(queueRow.total);
    if (queueRow.next) {
      nextPayoutAt = new Date(queueRow.next).toISOString();
    }
  } catch {
    /* table not present on this install */
  }
  return {
    salesTotal: totalsRow.c,
    salesToday: todayRow.c,
    earnedUsdcToday: round6(todayRow.total),
    earnedUsdcAllTime: round6(totalsRow.total),
    pendingRevenueShares: pendingShares,
    pendingPayoutsUsdc,
    ...(nextPayoutAt ? { nextPayoutAt } : {}),
  };
}

function buildHints(
  a2a: NonNullable<ReturnType<typeof loadConfig>["a2a"]>,
  result: Record<string, unknown>,
): string[] {
  const hints: string[] = [];
  if (a2a.payment?.enabled !== true) {
    hints.push(
      "Payment gate is off — set a2a.payment.enabled and a2a.payment.x402.address to start charging.",
    );
  } else if (!a2a.payment.x402?.address) {
    hints.push(
      "a2a.payment.enabled is true but no x402.address is set — payment requests will fail.",
    );
  }
  const out = result.outbound as
    | { remainingUsdcToday?: number; dailyLimitUsdc?: number }
    | undefined;
  if (
    out &&
    out.dailyLimitUsdc &&
    out.remainingUsdcToday !== undefined &&
    out.remainingUsdcToday <= 0
  ) {
    hints.push(
      "Daily outbound spend cap reached — increase a2a.marketplace.client.dailySpendLimitUsdc to unblock.",
    );
  }
  const earnings = result.earnings as
    | { pendingPayoutsUsdc?: number; nextPayoutAt?: string }
    | undefined;
  if (earnings && earnings.pendingPayoutsUsdc && earnings.pendingPayoutsUsdc > 0) {
    hints.push(
      `Pending revenue payouts: $${earnings.pendingPayoutsUsdc.toFixed(2)} held for the 48h dispute window.`,
    );
  }
  if (a2a.erc8004?.enabled && !a2a.erc8004.tokenId) {
    hints.push(
      "ERC-8004 is enabled but no tokenId is set — register on the Identity Registry to advertise reputation.",
    );
  }
  return hints;
}

// ---------------------------------------------------------------------------
// ERC-8004 reputation lookup with TTL cache
// ---------------------------------------------------------------------------

async function fetchReputationCached(
  tokenId: string,
  chain: "base" | "base-sepolia",
  ttlMs: number,
): Promise<{ count: number; averageScore: number; cached: boolean }> {
  const key = `${chain}:${tokenId}`;
  const now = Date.now();
  const cached = reputationCache.get(key);
  if (cached && now - cached.fetchedAt < ttlMs) {
    return { count: cached.count, averageScore: cached.averageScore, cached: true };
  }
  try {
    const { AgentIdentityService } = await import("../../services/erc8004-identity.js");
    const svc = new AgentIdentityService({ network: chain, agentCardUrl: "" });
    const summary = await svc.getReputation(BigInt(tokenId));
    const entry: ReputationCacheEntry = {
      count: summary.count,
      averageScore: summary.averageScore,
      fetchedAt: now,
    };
    reputationCache.set(key, entry);
    return { count: entry.count, averageScore: entry.averageScore, cached: false };
  } catch {
    return { count: 0, averageScore: 0, cached: false };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampRecentLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(50, Math.floor(raw)));
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function buildAgentCardUrl(cfg: ReturnType<typeof loadConfig>): string {
  const explicit = cfg.a2a?.url;
  if (explicit) return `${explicit.replace(/\/+$/, "")}/.well-known/agent.json`;
  const port = cfg.gateway?.port ?? 19001;
  return `http://127.0.0.1:${port}/.well-known/agent.json`;
}

function openA2aTasksDb(): DatabaseSync {
  const stateDir = process.env.BITTERBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".bitterbot");
  const dbDir = path.join(stateDir, "a2a");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "tasks.db"));
  db.exec("PRAGMA journal_mode = WAL");
  // Idempotent — guards against status being called before any task has landed.
  ensureA2aSchema(db);
  return db;
}

async function loadMarketplace(
  cfg: ReturnType<typeof loadConfig>,
): Promise<{ db: DatabaseSync } | null> {
  try {
    const { MemoryIndexManager } = await import("../../memory/manager.js");
    const memManager = await MemoryIndexManager.get({
      cfg,
      agentId: "default",
      purpose: "status",
    });
    const economics = memManager?.getMarketplaceEconomics?.();
    if (!economics) return null;
    const db = (economics as { getDb?: () => DatabaseSync | undefined }).getDb?.();
    if (!db) return null;
    return { db };
  } catch {
    return null;
  }
}
