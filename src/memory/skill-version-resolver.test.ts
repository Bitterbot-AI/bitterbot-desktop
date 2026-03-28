import { describe, it, expect } from "vitest";
import { SkillVersionResolver } from "./skill-version-resolver.js";
import type { FitnessInput } from "./skill-version-resolver.js";

// ── lineageHash ────────────────────────────────────────────────────────────

describe("SkillVersionResolver.lineageHash", () => {
  it("produces deterministic output", () => {
    const a = SkillVersionResolver.lineageHash("skill-1", "abc123", "pubkeyA");
    const b = SkillVersionResolver.lineageHash("skill-1", "abc123", "pubkeyA");
    expect(a).toBe(b);
  });

  it("diverges when authors differ (same parent)", () => {
    const a = SkillVersionResolver.lineageHash("skill-1", "abc123", "pubkeyA");
    const b = SkillVersionResolver.lineageHash("skill-1", "abc123", "pubkeyB");
    expect(a).not.toBe(b);
  });

  it("diverges when parents differ (same author)", () => {
    const a = SkillVersionResolver.lineageHash("skill-1", "parentV2", "pubkeyA");
    const b = SkillVersionResolver.lineageHash("skill-1", "parentV3", "pubkeyA");
    expect(a).not.toBe(b);
  });

  it("handles null parent (genesis)", () => {
    const a = SkillVersionResolver.lineageHash("skill-1", null, "pubkeyA");
    const b = SkillVersionResolver.lineageHash("skill-1", null, "pubkeyA");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });
});

// ── fitness ────────────────────────────────────────────────────────────────

describe("SkillVersionResolver.fitness", () => {
  it("returns 0.5-ish prior for unexecuted skills from unknown peers", () => {
    const score = SkillVersionResolver.fitness({
      executionSuccessRate: null,
      executionCount: 0,
      peerTrust: 0.5,
      ageMs: 0,
    });
    // 0.45*0.5 + 0.35*0.5 + 0.20*1.0 = 0.225 + 0.175 + 0.2 = 0.6
    expect(score).toBeCloseTo(0.6, 1);
  });

  it("high-performing trusted skill scores near 1.0", () => {
    const score = SkillVersionResolver.fitness({
      executionSuccessRate: 0.95,
      executionCount: 20,
      peerTrust: 1.0,
      ageMs: 1000, // very recent
    });
    expect(score).toBeGreaterThan(0.85);
  });

  it("old skill from untrusted peer with no executions scores low", () => {
    const score = SkillVersionResolver.fitness({
      executionSuccessRate: null,
      executionCount: 0,
      peerTrust: 0.1,
      ageMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    expect(score).toBeLessThan(0.35);
  });

  it("Bayesian smoothing blends prior with observed rate for few executions", () => {
    const oneExec = SkillVersionResolver.fitness({
      executionSuccessRate: 1.0,
      executionCount: 1,
      peerTrust: 0.5,
      ageMs: 0,
    });
    const twentyExecs = SkillVersionResolver.fitness({
      executionSuccessRate: 1.0,
      executionCount: 20,
      peerTrust: 0.5,
      ageMs: 0,
    });
    // One execution at 100% shouldn't score as high as twenty at 100%
    expect(twentyExecs).toBeGreaterThan(oneExec);
  });

  it("recency decays with halflife", () => {
    const fresh = SkillVersionResolver.fitness({
      executionSuccessRate: 0.8,
      executionCount: 10,
      peerTrust: 0.7,
      ageMs: 0,
    });
    const weekOld = SkillVersionResolver.fitness({
      executionSuccessRate: 0.8,
      executionCount: 10,
      peerTrust: 0.7,
      ageMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(fresh).toBeGreaterThan(weekOld);
    // Recency component halves — difference should be ~0.10
    expect(fresh - weekOld).toBeCloseTo(0.10, 1);
  });
});

// ── resolveConflict (unit, no DB) ──────────────────────────────────────────

describe("SkillVersionResolver.resolveConflict", () => {
  // Stub DB that returns empty variants (no conflict scenario)
  const emptyDb = {
    prepare: () => ({ all: () => [], get: () => undefined }),
  } as unknown as import("node:sqlite").DatabaseSync;

  const baseFitness: FitnessInput = {
    executionSuccessRate: null,
    executionCount: 0,
    peerTrust: 0.5,
    ageMs: 0,
  };

  it("accepts new version when no existing variants", () => {
    const resolver = new SkillVersionResolver(emptyDb);
    const result = resolver.resolveConflict(
      {
        stableSkillId: "weather-api",
        version: 3,
        contentHash: "hash-new",
        parentContentHash: "hash-v2",
        authorPubkey: "pubkeyA",
      },
      baseFitness,
      () => baseFitness,
    );
    expect(result.action).toBe("accept_new");
    expect(result.reason).toBe("no conflict");
  });

  it("rejects duplicate content", () => {
    const dbWithExisting = {
      prepare: () => ({
        all: () => [
          {
            id: "crystal-1",
            stable_skill_id: "weather-api",
            skill_version: 3,
            hash: "hash-same",
            peer_origin: "pubkeyA",
            lineage_hash: "lineage-1",
            importance_score: 0.5,
            created_at: Date.now(),
          },
        ],
      }),
    } as unknown as import("node:sqlite").DatabaseSync;

    const resolver = new SkillVersionResolver(dbWithExisting);
    const result = resolver.resolveConflict(
      {
        stableSkillId: "weather-api",
        version: 3,
        contentHash: "hash-same",
        parentContentHash: "hash-v2",
        authorPubkey: "pubkeyA",
      },
      baseFitness,
      () => baseFitness,
    );
    expect(result.action).toBe("keep_existing");
    expect(result.reason).toBe("duplicate content");
  });

  it("keeps both on true divergence (different lineages)", () => {
    const lineageA = SkillVersionResolver.lineageHash("weather-api", "hash-v2", "pubkeyA");
    const dbWithExisting = {
      prepare: () => ({
        all: () => [
          {
            id: "crystal-1",
            stable_skill_id: "weather-api",
            skill_version: 3,
            hash: "hash-variant-a",
            peer_origin: "pubkeyA",
            lineage_hash: lineageA,
            importance_score: 0.5,
            created_at: Date.now(),
          },
        ],
      }),
    } as unknown as import("node:sqlite").DatabaseSync;

    const resolver = new SkillVersionResolver(dbWithExisting);
    const result = resolver.resolveConflict(
      {
        stableSkillId: "weather-api",
        version: 3,
        contentHash: "hash-variant-b",
        parentContentHash: "hash-v2",
        authorPubkey: "pubkeyB", // different author → different lineage
      },
      baseFitness,
      () => baseFitness,
    );
    expect(result.action).toBe("keep_both");
    expect(result.reason).toContain("divergent branches");
    expect(result.reason).toContain("2 variants");
  });
});
