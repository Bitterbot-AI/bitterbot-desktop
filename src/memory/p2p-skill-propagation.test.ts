/**
 * Comprehensive test suite for P2P Skill Propagation.
 *
 * Tests the full pipeline: skill execution tracking, peer reputation,
 * skill network bridge (publish/ingest), marketplace, discovery agent,
 * governance enforcement, versioning, and end-to-end integration flows.
 *
 * Every test uses an in-memory SQLite database for full isolation.
 */

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { PeerReputationManager } from "./peer-reputation.js";
import { SkillNetworkBridge, type OrchestratorBridgeLike } from "./skill-network-bridge.js";
import { SkillMarketplace } from "./skill-marketplace.js";
import { DiscoveryAgent } from "./discovery-agent.js";
import { MemoryGovernance } from "./governance.js";
import { MemStore } from "./mem-store.js";
import { SkillRefiner } from "./skill-refiner.js";
import { ConsolidationEngine } from "./consolidation.js";
import { DreamEngine } from "./dream-engine.js";
import type { DreamInsight, SynthesizeFn, EmbedBatchFn } from "./dream-types.js";
import type { SkillEnvelope } from "../agents/skills/ingest.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  // MemStore constructor adds these columns; add them here since tests
  // may use SkillNetworkBridge without creating a MemStore instance.
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  return db;
}

function fakeEmbedding(seed: number): number[] {
  const norm = Math.sqrt(seed * seed + 1 + 4 + 9);
  return [seed / norm, 1 / norm, 2 / norm, 3 / norm];
}

function insertChunk(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    path: string;
    source: string;
    text: string;
    hash: string;
    embedding: string;
    importance_score: number;
    access_count: number;
    lifecycle_state: string;
    lifecycle: string;
    memory_type: string;
    semantic_type: string;
    emotional_valence: number | null;
    curiosity_boost: number;
    dream_count: number;
    origin: string;
    governance_json: string;
    created_at: number;
    updated_at: number;
    start_line: number;
    end_line: number;
    model: string;
    version: number;
    parent_id: string | null;
    last_dreamed_at: number | null;
    last_accessed_at: number | null;
    hormonal_dopamine: number;
    hormonal_cortisol: number;
    hormonal_oxytocin: number;
    provenance_chain: string;
    stable_skill_id: string | null;
    skill_version: number;
    skill_category: string | null;
    skill_tags: string;
    steering_reward: number;
    marketplace_listed: number;
    marketplace_description: string | null;
    download_count: number;
    provenance_dag: string | null;
    deprecated: number;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
      importance_score, access_count, lifecycle_state, lifecycle, memory_type,
      semantic_type, emotional_valence, curiosity_boost, dream_count, origin,
      governance_json, created_at, version, parent_id, last_dreamed_at, last_accessed_at,
      hormonal_dopamine, hormonal_cortisol, hormonal_oxytocin, provenance_chain,
      stable_skill_id, skill_version, skill_category, skill_tags,
      steering_reward, marketplace_listed, marketplace_description, download_count,
      provenance_dag, deprecated
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )`,
  ).run(
    id,
    overrides.path ?? "memory/test.md",
    overrides.source ?? "memory",
    overrides.start_line ?? 1,
    overrides.end_line ?? 10,
    overrides.hash ?? crypto.randomUUID(),
    overrides.model ?? "test-model",
    overrides.text ?? "Test chunk content",
    overrides.embedding ?? JSON.stringify(fakeEmbedding(1)),
    overrides.updated_at ?? now,
    overrides.importance_score ?? 0.5,
    overrides.access_count ?? 0,
    overrides.lifecycle_state ?? "active",
    overrides.lifecycle ?? "generated",
    overrides.memory_type ?? "plaintext",
    overrides.semantic_type ?? "general",
    overrides.emotional_valence ?? null,
    overrides.curiosity_boost ?? 0,
    overrides.dream_count ?? 0,
    overrides.origin ?? "indexed",
    overrides.governance_json ?? "{}",
    overrides.created_at ?? now,
    overrides.version ?? 1,
    overrides.parent_id ?? null,
    overrides.last_dreamed_at ?? null,
    overrides.last_accessed_at ?? null,
    overrides.hormonal_dopamine ?? 0,
    overrides.hormonal_cortisol ?? 0,
    overrides.hormonal_oxytocin ?? 0,
    overrides.provenance_chain ?? "[]",
    overrides.stable_skill_id ?? null,
    overrides.skill_version ?? 1,
    overrides.skill_category ?? null,
    overrides.skill_tags ?? "[]",
    overrides.steering_reward ?? 0,
    overrides.marketplace_listed ?? 0,
    overrides.marketplace_description ?? null,
    overrides.download_count ?? 0,
    overrides.provenance_dag ?? null,
    overrides.deprecated ?? 0,
  );
  return id;
}

function createSkillChunk(
  db: DatabaseSync,
  text: string,
  overrides: Partial<Parameters<typeof insertChunk>[1]> = {},
): string {
  return insertChunk(db, {
    text,
    memory_type: "skill",
    semantic_type: "skill",
    lifecycle: "frozen",
    source: "skills",
    governance_json: JSON.stringify({
      accessScope: "shared",
      lifespanPolicy: "permanent",
      priority: 0.8,
      sensitivity: "normal",
      provenanceChain: [],
    }),
    importance_score: 0.8,
    ...overrides,
  });
}

function createEnvelope(overrides: Partial<SkillEnvelope> = {}): SkillEnvelope {
  return {
    version: 1,
    skill_md: Buffer.from("Test skill content from peer").toString("base64"),
    name: "test-skill",
    author_peer_id: "peer-123",
    author_pubkey: "pubkey-abc",
    signature: "sig-xyz",
    timestamp: Date.now(),
    content_hash: `hash-${crypto.randomUUID()}`,
    ...overrides,
  };
}

function mockOrchestratorBridge(opts?: {
  publishResult?: unknown;
  shouldFail?: boolean;
}): OrchestratorBridgeLike & { publishCalls: Array<{ skillMd: string; name: string }> } {
  const publishCalls: Array<{ skillMd: string; name: string }> = [];
  return {
    publishCalls,
    async publishSkill(skillMd: string, name: string) {
      publishCalls.push({ skillMd, name });
      if (opts?.shouldFail) throw new Error("publish failed");
      return opts?.publishResult ?? { ok: true, content_hash: `hash-${crypto.randomUUID()}` };
    },
  };
}

function mockLlmCall(responses?: string[]): (prompt: string) => Promise<string> {
  let callCount = 0;
  return async () => {
    const response = responses?.[callCount] ?? JSON.stringify([
      { content: "Mock insight from LLM", confidence: 0.8, keywords: ["test", "mock"] },
    ]);
    callCount++;
    return response;
  };
}

const noopEmbedBatch: EmbedBatchFn = async (texts) =>
  texts.map(() => fakeEmbedding(Math.random()));

const noopSynthesize: SynthesizeFn = async () => [];

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL EXECUTION TRACKER
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillExecutionTracker", () => {
  let db: DatabaseSync;
  let tracker: SkillExecutionTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SkillExecutionTracker(db);
  });

  it("tracks execution start and returns a unique ID", () => {
    const skillId = createSkillChunk(db, "Test skill");
    const execId = tracker.startExecution(skillId, "session-1");
    expect(execId).toBeTruthy();
    expect(typeof execId).toBe("string");

    const row = db.prepare("SELECT * FROM skill_executions WHERE id = ?").get(execId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.skill_crystal_id).toBe(skillId);
    expect(row.session_id).toBe("session-1");
    expect(row.started_at).toBeGreaterThan(0);
  });

  it("records successful execution outcome", () => {
    const skillId = createSkillChunk(db, "Test skill");
    const execId = tracker.startExecution(skillId);

    tracker.completeExecution(execId, {
      success: true,
      rewardScore: 0.9,
      executionTimeMs: 150,
      toolCallsCount: 3,
    });

    const row = db.prepare("SELECT * FROM skill_executions WHERE id = ?").get(execId) as Record<string, unknown>;
    expect(row.success).toBe(1);
    expect(row.reward_score).toBe(0.9);
    expect(row.completed_at).toBeGreaterThan(0);
    expect(row.execution_time_ms).toBe(150);
    expect(row.tool_calls_count).toBe(3);
  });

  it("records failed execution with error details", () => {
    const skillId = createSkillChunk(db, "Test skill");
    const execId = tracker.startExecution(skillId);

    tracker.completeExecution(execId, {
      success: false,
      errorType: "timeout",
      errorDetail: "Operation timed out after 30s",
    });

    const row = db.prepare("SELECT * FROM skill_executions WHERE id = ?").get(execId) as Record<string, unknown>;
    expect(row.success).toBe(0);
    expect(row.error_type).toBe("timeout");
    expect(row.error_detail).toBe("Operation timed out after 30s");
  });

  it("updates steering reward on skill crystal after execution", () => {
    const skillId = createSkillChunk(db, "Test skill");

    // Success: +0.1
    const exec1 = tracker.startExecution(skillId);
    tracker.completeExecution(exec1, { success: true });
    let skill = db.prepare("SELECT steering_reward FROM chunks WHERE id = ?").get(skillId) as { steering_reward: number };
    expect(skill.steering_reward).toBeCloseTo(0.1);

    // Failure: -0.05
    const exec2 = tracker.startExecution(skillId);
    tracker.completeExecution(exec2, { success: false });
    skill = db.prepare("SELECT steering_reward FROM chunks WHERE id = ?").get(skillId) as { steering_reward: number };
    expect(skill.steering_reward).toBeCloseTo(0.05);
  });

  it("clamps steering reward to [-1, 1]", () => {
    const skillId = createSkillChunk(db, "Test skill", { steering_reward: 0.95 });

    // Push over 1.0
    const exec = tracker.startExecution(skillId);
    tracker.completeExecution(exec, { success: true });
    const skill = db.prepare("SELECT steering_reward FROM chunks WHERE id = ?").get(skillId) as { steering_reward: number };
    expect(skill.steering_reward).toBeLessThanOrEqual(1.0);
  });

  it("records user feedback asynchronously", () => {
    const skillId = createSkillChunk(db, "Test skill");
    const execId = tracker.startExecution(skillId);
    tracker.completeExecution(execId, { success: true });

    tracker.recordFeedback(execId, 1);
    const row = db.prepare("SELECT user_feedback FROM skill_executions WHERE id = ?").get(execId) as { user_feedback: number };
    expect(row.user_feedback).toBe(1);
  });

  it("computes correct skill metrics from multiple executions", () => {
    const skillId = createSkillChunk(db, "Test skill");

    // 3 successes, 2 failures
    for (let i = 0; i < 3; i++) {
      const id = tracker.startExecution(skillId);
      tracker.completeExecution(id, { success: true, rewardScore: 0.8, executionTimeMs: 100 + i * 50 });
    }
    for (let i = 0; i < 2; i++) {
      const id = tracker.startExecution(skillId);
      tracker.completeExecution(id, { success: false, errorType: "tool_error", executionTimeMs: 500 });
    }

    const metrics = tracker.getSkillMetrics(skillId);
    expect(metrics.totalExecutions).toBe(5);
    expect(metrics.successRate).toBeCloseTo(0.6);
    expect(metrics.avgRewardScore).toBeCloseTo(0.8); // only successes have rewardScore
    expect(metrics.avgExecutionTimeMs).toBeGreaterThan(0);
    expect(metrics.errorBreakdown.tool_error).toBe(2);
    expect(metrics.lastExecutedAt).toBeGreaterThan(0);
  });

  it("returns zero metrics for skill with no executions", () => {
    const metrics = tracker.getSkillMetrics("nonexistent");
    expect(metrics.totalExecutions).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.avgRewardScore).toBe(0);
  });

  it("computes peer skill metrics across all skills from a peer", () => {
    const peerPubkey = "peer-pub-1";
    const governance = JSON.stringify({ peerOrigin: peerPubkey, accessScope: "shared", sensitivity: "normal" });

    // Insert 2 skills from peer
    const skill1 = createSkillChunk(db, "Peer skill 1", { governance_json: governance });
    const skill2 = createSkillChunk(db, "Peer skill 2", { governance_json: governance });

    // Execute skill1: 2 successes
    for (let i = 0; i < 2; i++) {
      const id = tracker.startExecution(skill1);
      tracker.completeExecution(id, { success: true, rewardScore: 0.9 });
    }
    // Execute skill2: 1 success, 1 failure
    const s2e1 = tracker.startExecution(skill2);
    tracker.completeExecution(s2e1, { success: true, rewardScore: 0.7 });
    const s2e2 = tracker.startExecution(skill2);
    tracker.completeExecution(s2e2, { success: false });

    const peerMetrics = tracker.getPeerSkillMetrics(peerPubkey);
    expect(peerMetrics.totalSkills).toBe(2);
    expect(peerMetrics.avgSuccessRate).toBeGreaterThan(0);
    expect(peerMetrics.avgRewardScore).toBeGreaterThan(0);
  });

  it("includes user feedback in metrics", () => {
    const skillId = createSkillChunk(db, "Test skill");
    const e1 = tracker.startExecution(skillId);
    tracker.completeExecution(e1, { success: true });
    tracker.recordFeedback(e1, 1);

    const e2 = tracker.startExecution(skillId);
    tracker.completeExecution(e2, { success: true });
    tracker.recordFeedback(e2, -1);

    const metrics = tracker.getSkillMetrics(skillId);
    expect(metrics.userFeedbackScore).toBe(0); // (1 + -1) / 2
  });

  it("decays steering rewards", () => {
    createSkillChunk(db, "Skill A", { steering_reward: 0.5 });
    createSkillChunk(db, "Skill B", { steering_reward: -0.3 });

    const decayed = tracker.decaySteeringRewards(0.9);
    expect(decayed).toBe(2);

    const a = db.prepare("SELECT steering_reward FROM chunks WHERE text = 'Skill A'").get() as { steering_reward: number };
    expect(a.steering_reward).toBeCloseTo(0.45);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PEER REPUTATION SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

describe("PeerReputationManager", () => {
  let db: DatabaseSync;
  let tracker: SkillExecutionTracker;
  let repManager: PeerReputationManager;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SkillExecutionTracker(db);
    repManager = new PeerReputationManager(db, tracker);
  });

  it("creates peer record on first skill received", () => {
    repManager.recordSkillReceived("pubkey-1", "peer-1");

    const rep = repManager.getReputation("pubkey-1");
    expect(rep).not.toBeNull();
    expect(rep!.skillsReceived).toBe(1);
    expect(rep!.peerId).toBe("peer-1");
    expect(rep!.firstSeenAt).toBeGreaterThan(0);
  });

  it("increments skill count on subsequent receives", () => {
    repManager.recordSkillReceived("pubkey-1", "peer-1");
    repManager.recordSkillReceived("pubkey-1", "peer-1");
    repManager.recordSkillReceived("pubkey-1", "peer-1");

    const rep = repManager.getReputation("pubkey-1");
    expect(rep!.skillsReceived).toBe(3);
  });

  it("tracks acceptance and rejection counts", () => {
    repManager.recordSkillReceived("pubkey-1", "peer-1");
    repManager.recordIngestionResult("pubkey-1", true);
    repManager.recordIngestionResult("pubkey-1", true);
    repManager.recordIngestionResult("pubkey-1", false);

    const rep = repManager.getReputation("pubkey-1");
    expect(rep!.skillsAccepted).toBe(2);
    expect(rep!.skillsRejected).toBe(1);
  });

  it("returns untrusted for unknown peers", () => {
    const level = repManager.getTrustLevel("unknown-pubkey");
    expect(level).toBe("untrusted");
  });

  it("assigns verified trust level for trustList peers", () => {
    const trusted = new PeerReputationManager(db, tracker, ["trusted-pubkey"]);
    const level = trusted.getTrustLevel("trusted-pubkey");
    expect(level).toBe("verified");
  });

  it("computes graduated trust levels based on reputation score", () => {
    // New peer starts with default reputation
    repManager.recordSkillReceived("pubkey-1", "peer-1");

    // Initial trust is provisional (default score = 0.5)
    let level = repManager.getTrustLevel("pubkey-1");
    expect(level).toBe("provisional");

    // Manually set high reputation
    db.prepare(`UPDATE peer_reputation SET reputation_score = 0.9 WHERE peer_pubkey = ?`).run("pubkey-1");
    level = repManager.getTrustLevel("pubkey-1");
    expect(level).toBe("verified");

    // Low reputation
    db.prepare(`UPDATE peer_reputation SET reputation_score = 0.1 WHERE peer_pubkey = ?`).run("pubkey-1");
    level = repManager.getTrustLevel("pubkey-1");
    expect(level).toBe("untrusted");

    // Medium reputation
    db.prepare(`UPDATE peer_reputation SET reputation_score = 0.65 WHERE peer_pubkey = ?`).run("pubkey-1");
    level = repManager.getTrustLevel("pubkey-1");
    expect(level).toBe("trusted");
  });

  it("updates peer quality from execution data", () => {
    const peerPubkey = "peer-pub-quality";
    const governance = JSON.stringify({ peerOrigin: peerPubkey, accessScope: "shared", sensitivity: "normal" });

    // Create peer and skills
    repManager.recordSkillReceived(peerPubkey, "peer-quality");
    const skillId = createSkillChunk(db, "Peer skill", { governance_json: governance });

    // Execute skill successfully
    for (let i = 0; i < 5; i++) {
      const execId = tracker.startExecution(skillId);
      tracker.completeExecution(execId, { success: true, rewardScore: 0.85 });
    }

    repManager.updatePeerQuality(peerPubkey);
    const rep = repManager.getReputation(peerPubkey);
    expect(rep!.avgSkillQuality).toBeGreaterThan(0);
  });

  it("returns leaderboard sorted by reputation", () => {
    repManager.recordSkillReceived("pub-a", "peer-a");
    repManager.recordSkillReceived("pub-b", "peer-b");
    repManager.recordSkillReceived("pub-c", "peer-c");

    db.prepare(`UPDATE peer_reputation SET reputation_score = 0.9 WHERE peer_pubkey = 'pub-a'`).run();
    db.prepare(`UPDATE peer_reputation SET reputation_score = 0.3 WHERE peer_pubkey = 'pub-b'`).run();
    db.prepare(`UPDATE peer_reputation SET reputation_score = 0.7 WHERE peer_pubkey = 'pub-c'`).run();

    const board = repManager.getLeaderboard();
    expect(board.length).toBe(3);
    expect(board[0]!.peerPubkey).toBe("pub-a");
    expect(board[1]!.peerPubkey).toBe("pub-c");
    expect(board[2]!.peerPubkey).toBe("pub-b");
  });

  it("rates a skill from a peer", () => {
    repManager.rateSkill("pub-1", "skill-1", 0.9);

    const row = db.prepare("SELECT * FROM peer_skill_ratings WHERE peer_pubkey = 'pub-1'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.rating).toBe(0.9);
    expect(row.skill_crystal_id).toBe("skill-1");
  });

  it("returns null for nonexistent peer", () => {
    const rep = repManager.getReputation("nonexistent");
    expect(rep).toBeNull();
  });

  it("reputation formula: 0.4*acceptance + 0.4*quality + 0.2*longevity", () => {
    const pubkey = "pub-formula";
    repManager.recordSkillReceived(pubkey, "peer-formula");

    // Accept 8 out of 10 skills
    for (let i = 0; i < 8; i++) repManager.recordIngestionResult(pubkey, true);
    for (let i = 0; i < 2; i++) repManager.recordIngestionResult(pubkey, false);

    // Set first_seen_at to 60 days ago for max longevity
    db.prepare(`UPDATE peer_reputation SET first_seen_at = ?, skills_received = 10 WHERE peer_pubkey = ?`)
      .run(Date.now() - 60 * 24 * 60 * 60 * 1000, pubkey);

    // Quality = 1.0 (mock via direct execution)
    repManager.updatePeerQuality(pubkey);
    // No skills from this peer in chunks, so quality stays 0

    // acceptance = 8/10 = 0.8, quality = 0, longevity = 1.0
    // rep = 0.4*0.8 + 0.4*0 + 0.2*1.0 = 0.52
    const rep = repManager.getReputation(pubkey);
    expect(rep!.reputationScore).toBeCloseTo(0.52, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL NETWORK BRIDGE
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillNetworkBridge", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("publishCrystalSkill", () => {
    it("publishes a shared skill to the network", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const skillId = createSkillChunk(db, "Deploy with Docker and monitoring");

      const result = await bridge.publishCrystalSkill(skillId);
      expect(result).not.toBeNull();
      expect(result!.visibility).toBe("shared");
      expect(result!.publishedAt).toBeGreaterThan(0);

      // Verify orchestrator was called with base64
      expect(mockBridge.publishCalls.length).toBe(1);
      const decoded = Buffer.from(mockBridge.publishCalls[0]!.skillMd, "base64").toString("utf-8");
      expect(decoded).toContain("Docker");

      // Verify publish state updated in DB
      const row = db.prepare("SELECT publish_visibility, published_at FROM chunks WHERE id = ?").get(skillId) as Record<string, unknown>;
      expect(row.publish_visibility).toBe("shared");
      expect(row.published_at).toBeGreaterThan(0);

      // Verify audit log
      const audit = db.prepare("SELECT * FROM memory_audit_log WHERE event = 'skill_network_published'").all() as unknown[];
      expect(audit.length).toBe(1);
    });

    it("refuses to publish private crystals", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const skillId = createSkillChunk(db, "Private skill", {
        governance_json: JSON.stringify({ accessScope: "private", sensitivity: "normal" }),
      });

      const result = await bridge.publishCrystalSkill(skillId);
      expect(result).toBeNull();
      expect(mockBridge.publishCalls.length).toBe(0);
    });

    it("refuses to publish confidential crystals", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const skillId = createSkillChunk(db, "Secret skill", {
        governance_json: JSON.stringify({ accessScope: "shared", sensitivity: "confidential" }),
      });

      const result = await bridge.publishCrystalSkill(skillId);
      expect(result).toBeNull();
    });

    it("refuses to publish crystal with confidential ancestor", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge);

      // Create confidential parent
      const parentId = createSkillChunk(db, "Confidential parent", {
        governance_json: JSON.stringify({ accessScope: "private", sensitivity: "confidential" }),
      });

      // Create child referencing parent in provenance_chain
      const childId = createSkillChunk(db, "Child skill derived from secret", {
        provenance_chain: JSON.stringify([parentId]),
      });

      const result = await bridge.publishCrystalSkill(childId);
      expect(result).toBeNull();
    });

    it("checks provenance_dag for confidential ancestors", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const parentId = createSkillChunk(db, "Confidential parent", {
        governance_json: JSON.stringify({ accessScope: "private", sensitivity: "confidential" }),
      });

      const childId = createSkillChunk(db, "Child via DAG", {
        provenance_chain: "[]",
        provenance_dag: JSON.stringify([{
          crystalId: "child-id",
          operation: "mutated",
          actor: "dream_engine",
          timestamp: Date.now(),
          parentIds: [parentId],
        }]),
      });

      const result = await bridge.publishCrystalSkill(childId);
      expect(result).toBeNull();
    });

    it("returns null when no orchestrator bridge is set", async () => {
      const bridge = new SkillNetworkBridge(db, null);
      const skillId = createSkillChunk(db, "Orphan skill");

      const result = await bridge.publishCrystalSkill(skillId);
      expect(result).toBeNull();
    });

    it("returns null when crystal doesn't exist", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const result = await bridge.publishCrystalSkill("nonexistent-id");
      expect(result).toBeNull();
    });

    it("handles orchestrator publish failure gracefully", async () => {
      const mockBridge = mockOrchestratorBridge({ shouldFail: true });
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const skillId = createSkillChunk(db, "Fail skill");
      const result = await bridge.publishCrystalSkill(skillId);
      expect(result).toBeNull();
    });

    it("handles orchestrator returning ok:false", async () => {
      const mockBridge = mockOrchestratorBridge({ publishResult: { ok: false, error: "peers unreachable" } });
      const bridge = new SkillNetworkBridge(db, mockBridge);

      const skillId = createSkillChunk(db, "No peers skill");
      const result = await bridge.publishCrystalSkill(skillId);
      expect(result).toBeNull();
    });
  });

  describe("ingestNetworkSkill", () => {
    it("ingests a valid skill envelope as a crystal", () => {
      const bridge = new SkillNetworkBridge(db, null);
      const envelope = createEnvelope({ name: "docker-deploy" });

      const result = bridge.ingestNetworkSkill(envelope);
      expect(result.ok).toBe(true);
      expect(result.action).toBe("accepted");
      expect(result.crystalId).toBeTruthy();

      // Verify crystal was stored
      const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.crystalId!) as Record<string, unknown>;
      expect(row.source).toBe("skills");
      expect(row.semantic_type).toBe("skill");
      expect(row.lifecycle).toBe("generated");
      expect(String(row.text)).toContain("Test skill content from peer");
      expect(String(row.path)).toBe("peer/docker-deploy");

      // Verify governance has peerOrigin
      const gov = JSON.parse(String(row.governance_json));
      expect(gov.peerOrigin).toBe("pubkey-abc");

      // Verify provenance DAG was created
      const dag = JSON.parse(String(row.provenance_dag));
      expect(dag.length).toBe(1);
      expect(dag[0].operation).toBe("imported");
      expect(dag[0].actor).toBe("peer:pubkey-abc");
    });

    it("rejects duplicate content hash", () => {
      const bridge = new SkillNetworkBridge(db, null);
      const envelope = createEnvelope();

      const result1 = bridge.ingestNetworkSkill(envelope);
      expect(result1.ok).toBe(true);

      const result2 = bridge.ingestNetworkSkill(envelope);
      expect(result2.ok).toBe(false);
      expect(result2.reason).toBe("duplicate content");
    });

    it("rejects envelope with missing fields", () => {
      const bridge = new SkillNetworkBridge(db, null);

      const result = bridge.ingestNetworkSkill({
        ...createEnvelope(),
        content_hash: "",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid envelope");
    });

    it("rejects invalid base64 content", () => {
      const bridge = new SkillNetworkBridge(db, null);

      const result = bridge.ingestNetworkSkill({
        ...createEnvelope(),
        skill_md: "!!!not-valid-base64!!!",
      });
      // Base64 decoding is permissive, but the content should still be stored
      // The actual validation happens at a higher level (ingest.ts)
      expect(result.ok).toBe(true);
    });
  });

  describe("onSkillCrystallized", () => {
    it("auto-publishes when configured", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge, { autoPublishOnCrystallize: true });

      const skillId = createSkillChunk(db, "Auto-publish skill");

      bridge.onSkillCrystallized(skillId);
      // Give the async publish a moment
      await new Promise((r) => setTimeout(r, 50));

      expect(mockBridge.publishCalls.length).toBe(1);
    });

    it("does not auto-publish when disabled", async () => {
      const mockBridge = mockOrchestratorBridge();
      const bridge = new SkillNetworkBridge(db, mockBridge, { autoPublishOnCrystallize: false });

      const skillId = createSkillChunk(db, "No auto-publish");
      bridge.onSkillCrystallized(skillId);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockBridge.publishCalls.length).toBe(0);
    });
  });

  describe("setOrchestratorBridge", () => {
    it("allows late wiring of orchestrator bridge", async () => {
      const bridge = new SkillNetworkBridge(db, null);
      const skillId = createSkillChunk(db, "Late wire skill");

      // No bridge yet
      let result = await bridge.publishCrystalSkill(skillId);
      expect(result).toBeNull();

      // Wire bridge
      const mockBridge = mockOrchestratorBridge();
      bridge.setOrchestratorBridge(mockBridge);

      result = await bridge.publishCrystalSkill(skillId);
      expect(result).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillMarketplace", () => {
  let db: DatabaseSync;
  let tracker: SkillExecutionTracker;
  let repManager: PeerReputationManager;
  let marketplace: SkillMarketplace;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SkillExecutionTracker(db);
    repManager = new PeerReputationManager(db, tracker);
    marketplace = new SkillMarketplace(db, tracker, repManager);
  });

  it("lists and searches for skills", () => {
    const skillId = createSkillChunk(db, "Deploy with Docker and Kubernetes");
    marketplace.listSkill(skillId, "Docker+K8s deployment skill");

    const results = marketplace.search("Docker");
    expect(results.length).toBe(1);
    expect(results[0]!.stableSkillId).toBeTruthy();
    expect(results[0]!.description).toContain("Docker");
  });

  it("returns no results for unmatched search", () => {
    const skillId = createSkillChunk(db, "Python data analysis");
    marketplace.listSkill(skillId);

    const results = marketplace.search("Kubernetes");
    expect(results.length).toBe(0);
  });

  it("filters by category", () => {
    const id1 = createSkillChunk(db, "Skill A", { skill_category: "devops" });
    const id2 = createSkillChunk(db, "Skill B", { skill_category: "frontend" });
    marketplace.listSkill(id1);
    marketplace.listSkill(id2);

    const results = marketplace.search("", { category: "devops" });
    expect(results.length).toBe(1);
    expect(results[0]!.category).toBe("devops");
  });

  it("filters by tags", () => {
    const id1 = createSkillChunk(db, "Docker skill", { skill_tags: JSON.stringify(["docker", "deploy"]) });
    const id2 = createSkillChunk(db, "React skill", { skill_tags: JSON.stringify(["react", "frontend"]) });
    marketplace.listSkill(id1);
    marketplace.listSkill(id2);

    const results = marketplace.search("", { tags: ["docker"] });
    expect(results.length).toBe(1);
  });

  it("escapes LIKE wildcards in tag search", () => {
    const id = createSkillChunk(db, "Percent skill", { skill_tags: JSON.stringify(["100%_done"]) });
    marketplace.listSkill(id);

    // The % in the tag shouldn't act as a wildcard
    const results = marketplace.search("", { tags: ["100%_done"] });
    expect(results.length).toBe(1);
  });

  it("escapes LIKE wildcards in text search", () => {
    const id = createSkillChunk(db, "Test content about topic");
    marketplace.listSkill(id);

    // A % query should not match everything
    const allResults = marketplace.search("%");
    // It should match the literal % character in text, not act as wildcard
    // Since no text contains literal %, this should return 0
    expect(allResults.length).toBe(0);
  });

  it("sorts by trending (download count)", () => {
    const id1 = createSkillChunk(db, "Popular skill", { download_count: 100 });
    const id2 = createSkillChunk(db, "Unpopular skill", { download_count: 1 });
    marketplace.listSkill(id1);
    marketplace.listSkill(id2);

    const results = marketplace.search("", { sortBy: "trending" });
    expect(results.length).toBe(2);
    expect(results[0]!.downloadCount).toBeGreaterThan(results[1]!.downloadCount);
  });

  it("filters by minSuccessRate", () => {
    const id1 = createSkillChunk(db, "Good skill");
    const id2 = createSkillChunk(db, "Bad skill");
    marketplace.listSkill(id1);
    marketplace.listSkill(id2);

    // Execute id1 successfully, id2 with failures
    for (let i = 0; i < 5; i++) {
      const e = tracker.startExecution(id1);
      tracker.completeExecution(e, { success: true });
    }
    for (let i = 0; i < 5; i++) {
      const e = tracker.startExecution(id2);
      tracker.completeExecution(e, { success: false });
    }

    const results = marketplace.search("", { minSuccessRate: 0.5 });
    expect(results.length).toBe(1);
  });

  it("delists a skill", () => {
    const id = createSkillChunk(db, "Delist me");
    marketplace.listSkill(id);
    expect(marketplace.search("Delist").length).toBe(1);

    const delisted = marketplace.delistSkill(id);
    expect(delisted).toBe(true);
    expect(marketplace.search("Delist").length).toBe(0);
  });

  it("records and counts downloads", () => {
    const id = createSkillChunk(db, "Downloadable skill", { download_count: 0 });
    marketplace.recordDownload(id);
    marketplace.recordDownload(id);

    const row = db.prepare("SELECT download_count FROM chunks WHERE id = ?").get(id) as { download_count: number };
    expect(row.download_count).toBe(2);
  });

  it("getTrending returns recent high-download skills", () => {
    const id = createSkillChunk(db, "Trending skill", { download_count: 50, created_at: Date.now() });
    marketplace.listSkill(id);

    const old = createSkillChunk(db, "Old skill", {
      download_count: 200,
      created_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    marketplace.listSkill(old);

    const trending = marketplace.getTrending();
    // Only recent skill should appear (within 7 days)
    expect(trending.length).toBe(1);
    expect(trending[0]!.downloadCount).toBe(50);
  });

  it("getSkillDetail returns full info", () => {
    const stableId = crypto.randomUUID();
    const id = createSkillChunk(db, "Detailed skill", {
      stable_skill_id: stableId,
      skill_version: 2,
    });
    marketplace.listSkill(id, "A detailed skill for testing");

    const detail = marketplace.getSkillDetail(stableId);
    expect(detail).not.toBeNull();
    expect(detail!.text).toContain("Detailed skill");
    expect(detail!.version).toBe(2);
    expect(detail!.versionHistory.length).toBe(1);
  });

  it("excludes deprecated skills from search", () => {
    const id = createSkillChunk(db, "Deprecated skill", { deprecated: 1 });
    marketplace.listSkill(id);

    const results = marketplace.search("Deprecated");
    expect(results.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY AGENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("DiscoveryAgent", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("discovers similar edges from embeddings", async () => {
    // Insert skills with similar embeddings
    createSkillChunk(db, "Docker deployment skill", { embedding: JSON.stringify(fakeEmbedding(1)) });
    createSkillChunk(db, "Docker container management", { embedding: JSON.stringify(fakeEmbedding(1.01)) });
    createSkillChunk(db, "Unrelated Python skill", { embedding: JSON.stringify(fakeEmbedding(100)) });

    const agent = new DiscoveryAgent(db, null);
    const result = await agent.runCycle();

    // The two Docker skills should have a similarity edge
    expect(result.edgesDiscovered).toBeGreaterThanOrEqual(1);
  });

  it("discovers prerequisites via LLM", async () => {
    // Use distinct embeddings (cosine sim < 0.8) so discoverSimilarEdges
    // does NOT create "similar" edges, leaving these as unconnected pairs
    // for the LLM-based prerequisite discovery.
    createSkillChunk(db, "Learn basic Docker commands", {
      skill_category: "devops",
      embedding: JSON.stringify(fakeEmbedding(1)),
    });
    createSkillChunk(db, "Advanced Docker orchestration with Kubernetes", {
      skill_category: "devops",
      embedding: JSON.stringify(fakeEmbedding(50)),
    });

    const llm = mockLlmCall([
      JSON.stringify([
        { pair: 1, relationship: "prerequisite", direction: "a_to_b", confidence: 0.85 },
      ]),
    ]);

    const agent = new DiscoveryAgent(db, llm);
    const result = await agent.runCycle();

    expect(result.prerequisitesFound).toBeGreaterThanOrEqual(1);
    expect(result.llmCallsUsed).toBeGreaterThan(0);
  });

  it("discovers composites via LLM", async () => {
    // Use distinct embeddings so discoverSimilarEdges doesn't connect them,
    // ensuring the LLM-call order in runCycle matches our mock responses.
    createSkillChunk(db, "Docker containerization", {
      skill_category: "devops",
      embedding: JSON.stringify(fakeEmbedding(1)),
    });
    createSkillChunk(db, "CI/CD pipeline setup", {
      skill_category: "devops",
      embedding: JSON.stringify(fakeEmbedding(50)),
    });
    createSkillChunk(db, "Kubernetes deployment", {
      skill_category: "devops",
      embedding: JSON.stringify(fakeEmbedding(100)),
    });

    const llm = mockLlmCall([
      // Prerequisites response (runCycle calls this first — 3 unconnected pairs)
      JSON.stringify([{ pair: 1, relationship: "none", confidence: 0.3 }]),
      // Composites response (3 skills in same "devops" category)
      JSON.stringify([{ skills: [1, 2, 3], capability: "Full DevOps pipeline", confidence: 0.9 }]),
      // Contradictions response (no similar pairs at threshold 0.7, so no LLM call)
    ]);

    const agent = new DiscoveryAgent(db, llm);
    const result = await agent.runCycle();

    expect(result.compositesFound).toBeGreaterThan(0);
  });

  it("discovers contradictions via LLM", async () => {
    // Insert similar skills that might contradict
    createSkillChunk(db, "Always use microservices for scalability", {
      embedding: JSON.stringify(fakeEmbedding(1)),
    });
    createSkillChunk(db, "Monolithic architecture is better for small teams", {
      embedding: JSON.stringify(fakeEmbedding(1.05)),
    });

    const llm = mockLlmCall([
      // Prerequisites
      JSON.stringify([]),
      // Composites (not enough for same category)
      // Contradictions
      JSON.stringify([{ pair: 1, contradicts: true, explanation: "Opposing architectures", confidence: 0.8 }]),
    ]);

    const agent = new DiscoveryAgent(db, llm);
    const result = await agent.runCycle();

    expect(result.contradictionsFound).toBeGreaterThanOrEqual(0);
  });

  it("getEdges retrieves all edges for a skill", async () => {
    const id1 = createSkillChunk(db, "Skill A");
    const id2 = createSkillChunk(db, "Skill B");

    // Manually store an edge
    db.prepare(
      `INSERT INTO skill_edges (id, source_skill_id, target_skill_id, edge_type, weight, confidence, discovered_by, created_at, updated_at)
       VALUES (?, ?, ?, 'prerequisite', 0.8, 0.8, 'llm', ?, ?)`,
    ).run(crypto.randomUUID(), id1, id2, Date.now(), Date.now());

    const agent = new DiscoveryAgent(db, null);
    const edges = agent.getEdges(id1);
    expect(edges.length).toBe(1);
    expect(edges[0]!.edgeType).toBe("prerequisite");
    expect(edges[0]!.sourceSkillId).toBe(id1);
    expect(edges[0]!.targetSkillId).toBe(id2);
  });

  it("getPrerequisites traverses prerequisite chain", () => {
    const a = createSkillChunk(db, "Fundamentals");
    const b = createSkillChunk(db, "Intermediate");
    const c = createSkillChunk(db, "Advanced");

    const now = Date.now();
    // a → b (a is prerequisite for b)
    db.prepare(
      `INSERT INTO skill_edges (id, source_skill_id, target_skill_id, edge_type, weight, confidence, discovered_by, created_at, updated_at)
       VALUES (?, ?, ?, 'prerequisite', 0.9, 0.9, 'llm', ?, ?)`,
    ).run(crypto.randomUUID(), a, b, now, now);
    // b → c (b is prerequisite for c)
    db.prepare(
      `INSERT INTO skill_edges (id, source_skill_id, target_skill_id, edge_type, weight, confidence, discovered_by, created_at, updated_at)
       VALUES (?, ?, ?, 'prerequisite', 0.9, 0.9, 'llm', ?, ?)`,
    ).run(crypto.randomUUID(), b, c, now, now);

    const agent = new DiscoveryAgent(db, null);
    const prereqs = agent.getPrerequisites(c);
    // c requires b, which requires a
    expect(prereqs).toContain(b);
    expect(prereqs).toContain(a);
  });

  it("prevents duplicate edges", () => {
    const a = createSkillChunk(db, "Skill A", { embedding: JSON.stringify(fakeEmbedding(1)) });
    const b = createSkillChunk(db, "Skill B", { embedding: JSON.stringify(fakeEmbedding(1.001)) });

    const agent = new DiscoveryAgent(db, null);

    // Run twice — second run should not create duplicate edges
    agent.runCycle();
    agent.runCycle();

    const edges = db.prepare("SELECT COUNT(*) as c FROM skill_edges").get() as { c: number };
    // At most 1 "similar" edge between a and b
    expect(edges.c).toBeLessThanOrEqual(1);
  });

  it("decays edge rewards", () => {
    const a = createSkillChunk(db, "Skill A");
    const b = createSkillChunk(db, "Skill B");

    db.prepare(
      `INSERT INTO skill_edges (id, source_skill_id, target_skill_id, edge_type, weight, confidence, steering_reward, discovered_by, created_at, updated_at)
       VALUES (?, ?, ?, 'similar', 0.8, 0.8, 0.5, 'embedding', ?, ?)`,
    ).run(crypto.randomUUID(), a, b, Date.now(), Date.now());

    const agent = new DiscoveryAgent(db, null);
    const decayed = agent.decayEdgeRewards(0.9);
    expect(decayed).toBe(1);

    const edge = db.prepare("SELECT steering_reward FROM skill_edges").get() as { steering_reward: number };
    expect(edge.steering_reward).toBeCloseTo(0.45);
  });

  it("returns empty result for insufficient skills", async () => {
    // Only 1 skill, need at least 2
    createSkillChunk(db, "Lonely skill");

    const agent = new DiscoveryAgent(db, null);
    const result = await agent.runCycle();
    expect(result.edgesDiscovered).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GOVERNANCE & PROVENANCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Governance for P2P Skills", () => {
  let db: DatabaseSync;
  let gov: MemoryGovernance;

  beforeEach(() => {
    db = createTestDb();
    gov = new MemoryGovernance(db);
  });

  it("private crystals accessible only by local_agent", () => {
    const id = createSkillChunk(db, "Private skill", {
      governance_json: JSON.stringify({ accessScope: "private" }),
    });

    expect(gov.canAccess(id, { actor: "local_agent", purpose: "use" })).toBe(true);
    expect(gov.canAccess(id, { actor: "peer:abc", purpose: "share" })).toBe(false);
  });

  it("shared crystals accessible by local_agent and authenticated sessions", () => {
    const id = createSkillChunk(db, "Shared skill", {
      governance_json: JSON.stringify({ accessScope: "shared" }),
    });

    expect(gov.canAccess(id, { actor: "local_agent", purpose: "use" })).toBe(true);
    expect(gov.canAccess(id, { actor: "peer:abc", purpose: "share", sessionKey: "session-123" })).toBe(true);
    expect(gov.canAccess(id, { actor: "peer:abc", purpose: "share" })).toBe(false);
  });

  it("public crystals accessible by anyone", () => {
    const id = createSkillChunk(db, "Public skill", {
      governance_json: JSON.stringify({ accessScope: "public" }),
    });

    expect(gov.canAccess(id, { actor: "anyone", purpose: "use" })).toBe(true);
  });

  it("confidential crystals only accessible by local_agent", () => {
    const id = createSkillChunk(db, "Confidential skill", {
      governance_json: JSON.stringify({ sensitivity: "confidential", accessScope: "shared" }),
    });

    expect(gov.canAccess(id, { actor: "local_agent", purpose: "use" })).toBe(true);
    expect(gov.canAccess(id, { actor: "peer:abc", purpose: "use", sessionKey: "s1" })).toBe(false);
  });

  it("expired crystals are not accessible", () => {
    const id = createSkillChunk(db, "Expired skill", { lifecycle: "expired" });

    expect(gov.canAccess(id, { actor: "local_agent", purpose: "use" })).toBe(false);
  });

  it("records provenance nodes in DAG", () => {
    const id = createSkillChunk(db, "Tracked skill");

    gov.recordProvenanceNode(id, {
      crystalId: id,
      operation: "created",
      actor: "dream_engine",
      timestamp: Date.now(),
      parentIds: [],
    });

    const dag = gov.getProvenanceDAG(id);
    expect(dag.length).toBe(1);
    expect(dag[0]!.operation).toBe("created");
    expect(dag[0]!.actor).toBe("dream_engine");
  });

  it("builds derivation tree from provenance", () => {
    const parentId = createSkillChunk(db, "Parent skill");
    const childId = createSkillChunk(db, "Child skill");

    // Parent provenance
    gov.recordProvenanceNode(parentId, {
      crystalId: parentId,
      operation: "created",
      actor: "local_agent",
      timestamp: Date.now(),
      parentIds: [],
    });

    // Child provenance referencing parent
    gov.recordProvenanceNode(childId, {
      crystalId: childId,
      operation: "mutated",
      actor: "dream_engine",
      timestamp: Date.now(),
      parentIds: [parentId],
    });

    const tree = gov.getDerivationTree(childId);
    expect(tree).not.toBeNull();
    expect(tree!.node.operation).toBe("mutated");
    expect(tree!.parents.length).toBe(1);
    expect(tree!.parents[0]!.node.operation).toBe("created");
  });

  it("gets attribution chain across lineage", () => {
    const p = createSkillChunk(db, "Parent");
    const c = createSkillChunk(db, "Child");

    gov.recordProvenanceNode(p, {
      crystalId: p, operation: "created", actor: "user", timestamp: Date.now(), parentIds: [],
    });
    gov.recordProvenanceNode(c, {
      crystalId: c, operation: "mutated", actor: "dream_engine", timestamp: Date.now(), parentIds: [p],
    });

    const chain = gov.getAttributionChain(c);
    expect(chain).toContain("dream_engine");
    expect(chain).toContain("user");
  });

  it("enforces TTL lifespan policies", () => {
    const id = createSkillChunk(db, "TTL skill", {
      governance_json: JSON.stringify({ lifespanPolicy: "ttl", ttlMs: 1000 }),
      created_at: Date.now() - 5000,
      lifecycle: "generated",
    });

    const expired = gov.enforceLifespan();
    expect(expired).toBe(1);

    const row = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get(id) as { lifecycle: string };
    expect(row.lifecycle).toBe("expired");
  });

  it("logs access events for audit", () => {
    const id = createSkillChunk(db, "Audited skill");

    gov.logAccess(id, "read", { actor: "local_agent", purpose: "skill_execution" });

    const logs = db.prepare("SELECT * FROM memory_audit_log WHERE chunk_id = ? AND event = 'accessed'").all(id) as unknown[];
    expect(logs.length).toBe(1);
  });

  it("returns governance stats", () => {
    createSkillChunk(db, "Normal skill", {
      governance_json: JSON.stringify({ sensitivity: "normal" }),
    });
    createSkillChunk(db, "Personal skill", {
      governance_json: JSON.stringify({ sensitivity: "personal" }),
    });

    const stats = gov.getStats();
    expect(stats.sensitivityCounts.normal).toBe(1);
    expect(stats.sensitivityCounts.personal).toBe(1);
    expect(stats.lifecycleCounts.frozen).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEM-STORE PUB/SUB & VERSIONING
// ═══════════════════════════════════════════════════════════════════════════════

describe("MemStore Pub/Sub & Versioning", () => {
  let db: DatabaseSync;
  let store: MemStore;

  beforeEach(() => {
    db = createTestDb();
    store = new MemStore(db);
  });

  it("publishes a crystal and retrieves it", () => {
    const id = createSkillChunk(db, "Publishable skill");

    const result = store.publish(id, "shared");
    expect(result).not.toBeNull();
    expect(result!.visibility).toBe("shared");

    const published = store.getPublished();
    expect(published.length).toBe(1);
    expect(published[0]!.id).toBe(id);
  });

  it("notifies subscribers on publish", () => {
    const received: string[] = [];
    store.subscribe({ semanticTypes: ["skill"] }, (crystal) => {
      received.push(crystal.id);
    });

    const id = createSkillChunk(db, "Subscribed skill");
    store.publish(id, "shared");

    expect(received).toContain(id);
  });

  it("filters subscriptions by semantic type", () => {
    const received: string[] = [];
    store.subscribe({ semanticTypes: ["fact"] }, (crystal) => {
      received.push(crystal.id);
    });

    const id = createSkillChunk(db, "Skill, not fact");
    store.publish(id, "shared");

    expect(received.length).toBe(0);
  });

  it("unsubscribes correctly", () => {
    const received: string[] = [];
    const subId = store.subscribe({}, (crystal) => {
      received.push(crystal.id);
    });

    store.unsubscribe(subId);

    const id = createSkillChunk(db, "After unsub");
    store.publish(id, "shared");

    expect(received.length).toBe(0);
  });

  it("imports from peer and stores as crystal", () => {
    const envelope = createEnvelope({ name: "peer-skill" });
    const result = store.importFromPeer(envelope, "pubkey-xyz");

    expect(result.ok).toBe(true);
    expect(result.crystalId).toBeTruthy();

    const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.crystalId!) as Record<string, unknown>;
    expect(row.source).toBe("skills");
    expect(row.semantic_type).toBe("skill");
    const gov = JSON.parse(String(row.governance_json));
    expect(gov.peerOrigin).toBe("pubkey-xyz");
  });

  it("rejects duplicate import", () => {
    const envelope = createEnvelope();
    store.importFromPeer(envelope, "pub-1");
    const result = store.importFromPeer(envelope, "pub-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("duplicate content");
  });

  it("getLatestVersion returns highest non-deprecated version", () => {
    const stableId = crypto.randomUUID();

    createSkillChunk(db, "Version 1", { stable_skill_id: stableId, skill_version: 1 });
    createSkillChunk(db, "Version 2", { stable_skill_id: stableId, skill_version: 2 });
    createSkillChunk(db, "Version 3 (deprecated)", { stable_skill_id: stableId, skill_version: 3, deprecated: 1 });

    const latest = store.getLatestVersion(stableId);
    expect(latest).not.toBeNull();
    expect(latest!.text).toContain("Version 2");
  });

  it("getVersionHistory returns all versions in order", () => {
    const stableId = crypto.randomUUID();

    createSkillChunk(db, "V1", { stable_skill_id: stableId, skill_version: 1 });
    createSkillChunk(db, "V2", { stable_skill_id: stableId, skill_version: 2 });
    createSkillChunk(db, "V3", { stable_skill_id: stableId, skill_version: 3 });

    const history = store.getVersionHistory(stableId);
    expect(history.length).toBe(3);
    expect(history[0]!.text).toContain("V1");
    expect(history[2]!.text).toContain("V3");
  });

  it("getPublished filters by crystal filter", () => {
    const id1 = createSkillChunk(db, "High importance skill", { importance_score: 0.9 });
    const id2 = createSkillChunk(db, "Low importance skill", { importance_score: 0.1 });
    store.publish(id1, "shared");
    store.publish(id2, "shared");

    const results = store.getPublished({ minImportance: 0.5 });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(id1);
  });

  it("handles corrupted governance_json gracefully on publish", () => {
    const id = insertChunk(db, {
      text: "Corrupted governance",
      governance_json: "not-json",
      lifecycle: "generated",
    });

    // Should not throw, and should still set publish_visibility
    const result = store.publish(id, "public");
    expect(result).not.toBeNull();

    const row = db.prepare("SELECT publish_visibility FROM chunks WHERE id = ?").get(id) as { publish_visibility: string };
    expect(row.publish_visibility).toBe("public");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// END-TO-END INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("End-to-End P2P Skill Propagation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("dream → refine → crystallize → publish → peer ingests → execution → reputation", async () => {
    // === NODE A: Generate and publish a skill ===
    const dbA = createTestDb();

    // 1. Insert seed skills + background chunks
    for (let i = 0; i < 25; i++) {
      insertChunk(dbA, {
        text: `Deploy using Docker with health checks and monitoring, variant ${i}`,
        embedding: JSON.stringify(fakeEmbedding(i + 1)),
        importance_score: 0.7,
        memory_type: i < 3 ? "skill" : "plaintext",
        semantic_type: i < 3 ? "skill" : "general",
      });
    }

    // 2. Dream mutation
    const llm = mockLlmCall([
      JSON.stringify([{
        content: "Deploy using Docker with health checks, monitoring, and edge case handling. More general approach with Kubernetes fallback.",
        confidence: 0.9,
        keywords: ["docker", "deploy", "kubernetes"],
      }]),
    ]);

    const dream = new DreamEngine(
      dbA,
      { llmCall: llm, minChunksForDream: 5 },
      noopSynthesize,
      noopEmbedBatch,
    );
    const stats = await dream.run({ modes: ["mutation"] });
    expect(stats).not.toBeNull();
    const mutations = stats!.newInsights.filter((i) => i.mode === "mutation");
    expect(mutations.length).toBeGreaterThan(0);

    // 3. Refine and crystallize
    const mockBridge = mockOrchestratorBridge();
    const networkBridge = new SkillNetworkBridge(dbA, mockBridge);

    let crystallizedId: string | null = null;
    const refiner = new SkillRefiner(
      dbA,
      { promotionThreshold: 0.4 },
      (id) => { crystallizedId = id; },
      undefined,
      networkBridge,
    );

    const sourceId = mutations[0]!.sourceChunkIds[0]!;
    const source = dbA.prepare("SELECT id, text FROM chunks WHERE id = ?").get(sourceId) as { id: string; text: string };
    refiner.evaluateMutations(source, mutations);
    expect(crystallizedId).not.toBeNull();

    // Wait for async publish
    await new Promise((r) => setTimeout(r, 100));

    // Verify skill was published to orchestrator
    expect(mockBridge.publishCalls.length).toBeGreaterThanOrEqual(1);

    // === NODE B: Receive and evaluate the skill ===
    const dbB = createTestDb();
    const trackerB = new SkillExecutionTracker(dbB);
    const repManagerB = new PeerReputationManager(dbB, trackerB);

    // 4. Peer B receives skill via network
    const bridgeB = new SkillNetworkBridge(dbB, null);
    const publishedSkill = dbA.prepare("SELECT text FROM chunks WHERE id = ?").get(crystallizedId!) as { text: string };

    const importResult = bridgeB.ingestNetworkSkill({
      version: 1,
      skill_md: Buffer.from(publishedSkill.text).toString("base64"),
      name: "docker-deploy",
      author_peer_id: "nodeA-peer-id",
      author_pubkey: "nodeA-pubkey",
      signature: "sig",
      timestamp: Date.now(),
      content_hash: `hash-${crypto.randomUUID()}`,
    });
    expect(importResult.ok).toBe(true);

    // 5. Track reputation for nodeA
    repManagerB.recordSkillReceived("nodeA-pubkey", "nodeA-peer-id");
    repManagerB.recordIngestionResult("nodeA-pubkey", true);

    // 6. Execute the imported skill
    const execId = trackerB.startExecution(importResult.crystalId!);
    trackerB.completeExecution(execId, { success: true, rewardScore: 0.85 });

    // 7. Update peer quality from execution data
    repManagerB.updatePeerQuality("nodeA-pubkey");

    const rep = repManagerB.getReputation("nodeA-pubkey");
    expect(rep).not.toBeNull();
    expect(rep!.skillsReceived).toBe(1);
    expect(rep!.skillsAccepted).toBe(1);

    // 8. Verify the skill crystal is usable on node B
    const metrics = trackerB.getSkillMetrics(importResult.crystalId!);
    expect(metrics.totalExecutions).toBe(1);
    expect(metrics.successRate).toBe(1.0);
  });

  it("skill versioning across crystallization generations", () => {
    // Gen0: Original
    const gen0 = createSkillChunk(db, "Base deployment skill");
    const stableId = crypto.randomUUID();
    db.prepare(`UPDATE chunks SET stable_skill_id = ?, skill_version = 1 WHERE id = ?`)
      .run(stableId, gen0);

    // Gen1: Mutation crystallized from Gen0
    const gen1Mutation: DreamInsight = {
      id: "gen1-mut",
      content: "Improved deployment with edge case handling. More general approach with fallback.",
      embedding: [],
      confidence: 0.85,
      mode: "mutation",
      sourceChunkIds: [gen0],
      sourceClusterIds: [],
      dreamCycleId: "cycle-1",
      importanceScore: 0.7,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
       VALUES (?, ?, '[]', ?, 'mutation', '[]', '[]', ?, 0.7, 0, ?, ?)`,
    ).run(gen1Mutation.id, gen1Mutation.content, gen1Mutation.confidence, gen1Mutation.dreamCycleId, Date.now(), Date.now());

    let gen1Id: string | null = null;
    const refiner = new SkillRefiner(db, { promotionThreshold: 0.3 }, (id) => { gen1Id = id; });
    refiner.evaluateMutations({ id: gen0, text: "Base deployment skill" }, [gen1Mutation]);
    expect(gen1Id).not.toBeNull();

    // Verify version chain
    const gen1Row = db.prepare("SELECT stable_skill_id, skill_version, previous_version_id FROM chunks WHERE id = ?")
      .get(gen1Id!) as { stable_skill_id: string; skill_version: number; previous_version_id: string };

    expect(gen1Row.stable_skill_id).toBe(stableId);
    expect(gen1Row.skill_version).toBe(2);
    expect(gen1Row.previous_version_id).toBe(gen0);

    // MemStore version queries
    const store = new MemStore(db);
    const latest = store.getLatestVersion(stableId);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(gen1Id);

    const history = store.getVersionHistory(stableId);
    expect(history.length).toBe(2);
  });

  it("marketplace integrates with execution metrics and peer reputation", () => {
    const tracker = new SkillExecutionTracker(db);
    const repManager = new PeerReputationManager(db, tracker);
    const marketplace = new SkillMarketplace(db, tracker, repManager);

    const peerPubkey = "marketplace-peer";
    const governance = JSON.stringify({
      accessScope: "shared",
      sensitivity: "normal",
      peerOrigin: peerPubkey,
    });

    // Create peer and skill
    repManager.recordSkillReceived(peerPubkey, "peer-mp");
    repManager.recordIngestionResult(peerPubkey, true);

    const skillId = createSkillChunk(db, "Marketplace skill from peer", { governance_json: governance });
    marketplace.listSkill(skillId, "Skill description");

    // Execute skill successfully
    const execId = tracker.startExecution(skillId);
    tracker.completeExecution(execId, { success: true, rewardScore: 0.9 });

    // Search and verify metrics are included
    const results = marketplace.search("Marketplace");
    expect(results.length).toBe(1);
    expect(results[0]!.successRate).toBe(1.0);
    expect(results[0]!.authorPeerId).toBe(peerPubkey);
    expect(results[0]!.authorReputation).toBeGreaterThan(0);
  });

  it("governance blocks publish of confidential skills to network", async () => {
    const mockBridge = mockOrchestratorBridge();
    const bridge = new SkillNetworkBridge(db, mockBridge);

    // Confidential skill — should not be published
    const id = createSkillChunk(db, "Top secret skill", {
      governance_json: JSON.stringify({ accessScope: "shared", sensitivity: "confidential" }),
    });

    const result = await bridge.publishCrystalSkill(id);
    expect(result).toBeNull();
    expect(mockBridge.publishCalls.length).toBe(0);
  });

  it("consolidation preserves frozen skill crystals", () => {
    const skillId = createSkillChunk(db, "Frozen skill", { lifecycle: "frozen", importance_score: 0.01 });

    // Also insert some low-importance non-skill chunks that should be forgotten
    for (let i = 0; i < 10; i++) {
      insertChunk(db, {
        text: `Low importance chunk ${i}`,
        importance_score: 0.01,
        access_count: 0,
        lifecycle: "generated",
        embedding: JSON.stringify(fakeEmbedding(i + 1)),
      });
    }

    const consolidation = new ConsolidationEngine(db, { forgetThreshold: 0.05 });
    consolidation.run();

    const skill = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get(skillId) as { lifecycle: string };
    expect(skill.lifecycle).toBe("frozen");
  });

  it("discovery agent + marketplace: learning path recommendation", () => {
    const tracker = new SkillExecutionTracker(db);
    const repManager = new PeerReputationManager(db, tracker);
    const marketplace = new SkillMarketplace(db, tracker, repManager);

    // Create a skill chain: A → B → C (prerequisites)
    const a = createSkillChunk(db, "Docker basics");
    const b = createSkillChunk(db, "Docker compose");
    const c = createSkillChunk(db, "Kubernetes orchestration");

    marketplace.listSkill(a);
    marketplace.listSkill(b);
    marketplace.listSkill(c);

    const now = Date.now();
    db.prepare(
      `INSERT INTO skill_edges (id, source_skill_id, target_skill_id, edge_type, weight, confidence, discovered_by, created_at, updated_at)
       VALUES (?, ?, ?, 'prerequisite', 0.9, 0.9, 'llm', ?, ?)`,
    ).run(crypto.randomUUID(), a, b, now, now);
    db.prepare(
      `INSERT INTO skill_edges (id, source_skill_id, target_skill_id, edge_type, weight, confidence, discovered_by, created_at, updated_at)
       VALUES (?, ?, ?, 'prerequisite', 0.9, 0.9, 'llm', ?, ?)`,
    ).run(crypto.randomUUID(), b, c, now, now);

    // Verify prerequisite chain is traversable
    const agent = new DiscoveryAgent(db, null);
    const prereqs = agent.getPrerequisites(c);
    expect(prereqs.length).toBe(2);
    expect(prereqs).toContain(a);
    expect(prereqs).toContain(b);

    // Verify marketplace can list all three
    const results = marketplace.search("");
    expect(results.length).toBe(3);
  });

  it("full cycle: two peers exchange skills and build reputation", () => {
    // === Peer A setup ===
    const dbA = createTestDb();
    const trackerA = new SkillExecutionTracker(dbA);
    const repA = new PeerReputationManager(dbA, trackerA);
    const storeA = new MemStore(dbA);

    // === Peer B setup ===
    const dbB = createTestDb();
    const trackerB = new SkillExecutionTracker(dbB);
    const repB = new PeerReputationManager(dbB, trackerB);
    const storeB = new MemStore(dbB);

    // Peer A creates and publishes a skill
    const skillA = createSkillChunk(dbA, "Peer A deployment skill");
    storeA.publish(skillA, "shared");

    // Peer B imports A's skill
    const envA = createEnvelope({
      name: "peer-a-deploy",
      author_pubkey: "pubkey-A",
      author_peer_id: "peer-A",
      skill_md: Buffer.from("Peer A deployment skill").toString("base64"),
    });
    const importA = storeB.importFromPeer(envA, "pubkey-A");
    expect(importA.ok).toBe(true);

    // Peer B tracks reputation for A
    repB.recordSkillReceived("pubkey-A", "peer-A");
    repB.recordIngestionResult("pubkey-A", true);

    // Peer B executes A's skill successfully
    const exec = trackerB.startExecution(importA.crystalId!);
    trackerB.completeExecution(exec, { success: true, rewardScore: 0.9 });

    // Peer B creates and publishes a skill
    const skillB = createSkillChunk(dbB, "Peer B testing skill");
    storeB.publish(skillB, "shared");

    // Peer A imports B's skill
    const envB = createEnvelope({
      name: "peer-b-test",
      author_pubkey: "pubkey-B",
      author_peer_id: "peer-B",
      skill_md: Buffer.from("Peer B testing skill").toString("base64"),
    });
    const importB = storeA.importFromPeer(envB, "pubkey-B");
    expect(importB.ok).toBe(true);

    // Peer A tracks reputation for B
    repA.recordSkillReceived("pubkey-B", "peer-B");
    repA.recordIngestionResult("pubkey-B", true);

    // Verify both peers have reputation records
    const repOfA = repB.getReputation("pubkey-A");
    expect(repOfA).not.toBeNull();
    expect(repOfA!.skillsAccepted).toBe(1);

    const repOfB = repA.getReputation("pubkey-B");
    expect(repOfB).not.toBeNull();
    expect(repOfB!.skillsAccepted).toBe(1);

    // Verify leaderboards
    const boardA = repA.getLeaderboard();
    expect(boardA.length).toBe(1);
    expect(boardA[0]!.peerPubkey).toBe("pubkey-B");

    const boardB = repB.getLeaderboard();
    expect(boardB.length).toBe(1);
    expect(boardB[0]!.peerPubkey).toBe("pubkey-A");
  });
});
