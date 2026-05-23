/**
 * PLAN-20: gateway RPC method `guards.status` — returns currently
 * registered pre-action interceptors, their aggregated stats from the
 * `intervention_records` table (via the v14 `skill_interceptor_stats`
 * view), and the most recent persisted records.
 *
 * Available under operator.read scope. Read-only — never mutates.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { ensureInterceptorsAutoBoot } from "../../agents/skills/interceptor-autoboot.js";
import { getInterceptorRegistry } from "../../agents/skills/interceptor-registry.js";
import { loadConfig } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveUserPath } from "../../utils.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface InterceptorStatsRow {
  skill: string;
  interceptor_id: string;
  fire_count: number;
  success_count: number;
  failure_count: number;
  user_confirmed_count: number;
  user_override_count: number;
  avg_latency_ms: number | null;
  first_seen_ts: number | null;
  last_seen_ts: number | null;
}

interface RecentRow {
  record_json: string;
}

function resolveDbPath(): string | null {
  try {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    if (!agentId) return null;
    const defaults = cfg.agents?.defaults?.memorySearch;
    const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
    const raw = overrides?.store?.path ?? defaults?.store?.path;
    if (raw) {
      const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
      return resolveUserPath(withToken);
    }
    const stateDir = resolveStateDir(process.env, os.homedir);
    return path.join(stateDir, "memory", `${agentId}.sqlite`);
  } catch {
    return null;
  }
}

export const guardsHandlers: GatewayRequestHandlers = {
  "guards.status": async ({ respond }) => {
    // Ensure builtins are registered. Idempotent.
    try {
      ensureInterceptorsAutoBoot();
    } catch {
      // Continue — registry may still have entries from a prior session.
    }

    const registry = getInterceptorRegistry();
    const registered = registry.list().map((e) => ({
      id: e.interceptor.id,
      skill: e.interceptor.skill,
      origin: e.origin,
      priority: e.interceptor.priority ?? 0,
    }));

    const dbPath = resolveDbPath();
    if (!dbPath || !fs.existsSync(dbPath)) {
      respond(true, { ok: true, registered, stats: [], recent: [] });
      return;
    }

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec(`PRAGMA query_only=ON;`);

      let stats: InterceptorStatsRow[] = [];
      try {
        stats = db
          .prepare(
            `SELECT skill, interceptor_id, fire_count, success_count, failure_count,
                    user_confirmed_count, user_override_count, avg_latency_ms,
                    first_seen_ts, last_seen_ts
               FROM skill_interceptor_stats`,
          )
          .all() as unknown as InterceptorStatsRow[];
      } catch {
        // View may not exist yet — migration v14 hasn't run on this DB.
        stats = [];
      }

      let recentRows: RecentRow[] = [];
      try {
        recentRows = db
          .prepare(`SELECT record_json FROM intervention_records ORDER BY ts DESC LIMIT 25`)
          .all() as unknown as RecentRow[];
      } catch {
        recentRows = [];
      }

      const recent = recentRows
        .map((r) => {
          try {
            const parsed = JSON.parse(r.record_json) as Record<string, unknown>;
            const action = parsed.actionOriginal as { toolName?: unknown } | undefined;
            const meta = parsed.metadata as
              | { activationLatencyMs?: unknown; interventionLatencyMs?: unknown }
              | undefined;
            return {
              id: asStr(parsed.id),
              ts: asNum(parsed.ts),
              sessionKey: asStr(parsed.sessionKey),
              skill: asStr(parsed.skill),
              interceptorId: asStr(parsed.interceptorId),
              toolName: asStr(action?.toolName),
              intervention: parsed.intervention ?? { type: "noop" },
              latencyMs: asNum(meta?.activationLatencyMs) + asNum(meta?.interventionLatencyMs),
            };
          } catch {
            return null;
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      respond(true, {
        ok: true,
        registered,
        stats: stats.map((s) => ({
          skill: s.skill,
          interceptorId: s.interceptor_id,
          fireCount: s.fire_count,
          successCount: s.success_count,
          failureCount: s.failure_count,
          userConfirmedCount: s.user_confirmed_count,
          userOverrideCount: s.user_override_count,
          avgLatencyMs: s.avg_latency_ms ?? 0,
          firstSeenTs: s.first_seen_ts ?? 0,
          lastSeenTs: s.last_seen_ts ?? 0,
        })),
        recent,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    } finally {
      try {
        db?.close();
      } catch {
        // best-effort
      }
    }
  },
};
