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
import { callGateway } from "../gateway/call.js";
import {
  __considerationsConsts,
  __considerationsTodayKey,
} from "../infra/heartbeat-considerations.js";
import { note } from "../terminal/note.js";
import { CONFIG_DIR } from "../utils.js";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };

const ok = (message: string): CheckResult => ({ level: "ok", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function formatLevel(r: CheckResult): string {
  const icon = r.level === "ok" ? "✓" : r.level === "warn" ? "!" : r.level === "error" ? "✗" : "·";
  return `${icon} ${r.message}`;
}

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

export async function runAgentRuntimeChecks(): Promise<void> {
  const results: CheckResult[] = [];

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
  if (results.length === 0) return;
  note(results.map(formatLevel).join("\n"), "Agent runtime");
}
