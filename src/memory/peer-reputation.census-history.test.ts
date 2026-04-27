/**
 * Tests for the network_census_history persistence + reader added in v11.
 *
 * Coverage:
 *   - persistCensusSnapshot inserts a row and is idempotent on (source, generated_at)
 *   - getNetworkCensusHistory returns rows ordered by generated_at ascending
 *   - filtering by sourcePeerId and sinceMs work as expected
 *   - by_tier / by_address_type round-trip through JSON serialization
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { PeerReputationManager } from "./peer-reputation.js";

const stubTracker: SkillExecutionTracker = {
  getPeerSkillMetrics: () => ({ totalSkills: 0, avgSuccessRate: 0 }),
  getSkillMetrics: () => undefined,
  // oxlint-disable-next-line typescript/no-explicit-any
} as any;

describe("PeerReputationManager network census history", () => {
  let db: DatabaseSync;
  let mgr: PeerReputationManager;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    mgr = new PeerReputationManager(db, stubTracker, []);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the network_census_history table at schema v11", () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='network_census_history'`,
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("network_census_history");
  });

  it("inserts a snapshot and reads it back via getNetworkCensusHistory", () => {
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: 1_777_000_000,
      lifetimeUniquePeers: 42,
      activeLast24h: 10,
      activeLast7d: 30,
      byTier: { edge: 38, management: 4 },
      byAddressType: { ipv4_public: 35, dns: 7 },
    });

    const rows = mgr.getNetworkCensusHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourcePeerId: "boot-1",
      generatedAt: 1_777_000_000,
      lifetimeUniquePeers: 42,
      activeLast24h: 10,
      activeLast7d: 30,
      byTier: { edge: 38, management: 4 },
      byAddressType: { ipv4_public: 35, dns: 7 },
    });
  });

  it("is idempotent on (source_peer_id, generated_at) — duplicates do not double-insert", () => {
    const args = {
      sourcePeerId: "boot-1",
      generatedAt: 1_777_000_000,
      lifetimeUniquePeers: 5,
      activeLast24h: 1,
      activeLast7d: 3,
      byTier: { edge: 5 },
      byAddressType: { ipv4_public: 5 },
    };
    mgr.persistCensusSnapshot(args);
    mgr.persistCensusSnapshot(args);
    mgr.persistCensusSnapshot(args);
    const rows = mgr.getNetworkCensusHistory();
    expect(rows).toHaveLength(1);
  });

  it("returns rows ordered by generated_at ascending", () => {
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: 3000,
      lifetimeUniquePeers: 30,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: 1000,
      lifetimeUniquePeers: 10,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: 2000,
      lifetimeUniquePeers: 20,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    const rows = mgr.getNetworkCensusHistory();
    expect(rows.map((r) => r.generatedAt)).toEqual([1000, 2000, 3000]);
  });

  it("filters by sourcePeerId when provided", () => {
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: 1000,
      lifetimeUniquePeers: 10,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-2",
      generatedAt: 1100,
      lifetimeUniquePeers: 11,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    const filtered = mgr.getNetworkCensusHistory({ sourcePeerId: "boot-2" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sourcePeerId).toBe("boot-2");
  });

  it("respects the sinceMs filter on snapshot_at", () => {
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: 1000,
      lifetimeUniquePeers: 1,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    // snapshot_at is set to Date.now() at write time; passing a future cutoff
    // should drop the row.
    const futureCutoff = Date.now() + 60 * 60 * 1000;
    expect(mgr.getNetworkCensusHistory({ sinceMs: futureCutoff })).toHaveLength(0);
    expect(mgr.getNetworkCensusHistory({ sinceMs: 0 })).toHaveLength(1);
  });

  it("ignores rows with non-numeric or missing source_peer_id / generated_at", () => {
    mgr.persistCensusSnapshot({
      sourcePeerId: "",
      generatedAt: 1000,
      lifetimeUniquePeers: 1,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    mgr.persistCensusSnapshot({
      sourcePeerId: "boot-1",
      generatedAt: Number.NaN,
      lifetimeUniquePeers: 1,
      activeLast24h: 0,
      activeLast7d: 0,
      byTier: {},
      byAddressType: {},
    });
    expect(mgr.getNetworkCensusHistory()).toHaveLength(0);
  });
});
