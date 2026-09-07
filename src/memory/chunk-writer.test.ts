/**
 * PLAN-46 Phase 0: the chunk-writer facade. Verifies scoped writes touch only
 * their columns and that lifecycle stays consistent (audit C1).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bumpChunkDreamCount,
  deriveLifecycleState,
  setChunkCuriosityReward,
  setChunkLifecycle,
  setChunkProvenance,
} from "./chunk-writer.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY, lifecycle TEXT, lifecycle_state TEXT, parent_id TEXT,
    hygiene_done INTEGER, last_consolidated_at INTEGER, version INTEGER DEFAULT 1,
    provenance_chain TEXT, provenance_dag TEXT, curiosity_reward REAL,
    dream_count INTEGER, last_dreamed_at INTEGER, importance_score REAL
  )`);
  db.prepare(
    `INSERT INTO chunks (id, lifecycle, lifecycle_state) VALUES ('c1','generated','active')`,
  ).run();
});

describe("chunk-writer facade (PLAN-46 Phase 0)", () => {
  it("setChunkLifecycle keeps lifecycle and lifecycle_state consistent (audit C1)", () => {
    setChunkLifecycle(db, "c1", { lifecycle: "consolidated" });
    let row = db.prepare(`SELECT lifecycle, lifecycle_state FROM chunks WHERE id='c1'`).get() as {
      lifecycle: string;
      lifecycle_state: string;
    };
    expect(row).toEqual({ lifecycle: "consolidated", lifecycle_state: "consolidated" });
    // expired derives to archived unless an explicit state is passed
    setChunkLifecycle(db, "c1", { lifecycle: "expired" });
    row = db.prepare(`SELECT lifecycle, lifecycle_state FROM chunks WHERE id='c1'`).get() as never;
    expect(row).toEqual({ lifecycle: "expired", lifecycle_state: "archived" });
    // explicit state wins (forget-on-expire path)
    setChunkLifecycle(db, "c1", {
      lifecycle: "expired",
      lifecycleState: "forgotten",
      bumpVersion: true,
    });
    row = db
      .prepare(`SELECT lifecycle, lifecycle_state, version FROM chunks WHERE id='c1'`)
      .get() as never;
    expect(row).toMatchObject({ lifecycle: "expired", lifecycle_state: "forgotten", version: 2 });
  });

  it("deriveLifecycleState maps every lifecycle value", () => {
    expect(deriveLifecycleState("consolidated")).toBe("consolidated");
    expect(deriveLifecycleState("archived")).toBe("archived");
    expect(deriveLifecycleState("expired")).toBe("archived");
    expect(deriveLifecycleState("generated")).toBe("active");
    expect(deriveLifecycleState(undefined)).toBeUndefined();
  });

  it("scoped writers touch only their own columns", () => {
    setChunkProvenance(db, "c1", { provenanceChain: '["a"]' });
    setChunkCuriosityReward(db, "c1", 0.42);
    bumpChunkDreamCount(db, ["c1"]);
    const row = db
      .prepare(
        `SELECT provenance_chain, curiosity_reward, dream_count, lifecycle FROM chunks WHERE id='c1'`,
      )
      .get() as {
      provenance_chain: string;
      curiosity_reward: number;
      dream_count: number;
      lifecycle: string;
    };
    expect(row.provenance_chain).toBe('["a"]');
    expect(row.curiosity_reward).toBeCloseTo(0.42);
    expect(row.dream_count).toBe(1);
    // provenance/curiosity/dream writes never changed lifecycle
    expect(row.lifecycle).toBe("generated");
  });

  it("a no-op update (all fields undefined) changes nothing", () => {
    expect(setChunkLifecycle(db, "c1", {})).toBe(0);
  });
});
