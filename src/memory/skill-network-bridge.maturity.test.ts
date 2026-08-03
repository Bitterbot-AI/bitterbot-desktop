import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { SkillNetworkBridge } from "./skill-network-bridge.js";

// Regression for the fleet-wide "skills from nowhere" flood: auto-publish and
// query-response broadcast every dream crystal to the mesh with no maturity
// bar, so ~40 nodes circulate reworded copies of the same idea. publishCrystalSkill
// must now gate on the marketplace maturity bar (verifier + >=3 executions +
// >70% success) — unexecuted dream output must NOT propagate.

function makeMetrics(totalExecutions: number, successRate: number) {
  return { totalExecutions, successRate };
}

function setup(metrics: { totalExecutions: number; successRate: number }) {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);

  const publishSkill = vi.fn(async () => ({ ok: true, content_hash: "hash" }));
  const bridge = new SkillNetworkBridge(db, { publishSkill } as never, undefined, null);
  // Verifier passes; execution tracker reports the given maturity.
  bridge.setSkillVerifier({ verify: () => ({ passed: true }) } as never);
  bridge.setExecutionTracker({ getSkillMetrics: () => metrics } as never);

  // Insert a shared crystal so only the maturity gate decides.
  const id = "crystal-1";
  db.prepare(
    `INSERT INTO chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
        semantic_type, lifecycle_state, governance_json)
     VALUES (?, ?, 'skill', 1, 1, 'h', 'none', ?, '[]', ?, 'skill', 'active', ?)`,
  ).run(
    id,
    "skills/s",
    "---\nname: s\ndescription: A resilient middleware.\n---\nbody",
    Date.now(),
    JSON.stringify({ accessScope: "shared", sensitivity: "normal" }),
  );
  return { bridge, publishSkill, id };
}

describe("publishCrystalSkill — maturity gate", () => {
  it("does NOT publish an immature crystal (0 executions)", async () => {
    const { bridge, publishSkill, id } = setup(makeMetrics(0, 0));
    const result = await bridge.publishCrystalSkill(id);
    expect(result).toBeNull();
    expect(publishSkill).not.toHaveBeenCalled();
  });

  it("does NOT publish a crystal below the success bar (3 runs, 50%)", async () => {
    const { bridge, publishSkill, id } = setup(makeMetrics(3, 0.5));
    const result = await bridge.publishCrystalSkill(id);
    expect(result).toBeNull();
    expect(publishSkill).not.toHaveBeenCalled();
  });

  it("publishes a matured crystal (3 runs, 100%)", async () => {
    const { bridge, publishSkill, id } = setup(makeMetrics(3, 1));
    await bridge.publishCrystalSkill(id);
    // The maturity gate lets a proven crystal through to the wire (the
    // post-publish audit write is exercised elsewhere; here we assert the
    // crystal actually reached the network publish call).
    expect(publishSkill).toHaveBeenCalledTimes(1);
  });
});
