/**
 * PLAN-64 Phase 1b: the practices lines of `bitterbot doctor`.
 *
 * Under test: nothing is reported on a database from before practices, the
 * status and counter lines are generated from the tables, and a repeat (the
 * owner had to say an active practice again) is the one thing that warns.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { PracticesStore } from "../memory/practices.js";
import { TaskTypesStore } from "../memory/task-types.js";
import { inspectPractices } from "./doctor-memory-system.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

describe("inspectPractices", () => {
  it("says nothing on a database without the practices tables", () => {
    const db = new DatabaseSync(":memory:");
    expect(inspectPractices(db)).toEqual([]);
    db.close();
  });

  it("reports practices by status and the event counters", () => {
    const db = makeDb();
    const practices = new PracticesStore(db);
    new TaskTypesStore(db).adopt({
      slug: "repo-stats",
      label: "repo stats",
      exemplars: ["How many clones did your repo get yesterday?"],
      occurrences: 3,
      distinctDays: 3,
      firstSeen: 1,
      lastSeen: 2,
      recurring: true,
    });
    const active = practices.upsert({
      statement: "Give the numbers first.",
      scope: "task:repo-stats",
      source: "owner",
    });
    const yes = practices.upsert({
      statement: "Include npm downloads.",
      scope: "task:repo-stats",
      source: "extraction",
    });
    const no = practices.upsert({
      statement: "Include views and traffic.",
      scope: "task:repo-stats",
      source: "extraction",
    });
    practices.upsert({ statement: "Mention open pull requests.", source: "extraction" });
    if (!active.ok || !yes.ok || !no.ok) {
      throw new Error("seed failed");
    }
    practices.recordApplied([active.practice.id], { turnKey: "r1" });
    practices.recordOffer(yes.practice.id, { sessionId: "s1" });
    practices.recordOffer(no.practice.id, { sessionId: "s1" });
    practices.activate(yes.practice.id, Date.now(), "offer");
    practices.suppress(no.practice.id);
    const lines = inspectPractices(db);
    expect(lines.map((l) => l.level)).toEqual(["info", "info"]);
    expect(lines[0]!.message).toBe(
      "Practices: 2 active, 1 candidate, 1 declined, 0 retired; 1 recurring task type(s)",
    );
    expect(lines[1]!.message).toBe(
      "Practice counters: applied 1, repeats 0, offers 2 (1 confirmed, 1 declined)",
    );

    practices.recordRepeat(active.practice.id, { via: "correction" });
    const withRepeat = inspectPractices(db);
    expect(withRepeat).toHaveLength(3);
    expect(withRepeat[1]!.message).toContain("repeats 1");
    expect(withRepeat[2]).toMatchObject({ level: "warn" });
    expect(withRepeat[2]!.message).toContain("1 time(s) you had to repeat");
    db.close();
  });
});
