import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { PeerReputationManager } from "./peer-reputation.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";

// 2026-09-28 skills-received audit: a peer flagged during an August burst
// stayed flagged a month later, because the detector only revisited peers
// active in the current window.

function openRep(): { db: DatabaseSync; rep: PeerReputationManager } {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return { db, rep: new PeerReputationManager(db, new SkillExecutionTracker(db)) };
}

const flagOf = (db: DatabaseSync, pubkey: string) =>
  (
    db.prepare(`SELECT anomaly_flag FROM peer_reputation WHERE peer_pubkey = ?`).get(pubkey) as {
      anomaly_flag: number;
    }
  ).anomaly_flag;

describe("PeerReputationManager.detectAnomalies", () => {
  it("clears the flag of a peer that has gone quiet", () => {
    const { db, rep } = openRep();
    rep.recordSkillReceived("quiet", "12D3KooWQuiet");
    db.prepare(`UPDATE peer_reputation SET anomaly_flag = 1 WHERE peer_pubkey = 'quiet'`).run();
    // Its only activity is far outside the window.
    db.prepare(`UPDATE peer_activity_log SET timestamp = 0 WHERE peer_pubkey = 'quiet'`).run();

    rep.detectAnomalies();
    expect(flagOf(db, "quiet")).toBe(0);
    db.close();
  });

  it("still flags a peer that is bursting now", () => {
    const { db, rep } = openRep();
    for (let i = 0; i < 40; i++) {
      rep.recordSkillReceived("bursty", "12D3KooWBursty");
    }
    // Long history makes the per-window average small next to this burst.
    db.prepare(`UPDATE peer_reputation SET first_seen_at = ?, skills_received = 40`).run(
      Date.now() - 30 * 24 * 3_600_000,
    );
    rep.detectAnomalies();
    expect(flagOf(db, "bursty")).toBe(1);
    db.close();
  });
});
