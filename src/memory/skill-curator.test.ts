import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { runHeuristicCuratorPass } from "./skill-curator.js";
import { SkillLifecycleStore } from "./skill-lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function newStore(): SkillLifecycleStore {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
  });
  runMigrations(db);
  return new SkillLifecycleStore(db);
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-curator-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("runHeuristicCuratorPass", () => {
  it("applies a stale-by-age transition in live mode and writes a report", async () => {
    const store = newStore();
    store.recordUsage({
      skillName: "old-skill",
      success: true,
      origin: "agent_authored",
      timestamp: NOW - 100 * DAY,
    });

    const { report, reportPath } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
    });

    expect(report.transitions.length).toBe(1);
    expect(report.transitions[0]?.toState).toBe("stale");
    expect(store.get("old-skill")?.state).toBe("stale");
    expect(report.appliedWrites).toBe(true);
    expect(reportPath).not.toBeNull();
    if (reportPath) {
      const md = await fs.readFile(reportPath, "utf-8");
      expect(md).toContain("`old-skill`");
    }
  });

  it("dry-run leaves the DB untouched", async () => {
    const store = newStore();
    store.recordUsage({
      skillName: "old-skill",
      success: true,
      origin: "agent_authored",
      timestamp: NOW - 100 * DAY,
    });

    const { report, reportPath } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
      dryRun: true,
    });

    expect(report.transitions.length).toBe(1);
    expect(store.get("old-skill")?.state).toBe("active");
    expect(report.appliedWrites).toBe(false);
    // Dry-run defaults writeReport=false; nothing should land on disk.
    expect(reportPath).toBeNull();
  });

  it("dry-run respects an explicit writeReport=true", async () => {
    const store = newStore();
    store.recordUsage({
      skillName: "old-skill",
      success: true,
      origin: "agent_authored",
      timestamp: NOW - 100 * DAY,
    });

    const { reportPath } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
      dryRun: true,
      writeReport: true,
    });
    expect(reportPath).not.toBeNull();
  });

  it("never touches pinned skills, but lists them in pinnedSkipped", async () => {
    const store = newStore();
    store.recordUsage({
      skillName: "pinned-old",
      success: true,
      origin: "agent_authored",
      timestamp: NOW - 500 * DAY,
    });
    store.pin("pinned-old");

    const { report } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
    });
    expect(report.transitions).toEqual([]);
    expect(report.pinnedSkipped).toContain("pinned-old");
    expect(store.get("pinned-old")?.state).toBe("active");
  });

  it("never touches non-agent_authored skills", async () => {
    const store = newStore();
    store.recordUsage({
      skillName: "user-old",
      success: true,
      origin: "workspace",
      timestamp: NOW - 500 * DAY,
    });

    const { report } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
    });
    expect(report.totalCandidates).toBe(0);
    expect(report.transitions).toEqual([]);
    expect(store.get("user-old")?.state).toBe("active");
  });

  it("flags high-error skills as borderline without auto-archiving", async () => {
    const store = newStore();
    for (let i = 0; i < 20; i++) {
      store.recordUsage({
        skillName: "flaky-skill",
        success: i < 5,
        origin: "agent_authored",
        timestamp: NOW - (20 - i) * 60 * 1000,
      });
    }

    const { report } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
    });
    expect(report.borderlineCandidates.length).toBe(1);
    expect(report.borderlineCandidates[0]?.skillName).toBe("flaky-skill");
    expect(report.transitions).toEqual([]);
    expect(store.get("flaky-skill")?.state).toBe("active");
  });

  it("writes the report atomically — the final file always exists once it's written", async () => {
    const store = newStore();
    store.recordUsage({
      skillName: "old-skill",
      success: true,
      origin: "agent_authored",
      timestamp: NOW - 100 * DAY,
    });

    const { reportPath } = await runHeuristicCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
    });
    if (!reportPath) {
      throw new Error("expected reportPath");
    }
    const stat = await fs.stat(reportPath);
    expect(stat.isFile()).toBe(true);
    expect(path.basename(reportPath)).toBe("REPORT.md");
  });
});
