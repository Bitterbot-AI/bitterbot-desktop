/**
 * PLAN-13 Phase C: tests for PeerReputationManager.decayInactivePeers.
 *
 * Coverage:
 *   - within grace window (14d) is untouched
 *   - past grace, score decays by Ebbinghaus curve
 *   - banned peers are skipped
 *   - genesis trust list peers are skipped
 *   - floor at 0.1 (no further decay below)
 *   - small deltas below minScoreDelta are no-ops
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { PeerReputationManager } from "./peer-reputation.js";

// Stub: decay does not touch the execution tracker.
const stubTracker: SkillExecutionTracker = {
  getPeerSkillMetrics: () => ({ totalSkills: 0, avgSuccessRate: 0 }),
  getSkillMetrics: () => undefined,
  // oxlint-disable-next-line typescript/no-explicit-any
} as any;

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

function rep(db: DatabaseSync, pubkey: string): number {
  const row = db
    .prepare(`SELECT reputation_score FROM peer_reputation WHERE peer_pubkey = ?`)
    .get(pubkey) as { reputation_score: number } | undefined;
  return Number(row?.reputation_score ?? -1);
}

describe("PeerReputationManager.decayInactivePeers", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(
    pubkey: string,
    opts: { score: number; lastSeenDaysAgo: number; isBanned?: boolean; isTrusted?: boolean },
  ): void {
    const lastSeenAt = NOW - opts.lastSeenDaysAgo * DAY;
    db.prepare(
      `INSERT INTO peer_reputation (peer_pubkey, reputation_score, first_seen_at, last_seen_at, is_banned, is_trusted)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      pubkey,
      opts.score,
      lastSeenAt - 365 * DAY,
      lastSeenAt,
      opts.isBanned ? 1 : 0,
      opts.isTrusted ? 1 : 0,
    );
  }

  it("peers within the 14-day grace window are not touched", () => {
    seed("recent", { score: 0.8, lastSeenDaysAgo: 7 });
    const manager = new PeerReputationManager(db, stubTracker);
    const result = manager.decayInactivePeers({ now: NOW });
    expect(result.examined).toBe(1);
    expect(result.decayed).toBe(0);
    expect(rep(db, "recent")).toBeCloseTo(0.8, 5);
  });

  it("peers past grace are decayed by Ebbinghaus", () => {
    // 14 + 100 = 114 days idle. Decay: 0.85 * exp(-0.007 * 100) ≈ 0.85 * 0.4966 ≈ 0.422
    seed("idle", { score: 0.85, lastSeenDaysAgo: 114 });
    const manager = new PeerReputationManager(db, stubTracker);
    const result = manager.decayInactivePeers({ now: NOW });
    expect(result.examined).toBe(1);
    expect(result.decayed).toBe(1);
    const after = rep(db, "idle");
    expect(after).toBeLessThan(0.85);
    expect(after).toBeGreaterThan(0.35);
    expect(after).toBeLessThan(0.5);
  });

  it("banned peers are skipped entirely", () => {
    seed("baddie", { score: 0.5, lastSeenDaysAgo: 365, isBanned: true });
    const manager = new PeerReputationManager(db, stubTracker);
    const result = manager.decayInactivePeers({ now: NOW });
    // Banned peers don't even reach the examined count under our filter.
    expect(result.decayed).toBe(0);
    expect(rep(db, "baddie")).toBe(0.5);
  });

  it("genesis trust list peers are skipped (operator-asserted)", () => {
    seed("trusted-pk", { score: 0.85, lastSeenDaysAgo: 200 });
    const manager = new PeerReputationManager(db, stubTracker, ["trusted-pk"]);
    const result = manager.decayInactivePeers({ now: NOW });
    expect(rep(db, "trusted-pk")).toBeCloseTo(0.85, 5);
    expect(result.decayed).toBe(0);
  });

  it("score floor is 0.1; further idle does not decay below", () => {
    // 14 + 1000 = 1014 days idle. Without floor: 0.5 * exp(-7) ≈ 0.000456
    seed("ancient", { score: 0.5, lastSeenDaysAgo: 1014 });
    const manager = new PeerReputationManager(db, stubTracker);
    manager.decayInactivePeers({ now: NOW });
    expect(rep(db, "ancient")).toBe(0.1);
  });

  it("small deltas below minScoreDelta are no-ops", () => {
    // 16 days idle: just 2 days past grace. Decay factor exp(-0.007 * 2) ≈ 0.986.
    // Delta from 0.5 → ~0.493 = 0.007. With minDelta 0.05, no-op.
    seed("barely", { score: 0.5, lastSeenDaysAgo: 16 });
    const manager = new PeerReputationManager(db, stubTracker);
    const result = manager.decayInactivePeers({ now: NOW, minScoreDelta: 0.05 });
    expect(result.decayed).toBe(0);
    expect(rep(db, "barely")).toBeCloseTo(0.5, 5);
  });
});
