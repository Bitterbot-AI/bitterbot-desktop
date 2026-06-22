import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import {
  type CensusPeer,
  type NetworkCensusSnapshot,
  SkillNetworkBridge,
} from "./skill-network-bridge.js";

const GEN = Math.floor(Date.now() / 1000);

function openBridge(): SkillNetworkBridge {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return new SkillNetworkBridge(db, null, undefined, null);
}

function peer(pubkey: string, tier: string, last = GEN, address_type = "ipv4_public"): CensusPeer {
  return { pubkey, tier, address_type, last_seen_at: last };
}

function snap(over: Partial<NetworkCensusSnapshot>): NetworkCensusSnapshot {
  return {
    enabled: true,
    lifetime_unique_peers: 0,
    active_last_24h: 0,
    active_last_7d: 0,
    by_tier: {},
    by_address_type: {},
    generated_at: GEN,
    ...over,
  };
}

describe("getAggregatedNetworkCensus", () => {
  let bridge: SkillNetworkBridge;
  beforeEach(() => {
    bridge = openBridge();
  });

  it("returns null when no census has been heard", () => {
    expect(bridge.getAggregatedNetworkCensus()).toBeNull();
  });

  it("unions peers across sources, deduped by pubkey (exact path)", () => {
    // Two bootnodes; p2 is connected to both and must count once.
    bridge.recordCensusSnapshot(
      "A",
      snap({ peers: [peer("p1", "edge"), peer("p2", "edge"), peer("p3", "management")] }),
    );
    bridge.recordCensusSnapshot("B", snap({ peers: [peer("p2", "edge"), peer("p4", "edge")] }));

    const agg = bridge.getAggregatedNetworkCensus()!;
    expect(agg.source_count).toBe(2);
    expect(agg.snapshot.lifetime_unique_peers).toBe(4); // p1,p2,p3,p4 — not 5
    expect(agg.snapshot.by_tier).toEqual({ edge: 3, management: 1 });
  });

  it("is stable regardless of which source was heard last (fixes the flap)", () => {
    bridge.recordCensusSnapshot("A", snap({ peers: [peer("p1", "edge"), peer("p2", "edge")] }));
    bridge.recordCensusSnapshot("B", snap({ peers: [peer("p3", "edge")] }));
    const first = bridge.getAggregatedNetworkCensus()!.snapshot.lifetime_unique_peers;
    // Re-hearing A last must not change the aggregate (old bug flipped to A's count).
    bridge.recordCensusSnapshot("A", snap({ peers: [peer("p1", "edge"), peer("p2", "edge")] }));
    expect(bridge.getAggregatedNetworkCensus()!.snapshot.lifetime_unique_peers).toBe(first);
  });

  it("excludes peers outside the activity window", () => {
    bridge.recordCensusSnapshot(
      "A",
      snap({ peers: [peer("fresh", "edge", GEN), peer("stale", "edge", GEN - 3000)] }),
    );
    expect(bridge.getAggregatedNetworkCensus()!.snapshot.lifetime_unique_peers).toBe(1);
  });

  it("falls back to element-wise max for counts-only (pre-upgrade) sources", () => {
    bridge.recordCensusSnapshot(
      "A",
      snap({ by_tier: { edge: 35, management: 3 }, lifetime_unique_peers: 38 }),
    );
    bridge.recordCensusSnapshot(
      "B",
      snap({ by_tier: { edge: 31, management: 3 }, lifetime_unique_peers: 34 }),
    );
    const agg = bridge.getAggregatedNetworkCensus()!;
    expect(agg.snapshot.by_tier).toEqual({ edge: 35, management: 3 }); // max, not 34 or a flapping pick
  });

  it("drops stale sources past the TTL", () => {
    bridge.recordCensusSnapshot("A", snap({ peers: [peer("p1", "edge")] }));
    // Evaluate far in the future so the source is beyond the 180s TTL.
    expect(bridge.getAggregatedNetworkCensus(Date.now() + 10 * 60 * 1000)).toBeNull();
  });
});
