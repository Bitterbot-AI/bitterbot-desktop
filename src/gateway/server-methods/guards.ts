/**
 * PLAN-20: gateway RPC methods for the Active Guards UI.
 *
 *  - `guards.status`     — read-only summary (operator.read).
 *      Returns registered interceptors, per-skill stats, recent records,
 *      and the list of dream-harvest candidates staged in skills-staging/.
 *
 *  - `guards.promote_candidate` — operator.admin.
 *      Move a staged candidate from skills-staging/<name> to skills/<name>.
 *      Reuses the existing SkillStorage pattern. The TS implementation
 *      stub still has to be added under builtin-interceptors/ before the
 *      skill becomes live; this method just promotes the markdown.
 *
 *  - `guards.clear_strikes` — operator.admin.
 *      Reset the persistent strike counter for an auto-disabled
 *      interceptor. Re-enables it for the next session.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { appendImpactEntry } from "../../agents/skills/impact-trail.js";
import { ensureInterceptorsAutoBoot } from "../../agents/skills/interceptor-autoboot.js";
import { getInterceptorRegistry } from "../../agents/skills/interceptor-registry.js";
import { formatGateSummary, runSkillGate } from "../../agents/skills/skill-gate.js";
import { promoteStaged } from "../../agents/skills/skill-promote.js";
import {
  liveSkillPath,
  readLive,
  readStaged,
  resolveStorageRoots,
  updateStagingGateStatus,
} from "../../agents/skills/skill-storage.js";
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

      // Read strikes table (best-effort; brand-new DB has no rows).
      let strikes: Array<{
        interceptorId: string;
        strikes: number;
        disabled: boolean;
        lastFailureTs: number | null;
        lastFailureReason: string | null;
      }> = [];
      try {
        const rows = db
          .prepare(
            `SELECT interceptor_id, strikes, disabled, last_failure_ts, last_failure_reason
               FROM interceptor_strikes WHERE strikes > 0
              ORDER BY interceptor_id`,
          )
          .all() as unknown as Array<{
          interceptor_id: string;
          strikes: number;
          disabled: number;
          last_failure_ts: number | null;
          last_failure_reason: string | null;
        }>;
        strikes = rows.map((r) => ({
          interceptorId: r.interceptor_id,
          strikes: r.strikes,
          disabled: r.disabled === 1,
          lastFailureTs: r.last_failure_ts,
          lastFailureReason: r.last_failure_reason,
        }));
      } catch {
        strikes = [];
      }

      const candidates = await listStagedHarvestCandidates();

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
        strikes,
        candidates,
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

  "guards.promote_candidate": async ({ params, respond }) => {
    const skill =
      params && typeof params === "object" ? (params as { skill?: unknown }).skill : undefined;
    if (typeof skill !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(skill)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "skill must be a valid kebab-case name"),
      );
      return;
    }
    try {
      // PLAN-42 Phase 0: promotion goes through the behavioural gate and the
      // shared storage module (which archives the previous live version)
      // instead of a raw staged→live copy. resolveStorageRoots() is the one
      // source of truth for staging paths — no more parallel resolveStateDir
      // construction that can drift from CONFIG_DIR.
      const roots = resolveStorageRoots();
      const staged = await readStaged(roots, skill);
      if (!staged) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `no staged candidate for "${skill}"`),
        );
        return;
      }
      // Dream-harvest candidates are staged without a gate pass; run it now.
      if (staged.meta.gateStatus !== "passed") {
        const liveContent = await readLive(roots, skill);
        const gate = runSkillGate({
          skillName: skill,
          stagedContent: staged.content,
          liveContent,
        });
        await updateStagingGateStatus(
          roots,
          skill,
          gate.outcome === "fail" ? "failed" : "passed",
          gate.outcome === "fail"
            ? gate.issues.find((i) => i.severity === "block")?.detail
            : undefined,
        );
        if (gate.outcome === "fail") {
          await appendImpactEntry({
            source: "guards",
            action: "promote",
            skillName: skill,
            verdict: "gate-failed",
            detail: formatGateSummary(gate),
          });
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `staging gate refused "${skill}": ${formatGateSummary(gate)}`,
            ),
          );
          return;
        }
      }
      const result = await promoteStaged(
        { storageRoots: roots },
        {
          name: skill,
          reason: "guards.promote_candidate",
          author: "operator",
          // admin-scoped method (server-methods.ts); may override evolution staging
          allowEvolutionStaged: true,
        },
      );
      if (!result.ok) {
        await appendImpactEntry({
          source: "guards",
          action: "promote",
          skillName: skill,
          verdict: "rejected",
          detail: result.detail ?? result.error ?? "promote failed",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, result.detail ?? result.error ?? "promote failed"),
        );
        return;
      }
      await appendImpactEntry({
        source: "guards",
        action: "promote",
        skillName: skill,
        verdict: "accepted",
        detail: `archived previous v${result.previousArchived?.version ?? "none"}`,
      });
      respond(true, { ok: true, promotedSkill: skill, livePath: liveSkillPath(roots, skill) });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "guards.clear_strikes": ({ params, respond }) => {
    const id =
      params && typeof params === "object"
        ? (params as { interceptorId?: unknown }).interceptorId
        : undefined;
    if (typeof id !== "string" || id.length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "interceptorId required"));
      return;
    }
    const dbPath = resolveDbPath();
    if (!dbPath || !fs.existsSync(dbPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "agent memory db not found"));
      return;
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath);
      db.prepare(`DELETE FROM interceptor_strikes WHERE interceptor_id = ?`).run(id);
      // Also re-enable in the in-process registry so it can fire again
      // without a gateway restart.
      getInterceptorRegistry().enableForOperator(id);
      respond(true, { ok: true, clearedInterceptorId: id });
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

interface StagedCandidate {
  skill: string;
  skillMdPath: string;
  stagedAtMs: number | null;
  body: string;
}

async function listStagedHarvestCandidates(): Promise<StagedCandidate[]> {
  // PLAN-42 Phase 0: staging paths come from the shared storage module so
  // this listing can never drift from where promote/gate actually look.
  const stagingDir = resolveStorageRoots().stagingRoot;
  if (!fs.existsSync(stagingDir)) return [];
  let entries: string[];
  try {
    entries = await fsp.readdir(stagingDir);
  } catch {
    return [];
  }
  const out: StagedCandidate[] = [];
  for (const name of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) continue;
    const skillDir = path.join(stagingDir, name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const metaPath = path.join(skillDir, ".staging-meta.json");
    try {
      const stat = await fsp.stat(skillMdPath);
      if (!stat.isFile()) continue;
      const body = await fsp.readFile(skillMdPath, "utf8");
      // Only surface candidates that came from interceptor_harvest. If
      // the .staging-meta.json says something else, skip.
      let stagedAtMs: number | null = null;
      let source: string | null = null;
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(await fsp.readFile(metaPath, "utf8")) as {
            source?: string;
            stagedAt?: number;
          };
          source = meta.source ?? null;
          stagedAtMs = typeof meta.stagedAt === "number" ? meta.stagedAt : null;
        } catch {
          // ignore
        }
      }
      if (source && source !== "interceptor_harvest") continue;
      out.push({ skill: name, skillMdPath, stagedAtMs, body });
    } catch {
      // ignore
    }
  }
  return out;
}
