import type { DatabaseSync } from "node:sqlite";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

/* ------------------------------------------------------------------ */
/*  Narrow interface for the MemoryIndexManager properties we access  */
/* ------------------------------------------------------------------ */

interface HormonalManagerView {
  getState(): { dopamine: number; cortisol: number; oxytocin: number };
  emotionalTrajectory?(): {
    trend: "improving" | "declining" | "stable" | "volatile";
    dominantChannel: "dopamine" | "cortisol" | "oxytocin" | "balanced";
    volatility: number;
    recentShift: string;
  } | null;
  emotionalBriefing?(): string;
}

interface CuriosityEngineView {
  getGCCRFSummary?(): {
    alpha: number | null;
    maturity: number | null;
    regionProgress: Array<{ regionId: string; label: string; deltaEta: number; eta: number }>;
  };
}

interface GccrfDiagnosticsResult {
  alpha: number;
  maturity: number;
  state: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface CuriosityTarget {
  description: string;
  priority: number;
  type: string;
}

interface SkillMarketplaceView {
  search(
    query: string,
    opts: { category?: string; tags?: string[]; sort?: string; limit?: number },
  ): unknown[];
  getTrending(limit: number): unknown[];
  getRecommendations(limit: number): unknown[];
  getSkillDetail(stableSkillId: string): unknown;
}

interface MarketplaceEconomicsView {
  getEconomicSummary(): unknown;
  getListableSkills(): unknown[];
}

/** Properties of MemoryIndexManager that dream handlers access beyond MemorySearchManager. */
interface DreamManagerView {
  db?: DatabaseSync;
  cfg?: { memory?: { dream?: { intervalMinutes?: number } } };
  hormonalManager?: HormonalManagerView | null;
  curiosityEngine?: CuriosityEngineView | null;
  dream?(): Promise<{
    cycle?: { cycleId?: string };
    newInsights?: unknown[];
  } | null>;
  suggestSkills?(): Promise<unknown[]>;
  gccrfDiagnostics?(): GccrfDiagnosticsResult | null;
  curiosityState?(): { targets?: CuriosityTarget[] } | null;
  getSkillMarketplace?(): SkillMarketplaceView | null;
  getMarketplaceEconomics?(): MarketplaceEconomicsView | null;
}

/* ------------------------------------------------------------------ */
/*  Row types for SQLite query results                                 */
/* ------------------------------------------------------------------ */

type CountRow = { c: number };

type DreamCycleRow = {
  cycle_id: string;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  modes_used: string | null;
  insights_generated: number;
  chunks_analyzed: number;
  llm_calls_used: number;
  error: string | null;
};

type DreamInsightRow = {
  id: string;
  content: string;
  confidence: number;
  mode: string;
  importance_score: number | null;
  created_at: number;
};

type DreamAnalyticsSummaryRow = {
  total: number;
  totalDuration: number | null;
  avgDuration: number | null;
  totalChunks: number | null;
  totalInsights: number | null;
  totalLlmCalls: number | null;
};

type ModesUsedRow = { modes_used: string };

type StartedAtRow = { started_at: number };

type DailyTrendRow = { started_at: number; insights_generated: number };

type RewardStatsRow = {
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
};

function describeMood(s: { dopamine: number; cortisol: number; oxytocin: number }): string {
  const p: string[] = [];
  if (s.dopamine > 0.6) {
    p.push("energized");
  } else if (s.dopamine > 0.3) {
    p.push("motivated");
  }
  if (s.cortisol > 0.6) {
    p.push("stressed");
  } else if (s.cortisol > 0.3) {
    p.push("alert");
  }
  if (s.oxytocin > 0.6) {
    p.push("deeply connected");
  } else if (s.oxytocin > 0.3) {
    p.push("socially engaged");
  }
  if (p.length === 0) {
    return s.dopamine < 0.1 && s.cortisol < 0.1 && s.oxytocin < 0.1 ? "dormant" : "calm";
  }
  return p.join(", ");
}

async function getManager() {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager, error } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) {
    throw new Error(error ?? "memory manager unavailable");
  }
  return manager;
}

export const dreamHandlers: GatewayRequestHandlers = {
  "dream.status": async ({ respond }) => {
    try {
      const manager = await getManager();
      const mgr = manager as unknown as DreamManagerView;
      const status = manager.dreamStatus?.();
      const hormones = mgr.hormonalManager?.getState() ?? null;
      const dreamCfg = mgr.cfg?.memory?.dream;
      const intervalMs = (dreamCfg?.intervalMinutes ?? 120) * 60 * 1000;
      const lastCycle = status?.lastCycle as { completedAt?: number } | undefined;
      const lastCycleAt = lastCycle?.completedAt ?? null;
      const nextDreamEta = lastCycleAt ? lastCycleAt + intervalMs : null;
      respond(true, {
        ...status,
        nextDreamEta,
        hormones: hormones
          ? {
              dopamine: hormones.dopamine,
              cortisol: hormones.cortisol,
              oxytocin: hormones.oxytocin,
            }
          : null,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.history": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const db = (manager as unknown as DreamManagerView).db;
      if (!db) {
        respond(true, { total: 0, cycles: [] });
        return;
      }
      const limit = Math.min(Number(params.limit) || 10, 50);
      const offset = Number(params.offset) || 0;
      const total =
        (db.prepare("SELECT COUNT(*) as c FROM dream_cycles").get() as CountRow | undefined)?.c ??
        0;
      const cycles = db
        .prepare(
          `SELECT cycle_id, started_at, completed_at, duration_ms, modes_used,
                insights_generated, chunks_analyzed, llm_calls_used, error
         FROM dream_cycles ORDER BY started_at DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as DreamCycleRow[];

      const insightStmt = db.prepare(
        `SELECT id, content, confidence, mode, importance_score, created_at
         FROM dream_insights WHERE dream_cycle_id = ? ORDER BY confidence DESC LIMIT 10`,
      );

      const result = cycles.map((c: DreamCycleRow) => {
        const insights = insightStmt.all(c.cycle_id) as DreamInsightRow[];
        return {
          cycleId: c.cycle_id,
          startedAt: c.started_at,
          completedAt: c.completed_at,
          durationMs: c.duration_ms,
          modesUsed: c.modes_used ? JSON.parse(c.modes_used) : [],
          insightsGenerated: c.insights_generated,
          chunksAnalyzed: c.chunks_analyzed,
          llmCallsUsed: c.llm_calls_used,
          error: c.error,
          insights: insights.map((i: DreamInsightRow) => ({
            id: i.id,
            content: i.content,
            confidence: i.confidence,
            mode: i.mode,
            importanceScore: i.importance_score,
            createdAt: i.created_at,
          })),
        };
      });
      respond(true, { total, cycles: result });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.insights": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const db = (manager as unknown as DreamManagerView).db;
      if (!db) {
        respond(true, { total: 0, insights: [] });
        return;
      }
      const limit = Math.min(Number(params.limit) || 20, 100);
      const mode = typeof params.mode === "string" ? params.mode : null;
      const minConf = Number(params.minConfidence) || 0;
      let sql = `SELECT id, content, confidence, mode, importance_score, created_at
                 FROM dream_insights WHERE confidence >= ?`;
      const args: (string | number)[] = [minConf];
      if (mode) {
        sql += " AND mode = ?";
        args.push(mode);
      }
      sql += " ORDER BY created_at DESC LIMIT ?";
      args.push(limit);
      const total =
        (db.prepare("SELECT COUNT(*) as c FROM dream_insights").get() as CountRow | undefined)?.c ??
        0;
      const rows = db.prepare(sql).all(...args) as DreamInsightRow[];
      respond(true, {
        total,
        insights: rows.map((r: DreamInsightRow) => ({
          id: r.id,
          content: r.content,
          confidence: r.confidence,
          mode: r.mode,
          importanceScore: r.importance_score,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.trigger": async ({ respond }) => {
    try {
      const manager = await getManager();
      const mgr = manager as unknown as DreamManagerView;
      if (typeof mgr.dream !== "function") {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "dream engine not available"));
        return;
      }
      const stats = await mgr.dream();
      respond(true, {
        success: true,
        cycleId: stats?.cycle?.cycleId ?? null,
        insightsGenerated: stats?.newInsights?.length ?? 0,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.emotional": async ({ respond }) => {
    try {
      const manager = await getManager();
      const hm = (manager as unknown as DreamManagerView).hormonalManager;
      if (!hm) {
        respond(true, { hormones: null });
        return;
      }
      const state = hm.getState();
      const trajectory = hm.emotionalTrajectory?.() ?? null;
      const briefing = hm.emotionalBriefing?.() ?? "";
      respond(true, {
        dopamine: state.dopamine,
        cortisol: state.cortisol,
        oxytocin: state.oxytocin,
        mood: describeMood(state),
        trajectory,
        emotionalBriefing: briefing,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.analytics": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const db = (manager as unknown as DreamManagerView).db;
      if (!db) {
        respond(true, { totalCycles: 0 });
        return;
      }
      const days = Math.min(Number(params.days) || 30, 365);
      const since = Date.now() - days * 86400000;

      const summary = db
        .prepare(
          `SELECT COUNT(*) as total, SUM(duration_ms) as totalDuration,
                AVG(duration_ms) as avgDuration, SUM(chunks_analyzed) as totalChunks,
                SUM(insights_generated) as totalInsights, SUM(llm_calls_used) as totalLlmCalls
         FROM dream_cycles WHERE started_at >= ?`,
        )
        .get(since) as DreamAnalyticsSummaryRow | undefined;

      // Mode frequency
      const modeRows = db
        .prepare(
          `SELECT modes_used FROM dream_cycles WHERE started_at >= ? AND modes_used IS NOT NULL`,
        )
        .all(since) as ModesUsedRow[];
      const modeFreq: Record<string, number> = {};
      for (const row of modeRows) {
        try {
          const modes = JSON.parse(row.modes_used) as string[];
          for (const m of modes) {
            modeFreq[m] = (modeFreq[m] ?? 0) + 1;
          }
        } catch {
          /* skip */
        }
      }

      // Time-of-day pattern (hour buckets)
      const hourRows = db
        .prepare(`SELECT started_at FROM dream_cycles WHERE started_at >= ?`)
        .all(since) as StartedAtRow[];
      const hourBuckets = Array.from<number>({ length: 24 }).fill(0);
      for (const row of hourRows) {
        const hour = new Date(row.started_at).getHours();
        hourBuckets[hour]++;
      }

      // Daily trend
      const dailyRows = db
        .prepare(
          `SELECT started_at, insights_generated FROM dream_cycles
         WHERE started_at >= ? ORDER BY started_at ASC`,
        )
        .all(since) as DailyTrendRow[];
      const dailyMap = new Map<string, { cycles: number; insights: number }>();
      for (const row of dailyRows) {
        const day = new Date(row.started_at).toISOString().slice(0, 10);
        const entry = dailyMap.get(day) ?? { cycles: 0, insights: 0 };
        entry.cycles++;
        entry.insights += row.insights_generated ?? 0;
        dailyMap.set(day, entry);
      }

      respond(true, {
        totalCycles: summary?.total ?? 0,
        totalDurationMs: summary?.totalDuration ?? 0,
        avgDurationMs: Math.round(summary?.avgDuration ?? 0),
        totalChunksAnalyzed: summary?.totalChunks ?? 0,
        totalInsights: summary?.totalInsights ?? 0,
        totalLlmCalls: summary?.totalLlmCalls ?? 0,
        modeFrequency: modeFreq,
        hourBuckets,
        dailyTrend: Array.from(dailyMap.entries()).map(([day, v]) => ({ day, ...v })),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.curiosityReward": async ({ respond }) => {
    try {
      const manager = await getManager();
      const mgr = manager as unknown as DreamManagerView;
      const gccrf = mgr.gccrfDiagnostics?.() ?? null;
      const curiosityState = mgr.curiosityState?.() ?? null;

      if (!gccrf) {
        respond(true, { enabled: false });
        return;
      }

      // Get recent reward statistics from chunks
      const db = mgr.db;
      let rewardStats = { avg: 0, min: 0, max: 0, count: 0 };
      let rewardHistory: Array<{ reward: number; timestamp: number }> = [];
      if (db) {
        try {
          const stats = db
            .prepare(
              `SELECT AVG(curiosity_reward) as avg, MIN(curiosity_reward) as min,
                    MAX(curiosity_reward) as max, COUNT(*) as count
             FROM chunks WHERE curiosity_reward IS NOT NULL`,
            )
            .get() as RewardStatsRow | undefined;
          rewardStats = {
            avg: stats?.avg ?? 0,
            min: stats?.min ?? 0,
            max: stats?.max ?? 0,
            count: stats?.count ?? 0,
          };

          // Recent reward values for history chart (last 50 scored chunks)
          const recent = db
            .prepare(
              `SELECT curiosity_reward as reward, updated_at as timestamp
             FROM chunks WHERE curiosity_reward IS NOT NULL
             ORDER BY updated_at DESC LIMIT 50`,
            )
            .all() as Array<{ reward: number; timestamp: number }>;
          rewardHistory = recent.toReversed();
        } catch {
          /* columns may not exist */
        }
      }

      // Get region progress from curiosity engine
      const curiosityEngine = mgr.curiosityEngine;
      const gccrfSummary = curiosityEngine?.getGCCRFSummary?.() ?? {
        alpha: null,
        maturity: null,
        regionProgress: [],
      };

      // Get top strategic targets
      const topTargets = (curiosityState?.targets ?? []).slice(0, 5).map((t: CuriosityTarget) => ({
        description: t.description,
        priority: t.priority,
        type: t.type,
      }));

      const gccrfConfig = gccrf.config as {
        alphaStart?: number;
        alphaEnd?: number;
        expectedMatureCycles?: number;
        weights?: Record<string, number>;
      };
      respond(true, {
        enabled: true,
        alpha: gccrf.alpha,
        maturity: gccrf.maturity,
        components: gccrf.state?.normalizers ?? {},
        rewardStats,
        rewardHistory,
        regionProgress: gccrfSummary.regionProgress,
        topTargets,
        config: {
          alphaStart: gccrfConfig.alphaStart,
          alphaEnd: gccrfConfig.alphaEnd,
          expectedMatureCycles: gccrfConfig.expectedMatureCycles,
          weights: gccrfConfig.weights,
        },
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.journal": async ({ params, respond }) => {
    try {
      const cfg = loadConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const { resolveAgentWorkspaceDir } = await import("../../agents/agent-scope.js");
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const { default: fs } = await import("node:fs/promises");
      const { default: path } = await import("node:path");
      const journalPath = path.join(workspaceDir, "memory", "dream-journal.md");
      let content: string;
      try {
        content = await fs.readFile(journalPath, "utf-8");
      } catch {
        content = "";
      }
      const limit = Math.min(Number(params.limit) || 10, 50);
      // Split on ## Dream Cycle headers
      const entries = content
        .split(/\n(?=## Dream Cycle)/)
        .filter((e) => e.trim().startsWith("## Dream Cycle"));
      const recent = entries.slice(-limit).toReversed();
      respond(true, { entries: recent.map((e) => ({ content: e.trim() })) });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.suggestSkills": async ({ respond }) => {
    try {
      const manager = await getManager();
      const suggestions = await (manager as unknown as DreamManagerView).suggestSkills?.();
      respond(true, { suggestions: suggestions ?? [] });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  // Plan 8, Phase 2: Marketplace search/browse via gateway RPC
  "marketplace.search": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const marketplace = (manager as unknown as DreamManagerView).getSkillMarketplace?.();
      if (!marketplace) {
        respond(true, []);
        return;
      }
      const results = marketplace.search(String((params.query as string) ?? ""), {
        category: params.category as string | undefined,
        tags: params.tags as string[] | undefined,
        sort: String((params.sort as string) ?? "relevance"),
        limit: Math.min(Number(params.limit) || 20, 50),
      });
      respond(true, results);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "marketplace.trending": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const marketplace = (manager as unknown as DreamManagerView).getSkillMarketplace?.();
      if (!marketplace) {
        respond(true, []);
        return;
      }
      respond(true, marketplace.getTrending(Number(params.limit) || 10));
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "marketplace.recommendations": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const marketplace = (manager as unknown as DreamManagerView).getSkillMarketplace?.();
      if (!marketplace) {
        respond(true, []);
        return;
      }
      respond(true, marketplace.getRecommendations(Number(params.limit) || 10));
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "marketplace.detail": async ({ params, respond }) => {
    try {
      const manager = await getManager();
      const marketplace = (manager as unknown as DreamManagerView).getSkillMarketplace?.();
      if (!marketplace) {
        respond(true, null);
        return;
      }
      respond(true, marketplace.getSkillDetail(String(params.stableSkillId)));
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "dream.marketplaceStatus": async ({ respond }) => {
    try {
      const manager = await getManager();
      const marketplace = (manager as unknown as DreamManagerView).getMarketplaceEconomics?.();
      if (!marketplace) {
        respond(true, { enabled: false, message: "Marketplace not initialized" });
        return;
      }
      const summary = marketplace.getEconomicSummary();
      const listings = marketplace.getListableSkills();
      respond(true, { enabled: true, summary, listings });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
