/**
 * Pipeline Diagnostic Script
 * Run with: npx tsx src/memory/scripts/pipeline-diagnostic.ts <db-path>
 *
 * Reports on the health of the dream/curiosity/consolidation pipeline.
 * Default DB path: ~/.bitterbot/workspace/memory/index.db
 * (Also checks ~/.bitterbot/workspace-dev/memory/index.db)
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath =
  process.argv[2] ??
  (() => {
    const candidates = [
      join(process.env.HOME ?? "~", ".bitterbot/workspace/memory/index.db"),
      join(process.env.HOME ?? "~", ".bitterbot/workspace-dev/memory/index.db"),
    ];
    return candidates.find(existsSync) ?? candidates[0]!;
  })();

console.log(`\n📊 Pipeline Diagnostic: ${dbPath}\n`);

if (!existsSync(dbPath)) {
  console.error(`❌ Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

// Helper
function query<T>(sql: string): T[] {
  return db.prepare(sql).all() as T[];
}
function queryOne<T>(sql: string): T | undefined {
  return db.prepare(sql).get() as T | undefined;
}

// === Section 1: Crystal Population ===
console.log("═══ CRYSTAL POPULATION ═══");
const totalChunks = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks")?.c ?? 0;
console.log(`Total chunks: ${totalChunks}`);

const byLifecycle = query<{ lifecycle: string | null; c: number }>(
  "SELECT COALESCE(lifecycle, 'null') as lifecycle, COUNT(*) as c FROM chunks GROUP BY lifecycle ORDER BY c DESC",
);
console.log("\nBy lifecycle:");
for (const r of byLifecycle) {
  console.log(`  ${r.lifecycle}: ${r.c}`);
}

const byType = query<{ st: string | null; c: number }>(
  "SELECT COALESCE(semantic_type, 'null') as st, COUNT(*) as c FROM chunks GROUP BY semantic_type ORDER BY c DESC",
);
console.log("\nBy semantic type:");
for (const r of byType) {
  console.log(`  ${r.st}: ${r.c}`);
}

const highImportance =
  queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks WHERE importance_score >= 0.8")?.c ?? 0;
const medImportance =
  queryOne<{ c: number }>(
    "SELECT COUNT(*) as c FROM chunks WHERE importance_score >= 0.3 AND importance_score < 0.8",
  )?.c ?? 0;
const lowImportance =
  queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks WHERE importance_score < 0.3")?.c ?? 0;
console.log(
  `\nImportance distribution: high(>=0.8)=${highImportance} med(0.3-0.8)=${medImportance} low(<0.3)=${lowImportance}`,
);

// === Section 2: Dream Engine ===
console.log("\n═══ DREAM ENGINE ═══");
const cycleCount = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM dream_cycles")?.c ?? 0;
console.log(`Total dream cycles: ${cycleCount}`);

const recentCycles = query<{
  cycleId: string;
  startedAt: number;
  state: string;
  insightsGenerated: number;
  llmCallsUsed: number;
  chunksAnalyzed: number;
  error: string | null;
  modesUsed: string;
}>(
  `SELECT cycle_id as cycleId, started_at as startedAt, state,
          insights_generated as insightsGenerated, llm_calls_used as llmCallsUsed,
          chunks_analyzed as chunksAnalyzed, error, modes_used as modesUsed
   FROM dream_cycles ORDER BY started_at DESC LIMIT 10`,
);

console.log(`\nLast 10 dream cycles:`);
for (const c of recentCycles) {
  const date = new Date(c.startedAt).toISOString().slice(0, 19);
  const modes = c.modesUsed || "[]";
  const err = c.error ? ` ❌ ${c.error.slice(0, 80)}` : "";
  console.log(
    `  ${date} | ${c.state.padEnd(10)} | modes=${modes.padEnd(30)} | insights=${c.insightsGenerated} | llm=${c.llmCallsUsed} | chunks=${c.chunksAnalyzed}${err}`,
  );
}

const insightCount = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM dream_insights")?.c ?? 0;
console.log(`\nTotal dream insights: ${insightCount}`);

if (insightCount > 0) {
  const recentInsights = query<{
    content: string;
    mode: string;
    confidence: number;
    created_at: number;
  }>(
    "SELECT content, mode, confidence, created_at FROM dream_insights ORDER BY created_at DESC LIMIT 5",
  );
  console.log("\nLatest insights:");
  for (const i of recentInsights) {
    const date = new Date(i.created_at).toISOString().slice(0, 19);
    console.log(
      `  [${date}] (${i.mode}, conf=${i.confidence.toFixed(2)}) ${i.content.slice(0, 120)}`,
    );
  }
}

// Mode distribution
const modeBreakdown = query<{ modesUsed: string }>(
  "SELECT modes_used as modesUsed FROM dream_cycles WHERE modes_used IS NOT NULL AND modes_used != '[]'",
);
const modeCounts: Record<string, number> = {};
for (const row of modeBreakdown) {
  try {
    const modes = JSON.parse(row.modesUsed) as string[];
    for (const m of modes) {
      modeCounts[m] = (modeCounts[m] ?? 0) + 1;
    }
  } catch {
    /* ignore */
  }
}
if (Object.keys(modeCounts).length > 0) {
  console.log("\nMode usage across all cycles:");
  for (const [mode, count] of Object.entries(modeCounts).toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${mode}: ${count} cycles`);
  }
}

// === Section 3: Curiosity Engine ===
console.log("\n═══ CURIOSITY ENGINE ═══");

// Check if curiosity tables exist
try {
  const targetCount =
    queryOne<{ c: number }>("SELECT COUNT(*) as c FROM curiosity_targets")?.c ?? 0;
  console.log(`Total curiosity targets: ${targetCount}`);

  const unresolvedTargets = query<{
    id: string;
    description: string;
    priority: number;
    created_at: number;
    resolved_at: number | null;
  }>(
    "SELECT id, description, priority, created_at, resolved_at FROM curiosity_targets WHERE resolved_at IS NULL ORDER BY priority DESC LIMIT 10",
  );
  console.log(`\nUnresolved targets (top 10):`);
  for (const t of unresolvedTargets) {
    const date = new Date(t.created_at).toISOString().slice(0, 19);
    console.log(`  [${date}] (pri=${t.priority}) ${t.description.slice(0, 100)}`);
  }

  // Check for duplicates
  const dupes = query<{ description: string; c: number }>(
    "SELECT description, COUNT(*) as c FROM curiosity_targets WHERE resolved_at IS NULL GROUP BY description HAVING c > 1",
  );
  if (dupes.length > 0) {
    console.log(`\n⚠️ Duplicate unresolved targets: ${dupes.length}`);
    for (const d of dupes) {
      console.log(`  "${d.description.slice(0, 80)}" x ${d.c}`);
    }
  }

  const regionCount =
    queryOne<{ c: number }>("SELECT COUNT(*) as c FROM curiosity_regions")?.c ?? 0;
  console.log(`\nKnowledge regions: ${regionCount}`);

  const assessmentCount =
    queryOne<{ c: number }>("SELECT COUNT(*) as c FROM curiosity_assessments")?.c ?? 0;
  console.log(`Chunk assessments: ${assessmentCount}`);
} catch (e) {
  console.log(`⚠️ Curiosity tables may not exist: ${String(e)}`);
}

// === Section 4: Consolidation ===
console.log("\n═══ CONSOLIDATION ═══");

const archived =
  queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks WHERE lifecycle = 'archived'")?.c ?? 0;
const expired =
  queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks WHERE lifecycle = 'expired'")?.c ?? 0;
const consolidated =
  queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks WHERE lifecycle = 'consolidated'")?.c ??
  0;
const frozen =
  queryOne<{ c: number }>("SELECT COUNT(*) as c FROM chunks WHERE lifecycle = 'frozen'")?.c ?? 0;
console.log(
  `Archived: ${archived} | Expired: ${expired} | Consolidated: ${consolidated} | Frozen: ${frozen}`,
);

// Check audit log
try {
  const auditCount =
    queryOne<{ c: number }>("SELECT COUNT(*) as c FROM consolidation_audit_log")?.c ?? 0;
  console.log(`Audit log entries: ${auditCount}`);

  if (auditCount > 0) {
    const recentAudit = query<{ action: string; c: number }>(
      "SELECT action, COUNT(*) as c FROM consolidation_audit_log GROUP BY action ORDER BY c DESC",
    );
    console.log("Actions:");
    for (const a of recentAudit) {
      console.log(`  ${a.action}: ${a.c}`);
    }
  }
} catch {
  console.log("⚠️ No consolidation audit log table");
}

// === Section 5: RLM / Working Memory ===
console.log("\n═══ WORKING MEMORY (RLM) ═══");

// Check dream journal for RLM entries
try {
  const journalEntries = query<{ entry: string; created_at: number }>(
    `SELECT entry, created_at FROM dream_journal
     WHERE entry LIKE '%Working Memory%' OR entry LIKE '%RLM%' OR entry LIKE '%Phenotype%'
     ORDER BY created_at DESC LIMIT 10`,
  );
  console.log(`RLM-related journal entries: ${journalEntries.length}`);
  for (const j of journalEntries) {
    const date = new Date(j.created_at).toISOString().slice(0, 19);
    console.log(`  [${date}] ${j.entry.slice(0, 120)}`);
  }
} catch {
  console.log("⚠️ No dream_journal table");
}

// === Section 6: Execution Tracker ===
console.log("\n═══ SKILL EXECUTION TRACKER ═══");
try {
  const execCount = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM skill_executions")?.c ?? 0;
  console.log(`Total skill executions: ${execCount}`);

  if (execCount > 0) {
    const execStats = query<{ skill_id: string; c: number; success: number }>(
      `SELECT skill_id, COUNT(*) as c,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success
       FROM skill_executions GROUP BY skill_id ORDER BY c DESC LIMIT 5`,
    );
    for (const e of execStats) {
      console.log(
        `  Skill ${e.skill_id.slice(0, 12)}... : ${e.c} executions, ${e.success} success`,
      );
    }
  }
} catch {
  console.log("⚠️ No skill_executions table");
}

// === Section 7: Hormonal State ===
console.log("\n═══ HORMONAL STATE ═══");
try {
  const events = query<{ hormone: string; c: number }>(
    "SELECT hormone, COUNT(*) as c FROM hormonal_events GROUP BY hormone ORDER BY c DESC",
  );
  console.log(`Hormonal events by type:`);
  for (const e of events) {
    console.log(`  ${e.hormone}: ${e.c}`);
  }

  const recentEvents = query<{ hormone: string; delta: number; created_at: number }>(
    "SELECT hormone, delta, created_at FROM hormonal_events ORDER BY created_at DESC LIMIT 5",
  );
  console.log(`\nLast 5 hormonal events:`);
  for (const e of recentEvents) {
    const date = new Date(e.created_at).toISOString().slice(0, 19);
    console.log(`  [${date}] ${e.hormone} ${e.delta > 0 ? "+" : ""}${e.delta.toFixed(3)}`);
  }
} catch {
  console.log("⚠️ No hormonal_events table (hormonal state is ephemeral — session-only)");
}

console.log("\n═══ SUMMARY ═══");
console.log(`Chunks: ${totalChunks} | Dream cycles: ${cycleCount} | Insights: ${insightCount}`);
console.log(
  `Lifecycle: ${archived} archived, ${expired} expired, ${consolidated} consolidated, ${frozen} frozen`,
);
const healthyInsightRate = cycleCount > 0 ? (insightCount / cycleCount).toFixed(2) : "N/A";
console.log(`Insight rate per cycle: ${healthyInsightRate}`);

if (insightCount === 0 && cycleCount > 5) {
  console.log("\n🚨 ALERT: Zero insights after 5+ dream cycles.");
  console.log("   Likely cause: LLM modes not producing insights.");
  console.log("   Check: Are dream cycles using LLM modes? See 'modes_used' column above.");
  console.log("   Check: Is llmCall returning valid JSON? Look for errors in dream_cycles.");
}

if (cycleCount === 0) {
  console.log("\n⚠️ No dream cycles recorded. Dream engine may not be running.");
}

db.close();
console.log("\nDone.");
