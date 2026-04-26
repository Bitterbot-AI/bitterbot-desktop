/**
 * Doctor section for agent-runtime observability.
 *
 * Surfaces what's accessible to a one-shot CLI invocation:
 *   - Today's heartbeat-considerations file: row count, top categories,
 *     top decisions. (Persistent on disk.)
 *
 * Deliberately omits:
 *   - Prompt cache hit ratio per session
 *   - Compaction circuit breaker state per session
 *   These live in the running gateway's process memory and require an
 *   RPC method to expose. Adding that surface is a follow-on.
 */

import fs from "node:fs/promises";
import path from "node:path";
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

  // Note for in-memory state that doctor can't reach without a running gateway.
  results.push(
    info(
      "Cache hit ratio + compaction breaker state live in the running gateway. Use 'bitterbot heartbeat why' or attach to gateway logs for a live view.",
    ),
  );

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) return;
  note(results.map(formatLevel).join("\n"), "Agent runtime");
}
