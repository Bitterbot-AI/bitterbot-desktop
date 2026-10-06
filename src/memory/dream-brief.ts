/**
 * The daily "what I dreamed" brief (PLAN-53 G4).
 *
 * The dream engine works while nobody is looking; the owner never heard about
 * it. Once a day this says, in a few lines: how much the agent dreamed, the
 * strongest insights, what changed in what it holds true about the owner,
 * and what it has left open. Nothing is sent when there is nothing to say.
 */

import type { DatabaseSync } from "node:sqlite";

export type DreamBrief = {
  cycles: number;
  insights: Array<{ content: string; mode: string; confidence: number }>;
  facts: Array<{ statement: string; change: "new" | "updated" | "retired" }>;
  preferences: Array<{ key: string; value: string }>;
  openLoops: string[];
  forgotten: number;
};

const all = <T>(db: DatabaseSync, sql: string, ...args: Array<number | string>): T[] => {
  try {
    return db.prepare(sql).all(...args) as unknown as T[];
  } catch {
    // A table this node does not have (no dreams yet, no facts ledger).
    return [];
  }
};

const one = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function buildDreamBrief(db: DatabaseSync, sinceMs: number): DreamBrief {
  const cycles =
    all<{ n: number }>(
      db,
      "SELECT count(*) AS n FROM dream_cycles WHERE started_at >= ? AND error IS NULL",
      sinceMs,
    )[0]?.n ?? 0;
  const insights = all<{ content: string; mode: string; confidence: number }>(
    db,
    "SELECT content, mode, confidence FROM dream_insights WHERE created_at >= ? ORDER BY confidence DESC LIMIT 3",
    sinceMs,
  ).map((r) => ({ ...r, content: one(r.content, 220) }));
  const facts = all<{
    statement: string;
    key: string;
    value: string;
    status: string;
    first_seen_at: number;
    valid_until: number | null;
  }>(
    db,
    `SELECT statement, key, value, status, first_seen_at, valid_until FROM canonical_facts
      WHERE (first_seen_at >= ? OR valid_from >= ? OR (valid_until IS NOT NULL AND valid_until >= ?))
      ORDER BY valid_from DESC LIMIT 5`,
    sinceMs,
    sinceMs,
    sinceMs,
  ).map((r) => ({
    statement: one(r.statement || `${r.key}: ${r.value}`, 160),
    change:
      r.valid_until != null || r.status === "retired" || r.status === "superseded"
        ? ("retired" as const)
        : r.first_seen_at >= sinceMs
          ? ("new" as const)
          : ("updated" as const),
  }));
  const preferences = all<{ key: string; value: string }>(
    db,
    "SELECT key, value FROM user_preferences WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 3",
    sinceMs,
  ).map((r) => ({ key: r.key, value: one(r.value, 100) }));
  const openLoops = all<{ ctx: string }>(
    db,
    `SELECT coalesce(open_loop_context, substr(text, 1, 200)) AS ctx FROM chunks
      WHERE open_loop = 1 AND (lifecycle IS NULL OR lifecycle <> 'expired')
      ORDER BY updated_at DESC LIMIT 3`,
  ).map((r) => one(r.ctx, 160));
  const forgotten =
    all<{ n: number }>(
      db,
      "SELECT count(*) AS n FROM memory_audit_log WHERE event = 'forgotten' AND timestamp >= ?",
      sinceMs,
    )[0]?.n ?? 0;
  return { cycles, insights, facts, preferences, openLoops, forgotten };
}

/** True when the brief has something the owner would want to read. */
export function briefIsWorthSending(b: DreamBrief): boolean {
  return b.insights.length > 0 || b.facts.length > 0 || b.preferences.length > 0;
}

export function renderDreamBrief(b: DreamBrief): string {
  const lines: string[] = [];
  lines.push(
    `Overnight I dreamed ${b.cycles} time${b.cycles === 1 ? "" : "s"}` +
      (b.forgotten > 0
        ? ` and let go of ${b.forgotten} stale memor${b.forgotten === 1 ? "y" : "ies"}.`
        : "."),
  );
  if (b.insights.length > 0) {
    lines.push("", "What came out of it:");
    for (const i of b.insights) lines.push(`- ${i.content}`);
  }
  if (b.facts.length > 0 || b.preferences.length > 0) {
    lines.push("", "What changed in what I hold true about you:");
    for (const f of b.facts) {
      lines.push(
        `- ${f.change === "new" ? "Now: " : f.change === "retired" ? "No longer: " : "Updated: "}${f.statement}`,
      );
    }
    for (const p of b.preferences) lines.push(`- ${p.key}: ${p.value}`);
  }
  if (b.openLoops.length > 0) {
    lines.push("", "Still open:");
    for (const o of b.openLoops) lines.push(`- ${o}`);
  }
  lines.push("", "Anything wrong? Correct or forget it on the Memory page.");
  return lines.join("\n");
}
