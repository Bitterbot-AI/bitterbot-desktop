/**
 * Doctor section for agent-runtime observability.
 *
 * Surfaces:
 *   - Today's heartbeat-considerations file (persistent on disk).
 *   - When the gateway is running: live cache hit ratios and compaction
 *     breaker state via the agent.runtime.health RPC.
 *
 * The RPC path fails fast and quietly when the gateway is unreachable,
 * so doctor remains useful in offline / fresh-install scenarios.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeEngine } from "../agents/runtime/engine.js";
import type { BitterbotConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import {
  __considerationsConsts,
  __considerationsTodayKey,
} from "../infra/heartbeat-considerations.js";
import {
  type EngineComparisonRow,
  getUsageLedger,
  isUsageLedgerEnabled,
} from "../infra/usage-ledger.js";
import { CONFIG_DIR } from "../utils.js";
import {
  renderSection as renderDoctorSection,
  type CheckResult,
  ok,
  info,
} from "./doctor-check.js";

type SummaryLine = {
  total: number;
  byDecision: Map<string, number>;
  byCategory: Map<string, number>;
};

function summarizeNdjson(content: string): SummaryLine {
  const out: SummaryLine = {
    total: 0,
    byDecision: new Map(),
    byCategory: new Map(),
  };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { decision?: unknown; category?: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    out.total += 1;
    const decision = typeof parsed.decision === "string" ? parsed.decision : "unknown";
    out.byDecision.set(decision, (out.byDecision.get(decision) ?? 0) + 1);
    const category = typeof parsed.category === "string" ? parsed.category : "unknown";
    out.byCategory.set(category, (out.byCategory.get(category) ?? 0) + 1);
  }
  return out;
}

function topN(map: Map<string, number>, n: number): string {
  const entries = [...map.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, n);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * PLAN-52: which runtime engine each agent runs on, and, when both engines
 * have recorded runs in the last 14 days, the numbers the soak gates compare.
 */
export function collectRuntimeEngineChecks(params: {
  config?: BitterbotConfig;
  comparison?: EngineComparisonRow[];
}): CheckResult[] {
  const results: CheckResult[] = [];
  const defaultEngine = resolveRuntimeEngine(params.config);
  const overrides = (params.config?.agents?.list ?? [])
    .map((agent) => ({ id: agent.id, engine: resolveRuntimeEngine(params.config, agent.id) }))
    .filter((agent) => agent.engine !== defaultEngine);
  results.push(
    ok(
      `Runtime engine: ${defaultEngine} (default)` +
        (overrides.length > 0
          ? `; ${overrides.map((agent) => `${agent.id}=${agent.engine}`).join(", ")}`
          : ""),
    ),
  );
  const rows = params.comparison ?? [];
  if (rows.length >= 2) {
    for (const row of rows) {
      const ms = (value: number | null) => (value === null ? "n/a" : `${Math.round(value)} ms`);
      const rate = row.toolErrorRate === null ? "n/a" : `${(row.toolErrorRate * 100).toFixed(1)}%`;
      results.push(
        info(
          `  ${row.engine}: ${row.runs} runs, $${row.costPerRunUsd.toFixed(4)}/run, ` +
            `model call p50 ${ms(row.durationP50Ms)} p95 ${ms(row.durationP95Ms)}, ` +
            `tool errors ${rate} (${row.toolErrors}/${row.toolCalls}), ` +
            `error calls ${row.errorCalls}/${row.modelCalls} (last 14 days)`,
        ),
      );
    }
  }
  return results;
}

export async function runAgentRuntimeChecks(config?: BitterbotConfig): Promise<void> {
  const results: CheckResult[] = [];

  try {
    const ledger = isUsageLedgerEnabled() ? getUsageLedger() : null;
    results.push(
      ...collectRuntimeEngineChecks({
        config,
        comparison: ledger?.engineComparison({ startMs: Date.now() - 14 * DAY_MS }),
      }),
    );
  } catch (err) {
    results.push(info(`Runtime engine comparison unavailable: ${String(err)}`));
  }

  // Today's considerations file.
  const todayKey = __considerationsTodayKey();
  const filePath = path.join(
    CONFIG_DIR,
    __considerationsConsts.DIR_NAME,
    `${__considerationsConsts.FILE_PREFIX}${todayKey}${__considerationsConsts.FILE_SUFFIX}`,
  );
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      const content = await fs.readFile(filePath, "utf-8");
      const summary = summarizeNdjson(content);
      results.push(
        ok(
          `Considerations log (${todayKey}): ${summary.total} entries, ${stat.size.toLocaleString()} bytes`,
        ),
      );
      if (summary.total > 0) {
        results.push(info(`  decisions: ${topN(summary.byDecision, 4)}`));
        results.push(info(`  categories: ${topN(summary.byCategory, 4)}`));
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      results.push(
        info(
          `No considerations recorded today (file would be ${filePath}). The heartbeat will create it on first record.`,
        ),
      );
    } else {
      results.push(info(`Considerations log unreadable: ${String(err)}`));
    }
  }

  // Live in-memory state via RPC (only available if the gateway is up).
  type RuntimeHealthResp = {
    cache?: Array<{
      sessionKey: string;
      turns: number;
      busts: number;
      hitRatio: number;
      recentHitRatio: number;
    }>;
    breakers?: Array<{
      sessionKey: string;
      state: string;
      consecutiveFailures: number;
      lastReason?: string;
    }>;
    truncated?: { cache: boolean; breakers: boolean };
  };
  let runtimeHealth: RuntimeHealthResp | null = null;
  try {
    runtimeHealth = (await callGateway<RuntimeHealthResp>({
      method: "agent.runtime.health",
      params: { limit: 10 },
      timeoutMs: 3_000,
    })) as RuntimeHealthResp;
  } catch {
    // Gateway not reachable — common in fresh installs and during doctor
    // before gateway start. Skip live info silently.
  }

  if (runtimeHealth) {
    const cache = runtimeHealth.cache ?? [];
    if (cache.length === 0) {
      results.push(info("Prompt cache: no traffic observed yet."));
    } else {
      const top = cache
        .toSorted((a, b) => b.turns - a.turns)
        .slice(0, 5)
        .map(
          (m) =>
            `${m.sessionKey} hit=${(m.hitRatio * 100).toFixed(0)}% recent=${(m.recentHitRatio * 100).toFixed(0)}% turns=${m.turns} busts=${m.busts}`,
        );
      results.push(ok(`Prompt cache (${cache.length} session${cache.length === 1 ? "" : "s"}):`));
      for (const line of top) results.push(info(`  ${line}`));
    }

    const breakers = runtimeHealth.breakers ?? [];
    if (breakers.length === 0) {
      results.push(info("Compaction breaker: no failures recorded."));
    } else {
      const open = breakers.filter((b) => b.state !== "closed");
      if (open.length === 0) {
        results.push(ok(`Compaction breaker: ${breakers.length} tracked, all closed.`));
      } else {
        results.push(info(`Compaction breaker: ${open.length} of ${breakers.length} not closed:`));
        for (const b of open.slice(0, 5)) {
          results.push(
            info(
              `  ${b.sessionKey} state=${b.state} fails=${b.consecutiveFailures} reason=${b.lastReason ?? "?"}`,
            ),
          );
        }
      }
    }
  } else {
    results.push(
      info(
        "Live cache + breaker state unavailable (gateway not reachable). Start the gateway and rerun for the live view.",
      ),
    );
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  renderDoctorSection("Agent runtime", results);
}
