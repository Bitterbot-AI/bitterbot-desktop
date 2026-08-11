/**
 * Daily health sweep: the diff behaviour is the whole point — a sweep that
 * reports everything every day is noise nobody reads, which is how the
 * already-correct checks went unheeded for weeks in the first place.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import {
  collectHealthFindings,
  findingKey,
  recordSweep,
  runHealthSweep,
  type SweepFinding,
} from "./health-sweep.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

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

const f = (section: string, message: string, level: "warn" | "error" = "warn"): SweepFinding => ({
  key: findingKey(section, message),
  section,
  level,
  message,
});

describe("findingKey", () => {
  it("ignores changing numbers so a persistent issue is not 'new' every day", () => {
    const a = findingKey("Subsystems", "Embedding backlog: 3,003/9,000 crystals lack embeddings");
    const b = findingKey("Subsystems", "Embedding backlog: 2,781/9,120 crystals lack embeddings");
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different problems", () => {
    expect(findingKey("Subsystems", "Embedding backlog")).not.toBe(
      findingKey("Subsystems", "Vector index absent"),
    );
    // Same message, different section = different finding.
    expect(findingKey("Economy", "same text")).not.toBe(findingKey("Subsystems", "same text"));
  });
});

describe("recordSweep diffing", () => {
  it("reports everything as new on the first sweep", () => {
    const result = recordSweep(db, [f("Subsystems", "Vector index absent")]);
    expect(result.newFindings).toHaveLength(1);
    expect(result.resolvedFindings).toHaveLength(0);
  });

  it("does NOT re-report an unchanged issue on the next sweep", () => {
    const finding = f("Subsystems", "Vector index absent: 1234 crystals affected");
    recordSweep(db, [finding], 1000);
    // Same problem, different count — must not surface as new.
    const second = recordSweep(
      db,
      [f("Subsystems", "Vector index absent: 5678 crystals affected")],
      2000,
    );
    expect(second.newFindings).toHaveLength(0);
    expect(second.resolvedFindings).toHaveLength(0);
  });

  it("surfaces a genuinely new problem", () => {
    recordSweep(db, [f("Subsystems", "Vector index absent")], 1000);
    const second = recordSweep(
      db,
      [f("Subsystems", "Vector index absent"), f("Economy", "2 settlements parked at held_review")],
      2000,
    );
    expect(second.newFindings.map((x) => x.section)).toEqual(["Economy"]);
  });

  it("reports a resolved issue", () => {
    recordSweep(db, [f("Subsystems", "Vector index absent")], 1000);
    const second = recordSweep(db, [], 2000);
    expect(second.resolvedFindings).toHaveLength(1);
    expect(second.newFindings).toHaveLength(0);
  });

  it("persists history and caps it", () => {
    for (let i = 0; i < 35; i++) {
      recordSweep(db, [f("Subsystems", `issue ${i}`)], 1000 + i);
    }
    const count = (db.prepare(`SELECT COUNT(*) c FROM health_sweeps`).get() as { c: number }).c;
    expect(count).toBeLessThanOrEqual(30);
  });
});

describe("collectHealthFindings", () => {
  it("returns only warn/error findings and never throws on a sparse DB", async () => {
    const findings = await collectHealthFindings(db, {} as BitterbotConfig);
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.every((x) => x.level === "warn" || x.level === "error")).toBe(true);
  });
});

describe("runHealthSweep", () => {
  it("completes end to end and records a row", async () => {
    const result = await runHealthSweep({ db, cfg: {} as BitterbotConfig });
    expect(result.at).toBeGreaterThan(0);
    const rows = (db.prepare(`SELECT COUNT(*) c FROM health_sweeps`).get() as { c: number }).c;
    expect(rows).toBe(1);
  });

  it("is idempotent in shape: a second immediate run reports nothing new", async () => {
    await runHealthSweep({ db, cfg: {} as BitterbotConfig });
    const second = await runHealthSweep({ db, cfg: {} as BitterbotConfig });
    expect(second.newFindings).toHaveLength(0);
  });
});
