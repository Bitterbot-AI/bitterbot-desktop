/**
 * Artifact-liveness doctor section: each test seeds one wired-but-dead defect
 * signature from the 2026-08-09 audit and asserts the section names it — plus
 * the all-healthy path staying quiet. Minimal hand-built schema (the section
 * must tolerate partial schemas via tableExists, which absent-table tests cover).
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inspectArtifactLiveness } from "./doctor-liveness.js";

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

function livenessDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, memory_type TEXT, semantic_type TEXT,
      skill_category TEXT, published_at INTEGER
    );
    CREATE TABLE intervention_records (id TEXT PRIMARY KEY, ts INTEGER, record_json TEXT);
    CREATE TABLE skill_executions (
      id TEXT PRIMARY KEY, skill_crystal_id TEXT, started_at INTEGER, completed_at INTEGER
    );
    CREATE TABLE peer_reputation (
      peer_pubkey TEXT PRIMARY KEY, skills_received INTEGER DEFAULT 0,
      skills_accepted INTEGER DEFAULT 0, skills_rejected INTEGER DEFAULT 0
    );
    CREATE TABLE curiosity_targets (
      id TEXT PRIMARY KEY, created_at INTEGER, resolved_at INTEGER
    );
    CREATE TABLE curiosity_regions (id TEXT PRIMARY KEY);
    CREATE TABLE curiosity_progress (id TEXT PRIMARY KEY, region_id TEXT);
    CREATE TABLE dream_cycles (cycle_id TEXT PRIMARY KEY, modes_used TEXT);
    CREATE TABLE dream_insights (id TEXT PRIMARY KEY, mode TEXT);
  `);
  return db;
}

function seedHealthy(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO chunks VALUES ('sk1', 'skill', 'skill', 'web-search', ${NOW});
    INSERT INTO intervention_records VALUES ('ir1', ${NOW}, '{}');
    INSERT INTO skill_executions VALUES ('e1', 'sk1', ${NOW - 1000}, ${NOW});
    INSERT INTO peer_reputation VALUES ('pk1', 5, 2, 1);
    INSERT INTO curiosity_targets VALUES ('t1', ${NOW - DAY}, ${NOW});
    INSERT INTO curiosity_regions VALUES ('r1');
    INSERT INTO curiosity_progress VALUES ('p1', 'r1');
    INSERT INTO dream_cycles VALUES ('c1', '["mutation"]');
    INSERT INTO dream_insights VALUES ('i1', 'mutation');
  `);
}

const warnsOf = (results: ReturnType<typeof inspectArtifactLiveness>) =>
  results.filter((r) => r.level === "warn").map((r) => r.message);

describe("inspectArtifactLiveness", () => {
  it("stays all-ok/info on a healthy DB", () => {
    const db = livenessDb();
    seedHealthy(db);
    const results = inspectArtifactLiveness(db, NOW);
    expect(warnsOf(results)).toEqual([]);
    expect(
      results.some((r) => r.level === "ok" && /skill crystals categorized/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("tolerates a DB with none of the tables", () => {
    const db = new DatabaseSync(":memory:");
    expect(inspectArtifactLiveness(db, NOW)).toEqual([]);
    db.close();
  });

  it("warns on uncategorized skill crystals (F12 signature)", () => {
    const db = livenessDb();
    seedHealthy(db);
    db.exec(`INSERT INTO chunks VALUES ('sk2', 'skill', 'skill', NULL, NULL)`);
    const w = warnsOf(inspectArtifactLiveness(db, NOW));
    expect(w.some((m) => /1\/2 skill crystals have no skill_category/.test(m))).toBe(true);
    db.close();
  });

  it("warns when tool traffic exists but the guard chain never fired (F4 signature)", () => {
    const db = livenessDb();
    seedHealthy(db);
    db.exec(`DELETE FROM intervention_records`);
    const w = warnsOf(inspectArtifactLiveness(db, NOW));
    expect(w.some((m) => /intervention_records is empty despite 1 recorded/.test(m))).toBe(true);
    db.close();
  });

  it("warns when many skills were received but no review decision was ever recorded (F6)", () => {
    const db = livenessDb();
    seedHealthy(db);
    db.exec(
      `UPDATE peer_reputation SET skills_received = 25, skills_accepted = 0, skills_rejected = 0`,
    );
    const w = warnsOf(inspectArtifactLiveness(db, NOW));
    expect(w.some((m) => /not one accept\/reject decision/.test(m))).toBe(true);
    db.close();
  });

  it("stays info below the received-review threshold", () => {
    const db = livenessDb();
    seedHealthy(db);
    db.exec(
      `UPDATE peer_reputation SET skills_received = 3, skills_accepted = 0, skills_rejected = 0`,
    );
    const results = inspectArtifactLiveness(db, NOW);
    expect(warnsOf(results).some((m) => /accept\/reject/.test(m))).toBe(false);
    expect(results.some((r) => r.level === "info" && /none reviewed yet/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("warns when curiosity targets are old and none ever resolved (F9)", () => {
    const db = livenessDb();
    seedHealthy(db);
    db.exec(`UPDATE curiosity_targets SET resolved_at = NULL, created_at = ${NOW - 10 * DAY}`);
    const w = warnsOf(inspectArtifactLiveness(db, NOW));
    expect(w.some((m) => /0 of 1 curiosity targets have EVER resolved/.test(m))).toBe(true);
    db.close();
  });

  it("warns when ALL curiosity progress is orphaned (F8 regression) but info on a legacy tail", () => {
    const db = livenessDb();
    seedHealthy(db);
    // Legacy tail: one orphan beside one live row → info, not warn.
    db.exec(`INSERT INTO curiosity_progress VALUES ('p2', 'dead-region')`);
    let results = inspectArtifactLiveness(db, NOW);
    expect(warnsOf(results).some((m) => /region ids/.test(m))).toBe(false);
    expect(results.some((r) => r.level === "info" && /orphaned legacy/.test(r.message))).toBe(true);
    // Full churn: every row orphaned → warn.
    db.exec(`UPDATE curiosity_progress SET region_id = 'dead-region'`);
    results = inspectArtifactLiveness(db, NOW);
    expect(warnsOf(results).some((m) => /ALL 2 curiosity progress rows/.test(m))).toBe(true);
    db.close();
  });

  it("warns on recent doubled executions but only info on pre-fix legacy doubles (F2)", () => {
    const db = livenessDb();
    seedHealthy(db);
    // Legacy double (30 days old).
    const old = NOW - 30 * DAY;
    db.exec(`
      INSERT INTO skill_executions VALUES ('e2', 'sk1', ${old}, ${old + 100});
      INSERT INTO skill_executions VALUES ('e3', 'sk1', ${old}, NULL);
    `);
    let results = inspectArtifactLiveness(db, NOW);
    expect(warnsOf(results).some((m) => /doubled/.test(m))).toBe(false);
    expect(results.some((r) => r.level === "info" && /pre-fix era/.test(r.message))).toBe(true);
    // Recent double → warn.
    db.exec(`
      INSERT INTO skill_executions VALUES ('e4', 'sk1', ${NOW - 1000}, ${NOW});
      INSERT INTO skill_executions VALUES ('e5', 'sk1', ${NOW - 1000}, NULL);
    `);
    results = inspectArtifactLiveness(db, NOW);
    expect(warnsOf(results).some((m) => /firing twice per call again/.test(m))).toBe(true);
    db.close();
  });

  it("warns on skills past the maturity gate never published (F5)", () => {
    const db = livenessDb();
    seedHealthy(db);
    db.exec(`
      UPDATE chunks SET published_at = NULL WHERE id = 'sk1';
      INSERT INTO skill_executions VALUES ('m1', 'sk1', ${NOW - 5000}, ${NOW - 4000});
      INSERT INTO skill_executions VALUES ('m2', 'sk1', ${NOW - 3000}, ${NOW - 2000});
    `);
    const w = warnsOf(inspectArtifactLiveness(db, NOW));
    expect(w.some((m) => /maturity gate but were never published/.test(m))).toBe(true);
    db.close();
  });

  it("warns on dream modes selected repeatedly with zero insights ever", () => {
    const db = livenessDb();
    seedHealthy(db);
    for (let i = 0; i < 6; i++) {
      db.prepare(`INSERT INTO dream_cycles VALUES (?, ?)`).run(
        `silent${i}`,
        JSON.stringify(["exploration", "mutation"]),
      );
    }
    const w = warnsOf(inspectArtifactLiveness(db, NOW));
    const hit = w.find((m) => /NEVER produced an insight/.test(m));
    expect(hit).toBeTruthy();
    expect(hit).toContain("exploration (6 runs)");
    expect(hit).not.toContain("mutation");
    db.close();
  });
});
