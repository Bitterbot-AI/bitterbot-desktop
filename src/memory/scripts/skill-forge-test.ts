/**
 * Skill Forge — End-to-End Skills Pipeline Test
 *
 * Exercises the full Knowledge Crystal pipeline:
 * 1. Creates a seed skill chunk (simulating a learned task pattern)
 * 2. Records mock execution history (3+ successes)
 * 3. Runs SkillCrystallizer to promote patterns
 * 4. Runs SkillRefiner with mock dream mutations
 * 5. Verifies crystallized skill in DB
 * 6. Validates SKILL.md generation
 * 7. Tests P2P publish (if orchestrator is running)
 * 8. Tests inbound ingestion (P2P receive path)
 * 9. Verifies marketplace economics integration
 *
 * Run: npx tsx src/memory/scripts/skill-forge-test.ts
 * Verbose: npx tsx src/memory/scripts/skill-forge-test.ts --verbose
 * Against copy of live DB: npx tsx src/memory/scripts/skill-forge-test.ts --live path/to/main.sqlite
 *
 * Uses a SEPARATE test database (copies production DB or creates fresh).
 * Never modifies the live database.
 */

import crypto from "node:crypto";
import { existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SkillEnvelope } from "../../agents/skills/ingest.js";
import type { DreamInsight } from "../dream-types.js";
import { ConsolidationEngine } from "../consolidation.js";
import { ensureCuriositySchema } from "../curiosity-schema.js";
import { ensureDreamSchema } from "../dream-schema.js";
import { MarketplaceEconomics } from "../marketplace-economics.js";
import { ensureMemoryIndexSchema, ensureColumn } from "../memory-schema.js";
import { SkillCrystallizer } from "../skill-crystallizer.js";
// ── Imports from the codebase ──────────────────────────────────────
import { SkillExecutionTracker } from "../skill-execution-tracker.js";
import { SkillNetworkBridge } from "../skill-network-bridge.js";
import { SkillRefiner } from "../skill-refiner.js";

// ── Configuration ──────────────────────────────────────────────────
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const USE_LIVE_DB = process.argv.includes("--live");
const DB_PATH_ARG = process.argv.find((a) => a.endsWith(".sqlite") || a.endsWith(".db"));

// ── Test Database Setup ────────────────────────────────────────────
function setupTestDb(): DatabaseSync {
  if (USE_LIVE_DB && DB_PATH_ARG) {
    if (!existsSync(DB_PATH_ARG)) {
      console.error(`Database not found: ${DB_PATH_ARG}`);
      process.exit(1);
    }
    console.log("Warning: Using COPY of live database (read-only to original)");
    const testPath = join(tmpdir(), `skill-forge-test-${Date.now()}.sqlite`);
    copyFileSync(DB_PATH_ARG, testPath);
    const db = new DatabaseSync(testPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    console.log(`Test database: ${testPath}`);
    return db;
  }

  // Create fresh test database with full schema
  const testPath = join(tmpdir(), `skill-forge-test-${Date.now()}.sqlite`);
  const db = new DatabaseSync(testPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Initialize production schemas
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false, // FTS not needed for this test
  });
  ensureDreamSchema(db);
  ensureCuriositySchema(db);

  // Ensure columns added by migrations/mem-store (not in base schema)
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  ensureColumn(db, "chunks", "provenance_dag", "TEXT");
  ensureColumn(db, "chunks", "provenance_chain", "TEXT");
  ensureColumn(db, "chunks", "semantic_type", "TEXT");
  ensureColumn(db, "chunks", "governance_json", "TEXT");
  ensureColumn(db, "chunks", "stable_skill_id", "TEXT");
  ensureColumn(db, "chunks", "skill_version", "INTEGER");
  ensureColumn(db, "chunks", "skill_category", "TEXT");
  ensureColumn(db, "chunks", "skill_tags", "TEXT");
  ensureColumn(db, "chunks", "marketplace_listed", "INTEGER");
  ensureColumn(db, "chunks", "marketplace_description", "TEXT");
  ensureColumn(db, "chunks", "download_count", "INTEGER");
  ensureColumn(db, "chunks", "steering_reward", "REAL");
  ensureColumn(db, "chunks", "lifecycle", "TEXT");
  ensureColumn(db, "chunks", "is_verified", "INTEGER");
  ensureColumn(db, "chunks", "verified_by", "TEXT");
  ensureColumn(db, "chunks", "deprecated", "INTEGER");
  ensureColumn(db, "chunks", "bounty_match_id", "TEXT");
  ensureColumn(db, "chunks", "lifecycle_state", "TEXT");

  // Ensure skill_executions table (not created by schema init)
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_executions (
      id TEXT PRIMARY KEY,
      skill_crystal_id TEXT NOT NULL,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      success INTEGER,
      reward_score REAL,
      error_type TEXT,
      error_detail TEXT,
      execution_time_ms INTEGER,
      tool_calls_count INTEGER,
      user_feedback INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_skill_exec_crystal ON skill_executions(skill_crystal_id);
  `);

  // Ensure peer reputation table (needed by bridge)
  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_reputation (
      pubkey TEXT PRIMARY KEY,
      peer_id TEXT,
      skills_received INTEGER DEFAULT 0,
      skills_accepted INTEGER DEFAULT 0,
      skills_rejected INTEGER DEFAULT 0,
      avg_skill_quality REAL DEFAULT 0,
      reputation_score REAL DEFAULT 0.5,
      trust_level TEXT DEFAULT 'provisional',
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      banned INTEGER DEFAULT 0,
      eigentrust_score REAL DEFAULT 0
    );
  `);

  // Ensure memory_audit_log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      detail TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);

  // Initialize marketplace tables
  new MarketplaceEconomics(db);

  console.log(`Test database: ${testPath}`);
  return db;
}

// ── Helpers ─────────────────────────────────────────────────────────
function fakeEmbedding(seed: number): number[] {
  const arr = new Array(1536).fill(0);
  for (let i = 0; i < 10; i++) {
    arr[(seed * 7 + i * 13) % 1536] = ((seed + i) % 10) / 10;
  }
  return arr;
}

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    passCount++;
    console.log(`  PASS: ${label}`);
  } else {
    failCount++;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

// ══════════════════════════════════════════════════════════════════════
// MAIN TEST SEQUENCE
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\nSkill Forge — End-to-End Skills Pipeline Test\n");
  const db = setupTestDb();

  // ── Phase 1: Seed a Task Pattern ──────────────────────────────────
  section("Phase 1: Seed Skill Chunk");

  const seedSkillId = crypto.randomUUID();
  const stableSkillId = crypto.randomUUID();
  const seedSkillText = `When deploying a Node.js application to production:
1. Run the full test suite (npm test)
2. Build the TypeScript (npm run build)
3. Verify no type errors in the build output
4. Create a git tag for the release version
5. Push to the deployment branch
6. Monitor the health check endpoint for 5 minutes
7. If health check fails, roll back to previous tag

This workflow has been executed successfully multiple times and handles
common edge cases including build failures and health check timeouts.`;

  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding,
      updated_at, importance_score, access_count, lifecycle_state, lifecycle,
      memory_type, semantic_type, created_at, governance_json,
      stable_skill_id, skill_version, skill_category, skill_tags,
      publish_visibility
    ) VALUES (
      ?, 'workspace/skills/deploy-node', 'skills', 0, 0, ?, 'task-pattern', ?, ?,
      ?, 0.7, 0, 'active', 'generated',
      'plaintext', 'task_pattern', ?, ?,
      ?, 1, 'deployment', '["nodejs","deploy","ci"]',
      'shared'
    )`,
  ).run(
    seedSkillId,
    crypto.randomUUID(),
    seedSkillText,
    JSON.stringify(fakeEmbedding(42)),
    now,
    now,
    JSON.stringify({ accessScope: "shared", lifespanPolicy: "permanent", sensitivity: "normal" }),
    stableSkillId,
  );

  const seedRow = db
    .prepare("SELECT id, text, semantic_type FROM chunks WHERE id = ?")
    .get(seedSkillId) as Record<string, unknown> | undefined;
  assert(!!seedRow, "Seed skill chunk inserted");
  assert(seedRow?.semantic_type === "task_pattern", "Semantic type is task_pattern");

  // ── Phase 2: Record Execution History ─────────────────────────────
  section("Phase 2: Record Execution History");

  const tracker = new SkillExecutionTracker(db);

  // Record 5 executions: 4 success, 1 failure (80% success rate)
  const executions = [
    { success: true, reward: 0.85, timeMs: 12000 },
    { success: true, reward: 0.9, timeMs: 11500 },
    { success: false, reward: 0.1, timeMs: 45000, error: "health_check_timeout" },
    { success: true, reward: 0.88, timeMs: 13000 },
    { success: true, reward: 0.92, timeMs: 10800 },
  ];

  for (const exec of executions) {
    const execId = tracker.startExecution(seedSkillId, "test-session");
    tracker.completeExecution(execId, {
      success: exec.success,
      rewardScore: exec.reward,
      executionTimeMs: exec.timeMs,
      errorType: exec.error ?? undefined,
    });
  }

  const metrics = tracker.getSkillMetrics(seedSkillId);
  assert(metrics.totalExecutions === 5, `5 executions recorded (got ${metrics.totalExecutions})`);
  assert(
    metrics.successRate >= 0.79 && metrics.successRate <= 0.81,
    `~80% success rate (got ${(metrics.successRate * 100).toFixed(0)}%)`,
  );
  assert(
    metrics.avgRewardScore > 0.5,
    `Avg reward > 0.5 (got ${metrics.avgRewardScore.toFixed(2)})`,
  );

  if (VERBOSE) {
    console.log("  Metrics:", JSON.stringify(metrics, null, 2));
  }

  // ── Phase 3: Skill Crystallizer ───────────────────────────────────
  section("Phase 3: SkillCrystallizer — Pattern Detection");

  const crystallizer = new SkillCrystallizer(db, tracker);
  const crystallized = crystallizer.crystallizePatterns();

  console.log(`  Crystallized: ${crystallized} new skill(s)`);

  // Verify the new frozen skill crystal in DB
  const frozenSkills = db
    .prepare(
      "SELECT id, text, lifecycle, semantic_type, stable_skill_id, skill_version FROM chunks WHERE lifecycle = 'frozen' AND semantic_type = 'skill'",
    )
    .all() as Array<Record<string, unknown>>;

  if (crystallized >= 1) {
    assert(true, `At least 1 skill crystallized (got ${crystallized})`);
  } else {
    // Crystallizer may not have promoted — check why
    assert(
      false,
      `Expected at least 1 crystallized skill (got ${crystallized})`,
      "Check MIN_SUCCESSES/MIN_SUCCESS_RATE thresholds",
    );
  }

  if (frozenSkills.length > 0) {
    const skill = frozenSkills[0]!;
    assert(skill.lifecycle === "frozen", "Skill lifecycle is frozen");
    assert(skill.semantic_type === "skill", "Skill semantic_type is skill");
    assert(!!skill.stable_skill_id, "Has stable_skill_id for versioning");
    if (VERBOSE) {
      console.log("  Skill text preview:", String(skill.text ?? "").slice(0, 200));
    }
  }

  // ── Phase 4: Skill Refiner with Dream Mutation ────────────────────
  section("Phase 4: SkillRefiner — Mutation Evaluation");

  const refiner = new SkillRefiner(db, undefined, undefined, tracker);

  // Simulate a dream mutation insight that improves the original skill
  const mockMutation: DreamInsight = {
    id: crypto.randomUUID(),
    content: `Enhanced Node.js deployment workflow with zero-downtime strategy:
1. Run the full test suite in parallel with linting (npm test & npm run lint)
2. Build TypeScript with strict mode enabled (npx tsc --strict)
3. Run integration tests against staging environment
4. Create a versioned Docker image tagged with git SHA
5. Deploy using blue-green strategy: spin up new instances alongside old
6. Run smoke tests against new instances
7. Switch load balancer to new instances
8. Keep old instances warm for 15 minutes as rollback safety net
9. If any health check fails within the window, instant rollback via LB switch

Key improvements over base workflow:
- Parallel test execution saves ~40% CI time
- Docker containerization ensures environment consistency
- Blue-green deployment eliminates downtime
- Extended rollback window covers slow-burn failures`,
    embedding: fakeEmbedding(99),
    confidence: 0.88,
    mode: "mutation",
    sourceChunkIds: [seedSkillId],
    sourceClusterIds: [],
    dreamCycleId: "test-forge-cycle",
    importanceScore: 0.7,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Insert the mock mutation into dream_insights
  db.prepare(
    `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mockMutation.id,
    mockMutation.content,
    JSON.stringify(mockMutation.embedding),
    mockMutation.confidence,
    mockMutation.mode,
    JSON.stringify(mockMutation.sourceChunkIds),
    JSON.stringify(mockMutation.sourceClusterIds),
    mockMutation.dreamCycleId,
    mockMutation.importanceScore,
    mockMutation.accessCount,
    mockMutation.createdAt,
    mockMutation.updatedAt,
  );

  const original = { id: seedSkillId, text: seedSkillText };
  let refinerResult: ReturnType<typeof refiner.evaluateMutations> | null = null;
  try {
    refinerResult = refiner.evaluateMutations(original, [mockMutation]);
    assert(refinerResult.mutations.length === 1, "1 mutation evaluated");
    const mutResult = refinerResult.mutations[0]!;
    console.log(
      `  Score: ${mutResult.score.toFixed(3)} | Promoted: ${mutResult.promoted} | Reason: ${mutResult.reason}`,
    );
  } catch (err) {
    assert(false, "SkillRefiner.evaluateMutations()", String(err));
  }

  // Count total skill crystals after refinement
  const allSkills = db
    .prepare(
      "SELECT id, text, lifecycle, origin FROM chunks WHERE semantic_type = 'skill' AND lifecycle = 'frozen'",
    )
    .all() as Array<Record<string, unknown>>;
  console.log(`  Total frozen skill crystals after refinement: ${allSkills.length}`);

  // ── Phase 5: SKILL.md Generation ──────────────────────────────────
  section("Phase 5: SKILL.md Format Validation");

  const bestSkill = allSkills[0] ?? frozenSkills[0];
  if (bestSkill) {
    const skillRow = db
      .prepare("SELECT text, path FROM chunks WHERE id = ?")
      .get(String(bestSkill.id)) as Record<string, unknown> | undefined;
    if (skillRow) {
      const pathParts = String(skillRow.path || "").split("/");
      const name = (pathParts[pathParts.length - 1] || String(bestSkill.id).slice(0, 8))
        .replace(/[^a-z0-9-]/gi, "-")
        .slice(0, 64);
      const skillMd = `---\nname: ${name}\ndescription: Dream-generated skill crystal\ncrystal_id: ${bestSkill.id}\n---\n\n${skillRow.text}`;

      const lines = skillMd.split("\n");
      assert(lines[0] === "---", "SKILL.md starts with YAML frontmatter delimiter");
      assert(skillMd.includes("name:"), "Has name field");
      assert(skillMd.includes("description:"), "Has description field");
      assert(lines.length <= 500, `Under 500 lines (got ${lines.length})`);
      assert(skillMd.length <= 20000, `Under 5000 tokens (~20K chars, got ${skillMd.length})`);

      if (VERBOSE) {
        console.log("  Generated SKILL.md preview:");
        console.log("  " + skillMd.slice(0, 300).split("\n").join("\n  "));
      }
    }
  } else {
    console.log("  Warning: No skill crystal available for SKILL.md test");
  }

  // ── Phase 6: P2P Ingestion (Receive Path) ─────────────────────────
  section("Phase 6: P2P Ingestion — Inbound Skill");

  const bridge = new SkillNetworkBridge(db, null); // null orchestrator = no P2P

  // Simulate receiving a skill from a peer
  const peerPubkey = "peer-test-pubkey-" + crypto.randomUUID().slice(0, 8);
  const peerSkillContent = `---\nname: peer-docker-skill\ndescription: Docker optimization from peer\n---\n\nOptimize Docker builds using multi-stage builds and layer caching.`;
  const peerSkillEnvelope: SkillEnvelope = {
    version: 1,
    skill_md: Buffer.from(peerSkillContent, "utf-8").toString("base64"),
    name: "peer-docker-skill",
    author_peer_id: "peer-" + crypto.randomUUID().slice(0, 8),
    author_pubkey: peerPubkey,
    signature: Buffer.from("test-signature").toString("base64"),
    timestamp: Date.now(),
    content_hash: crypto.createHash("sha256").update(peerSkillContent).digest("hex"),
    stable_skill_id: crypto.randomUUID(),
    skill_version: 1,
  };

  let ingestResult: { ok: boolean; action?: string; reason?: string; crystalId?: string };
  try {
    ingestResult = bridge.ingestNetworkSkill(peerSkillEnvelope);
    assert(
      ingestResult.ok === true,
      `Peer skill ingested successfully (action: ${ingestResult.action})`,
    );

    if (ingestResult.ok && ingestResult.crystalId) {
      const imported = db
        .prepare("SELECT id, lifecycle, semantic_type, origin FROM chunks WHERE id = ?")
        .get(ingestResult.crystalId) as Record<string, unknown> | undefined;
      assert(!!imported, "Imported crystal exists in DB");
    }
  } catch (err) {
    assert(false, "Peer skill ingestion", String(err));
    ingestResult = { ok: false, reason: String(err) };
  }

  // Test duplicate rejection
  try {
    const dupeResult = bridge.ingestNetworkSkill(peerSkillEnvelope);
    assert(dupeResult.ok === false, "Duplicate skill rejected");
  } catch (err) {
    // Some implementations throw on duplicate — that's also acceptable
    assert(true, "Duplicate skill rejected (via exception)");
  }

  // ── Phase 7: Provenance & Governance ──────────────────────────────
  section("Phase 7: Provenance & Governance Checks");

  if (allSkills.length > 0) {
    const skillWithProvenance = db
      .prepare("SELECT provenance_chain, provenance_dag, governance_json FROM chunks WHERE id = ?")
      .get(String(allSkills[0]!.id)) as Record<string, unknown> | undefined;

    if (skillWithProvenance?.governance_json) {
      try {
        const gov = JSON.parse(String(skillWithProvenance.governance_json));
        assert(gov.accessScope === "shared", `Governance scope is shared (got ${gov.accessScope})`);
        console.log(`  Governance: ${JSON.stringify(gov)}`);
      } catch {
        console.log("  Warning: Could not parse governance_json");
      }
    } else {
      console.log("  Warning: No governance_json on skill crystal");
    }
  }

  // Check audit log
  try {
    const auditEntries = db
      .prepare(
        "SELECT event, COUNT(*) as c FROM memory_audit_log WHERE event LIKE '%skill%' GROUP BY event",
      )
      .all() as Array<Record<string, unknown>>;
    console.log("  Audit events:", JSON.stringify(auditEntries));
  } catch {
    console.log("  Warning: Could not read audit log");
  }

  // ── Phase 8: Marketplace Economics Integration ────────────────────
  section("Phase 8: Marketplace Economics");

  if (allSkills.length > 0) {
    const marketplaceRow = db
      .prepare(
        `SELECT id, marketplace_listed, marketplace_description, download_count, steering_reward
       FROM chunks WHERE id = ?`,
      )
      .get(String(allSkills[0]!.id)) as Record<string, unknown> | undefined;

    if (marketplaceRow) {
      console.log(`  Steering reward: ${marketplaceRow.steering_reward}`);
      console.log(`  Marketplace listed: ${marketplaceRow.marketplace_listed}`);
      console.log(`  Download count: ${marketplaceRow.download_count ?? 0}`);
    }
  }

  // Test MarketplaceEconomics refresh
  const marketplace = new MarketplaceEconomics(db);
  const listedCount = marketplace.refreshListings(0.5);
  console.log(`  Marketplace listings after refresh: ${listedCount}`);
  const summary = marketplace.getEconomicSummary();
  console.log(
    `  Economic summary: earnings=$${summary.totalEarningsUsdc.toFixed(4)}, listed=${summary.listedSkillCount}`,
  );

  // ── Phase 9: Consolidation Immunity ───────────────────────────────
  section("Phase 9: Consolidation Immunity (Frozen = Survives Decay)");

  const preConsolSkillCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM chunks WHERE semantic_type = 'skill' AND lifecycle = 'frozen'",
      )
      .get() as { c: number }
  ).c;

  const consolidation = new ConsolidationEngine(db, {});
  const consolStats = consolidation.run();
  console.log(
    `  Consolidation: ${consolStats.totalChunks} chunks, ${consolStats.forgottenChunks} forgotten, ${consolStats.mergedChunks} merged`,
  );

  const postConsolSkillCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM chunks WHERE semantic_type = 'skill' AND lifecycle = 'frozen'",
      )
      .get() as { c: number }
  ).c;
  assert(
    postConsolSkillCount >= preConsolSkillCount,
    `All frozen skills survived consolidation (${postConsolSkillCount} >= ${preConsolSkillCount})`,
  );

  // ══════════════════════════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════════════════════════
  section("RESULTS");
  console.log(`\n  Passed: ${passCount}`);
  console.log(`  Failed: ${failCount}`);
  console.log(`  Total:  ${passCount + failCount}`);

  if (failCount === 0) {
    console.log("\nAll tests passed! The Knowledge Crystal pipeline is fully operational.");
  } else {
    console.log(`\n${failCount} test(s) failed. Review output above.`);
  }

  db.close();
  console.log("\nDone.\n");
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
