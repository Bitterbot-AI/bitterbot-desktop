import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCall } from "./skill-curator-judge.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { runFullCuratorPass, runHeuristicCuratorPass } from "./skill-curator.js";
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

describe("runFullCuratorPass — judge integration", () => {
  async function makeSkillRoot(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "skill-curator-full-test-"));
  }

  async function writeSkill(
    root: string,
    name: string,
    body: string,
    description = "test description",
  ): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    await fs.writeFile(
      file,
      `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
      "utf-8",
    );
    return file;
  }

  it("falls back to heuristic-only when no llmCall is provided", async () => {
    const store = newStore();
    for (let i = 0; i < 20; i++) {
      store.recordUsage({
        skillName: "flaky",
        success: i < 5,
        origin: "agent_authored",
        timestamp: NOW - (20 - i) * 60_000,
      });
    }
    const result = await runFullCuratorPass(store, {
      now: NOW,
      reportsDir: tmpRoot,
    });
    expect(result.heuristicReport.borderlineCandidates.length).toBe(1);
    expect(result.judgeOutcomes).toEqual([]);
  });

  it("applies an archive decision from the judge", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      await writeSkill(skillRoot, "flaky", "do flaky things");
      const store = newStore();
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () => '```yaml\naction: archive\nreason: "broken"\n```';
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      expect(result.judgeOutcomes.length).toBe(1);
      expect(result.judgeOutcomes[0]?.decision?.action).toBe("archive");
      expect(result.judgeOutcomes[0]?.applied).toBe(true);
      expect(store.get("flaky")?.state).toBe("archived");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("applies a consolidate decision when target exists", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      await writeSkill(skillRoot, "flaky", "flaky body", "narrow scope");
      await writeSkill(skillRoot, "target", "target body", "broader scope");
      const store = newStore();
      store.recordUsage({
        skillName: "target",
        success: true,
        origin: "agent_authored",
        timestamp: NOW - 1 * DAY,
      });
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () =>
        '```yaml\naction: consolidate\ninto: "target"\nreason: "subsumed"\n```';
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      expect(result.judgeOutcomes[0]?.applied).toBe(true);
      const flaky = store.get("flaky");
      expect(flaky?.state).toBe("archived");
      expect(flaky?.consolidatedInto).toBe("target");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("refuses to consolidate when target is missing", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      await writeSkill(skillRoot, "flaky", "body");
      const store = newStore();
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () =>
        '```yaml\naction: consolidate\ninto: "missing-skill"\nreason: "x"\n```';
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      expect(result.judgeOutcomes[0]?.applied).toBe(false);
      expect(result.judgeOutcomes[0]?.notes).toContain("not found");
      expect(store.get("flaky")?.state).toBe("active");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("applies a patch decision by rewriting frontmatter description", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      const filePath = await writeSkill(skillRoot, "flaky", "the body");
      const store = newStore();
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () =>
        '```yaml\naction: patch\nnew_description: "much clearer"\nreason: "rewording"\n```';
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      expect(result.judgeOutcomes[0]?.applied).toBe(true);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("description: much clearer");
      expect(content).toContain("the body"); // body preserved
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("dry-run does not mutate state or files", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      const filePath = await writeSkill(skillRoot, "flaky", "the body", "orig");
      const store = newStore();
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () => '```yaml\naction: archive\nreason: "broken"\n```';
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
        dryRun: true,
      });
      expect(result.judgeOutcomes[0]?.applied).toBe(false);
      expect(result.judgeOutcomes[0]?.notes).toContain("dry-run");
      expect(store.get("flaky")?.state).toBe("active");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("description: orig");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("records parse failures with rawOnFailure", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      await writeSkill(skillRoot, "flaky", "body");
      const store = newStore();
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () => "I have no opinion";
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      expect(result.judgeOutcomes[0]?.decision).toBeNull();
      expect(result.judgeOutcomes[0]?.rawOnFailure).toContain("no opinion");
      expect(store.get("flaky")?.state).toBe("active");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("caps the number of judge calls per pass", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      // Make 3 flaky skills, all flagged.
      for (const name of ["a", "b", "c"]) {
        await writeSkill(skillRoot, name, "body");
        const store = newStore(); // fresh store per iteration would lose data — see below.
        void store;
      }
      const store = newStore();
      for (const name of ["a", "b", "c"]) {
        for (let i = 0; i < 20; i++) {
          store.recordUsage({
            skillName: name,
            success: i < 5,
            origin: "agent_authored",
            timestamp: NOW - (20 - i) * 60_000,
          });
        }
      }
      let calls = 0;
      const llmCall: LlmCall = async () => {
        calls++;
        return '```yaml\naction: keep\nreason: "ok"\n```';
      };
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
        maxJudgeCalls: 2,
      });
      expect(calls).toBe(2);
      expect(result.judgeOutcomes.length).toBe(2);
      // The third borderline remains flagged for the next pass.
      expect(result.heuristicReport.borderlineCandidates.length).toBe(3);
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("notes when SKILL.md is missing from disk", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      const store = newStore();
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "ghost",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () => "```yaml\naction: keep\nreason: x\n```";
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      expect(result.judgeOutcomes[0]?.decision).toBeNull();
      expect(result.judgeOutcomes[0]?.notes).toContain("not found");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("writes a unified REPORT.md containing both heuristic and judge sections", async () => {
    const skillRoot = await makeSkillRoot();
    try {
      await writeSkill(skillRoot, "flaky", "body");
      const store = newStore();
      store.recordUsage({
        skillName: "stale",
        success: true,
        origin: "agent_authored",
        timestamp: NOW - 100 * DAY,
      });
      for (let i = 0; i < 20; i++) {
        store.recordUsage({
          skillName: "flaky",
          success: i < 5,
          origin: "agent_authored",
          timestamp: NOW - (20 - i) * 60_000,
        });
      }
      const llmCall: LlmCall = async () => '```yaml\naction: keep\nreason: "ok"\n```';
      const result = await runFullCuratorPass(store, {
        now: NOW,
        reportsDir: tmpRoot,
        skillRoots: [skillRoot],
        llmCall,
      });
      if (!result.reportPath) {
        throw new Error("expected reportPath");
      }
      const md = await fs.readFile(result.reportPath, "utf-8");
      expect(md).toContain("Transitions");
      expect(md).toContain("`stale`");
      expect(md).toContain("LLM-judge decisions");
      expect(md).toContain("`flaky`");
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });
});
