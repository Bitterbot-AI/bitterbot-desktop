import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { collectSkillEvolutionChecks } from "./doctor-skill-evolution.js";

const NOW = Date.UTC(2026, 8, 7, 12);
const DAY = 86_400_000;

async function writeWiki(dir: string, files: Record<string, string>) {
  await fs.mkdir(path.join(dir, "skill-wiki"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, "skill-wiki", name), content, "utf-8");
  }
}

async function writeEvidence(dir: string, name: string, record: Record<string, unknown>) {
  const skillDir = path.join(dir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, ".evidence.json"),
    JSON.stringify({
      version: 1,
      name,
      generatedAt: NOW - 3_600_000,
      windowDays: 14,
      origin: "wiki-evolution",
      ladder: "canary",
      ladderAt: NOW - DAY,
      ladderBy: "gate",
      canary: null,
      modelDrift: null,
      reads: {
        total: 0,
        runs: 0,
        pass: 0,
        fail: 0,
        indeterminate: 0,
        successRate: null,
        maxEvidenceLevel: 0,
        lastReadAt: null,
      },
      lifetime: { usageCount: 0, successCount: 0, errorCount: 0, lastUsedAt: null },
      gate: null,
      models: { validatedOn: [], readBy: [] },
      descriptionRepairs: 0,
      publishedAt: null,
      gateHistory: [],
      ...record,
    }),
  );
}

function levels(results: Array<{ level: string; message: string }>) {
  return results.map((r) => `${r.level}: ${r.message.split("\n")[0]}`);
}

describe("doctor: skill evolution (PLAN-45 Phase 6)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-evo-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("disabled loop is one info line", async () => {
    const out = await collectSkillEvolutionChecks({
      config: { skills: { evolution: { enabled: false } } } as BitterbotConfig,
      now: NOW,
      trailOpts: { configDir: dir },
    });
    expect(levels(out)).toEqual([
      "info: Skill evolution: disabled (skills.evolution.enabled=false)",
    ]);
  });

  it("fresh node: tasks gate reachable through the canonical corpus, no iterations, no canary, no records", async () => {
    const out = await collectSkillEvolutionChecks({
      config: { skills: { evolution: {} } } as BitterbotConfig,
      now: NOW,
      trailOpts: { configDir: dir },
    });
    const text = levels(out);
    expect(text.some((l) => l.startsWith("ok: Validation gate: tasks mode"))).toBe(true);
    expect(text).toContain(
      "info: Evolution loop: no iteration recorded yet (runs from housekeeping on the cadence)",
    );
    expect(text).toContain("info: Canary monitor: no active canary");
    expect(text).toContain(
      "info: Evidence records: none yet (housekeeping writes .evidence.json per live skill)",
    );
  });

  it("stale loop, silent canary, over-age canary, stale evidence and crystallizer regrowth all warn", async () => {
    await writeWiki(dir, {
      "iterations.jsonl": `${JSON.stringify({ at: NOW - 4 * DAY, ran: false, reason: "cadence", cycleId: null, durationMs: 1, cursorBefore: null, cursorAfter: null, sampler: null, failureSignatures: null, maintainer: null, proposer: null })}\n`,
      "canary.json": JSON.stringify({
        version: 1,
        skills: {
          silent: {
            startedAt: NOW - 5 * DAY,
            bucketFraction: 0.5,
            descriptionAtStart: "d",
            reason: "gate",
            seed: "s",
          },
          ancient: {
            startedAt: NOW - 40 * DAY,
            bucketFraction: 0.5,
            descriptionAtStart: "d",
            reason: "gate",
            seed: "s",
          },
          healthy: {
            startedAt: NOW - 2 * DAY,
            bucketFraction: 0.5,
            descriptionAtStart: "d",
            reason: "gate",
            seed: "s",
          },
        },
      }),
      "canary-runs.jsonl": [
        ...Array.from({ length: 5 }, (_, i) =>
          JSON.stringify({
            runId: `r${i}`,
            skill: "healthy",
            ts: NOW - DAY,
            exposed: i % 2 === 0,
            read: false,
            eligible: true,
            label: "pass",
            outcomeLevel: 3,
            model: null,
            origin: "cli",
            credited: true,
            sessionKey: null,
          }),
        ),
        JSON.stringify({
          runId: "r-ancient",
          skill: "ancient",
          ts: NOW - DAY,
          exposed: true,
          read: true,
          eligible: true,
          label: "pass",
          outcomeLevel: 3,
          model: null,
          origin: "cli",
          credited: true,
          sessionKey: null,
        }),
      ].join("\n"),
    });
    await writeEvidence(dir, "old-one", { generatedAt: NOW - 5 * DAY });
    const dbPath = path.join(dir, "memory.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT, source TEXT)");
    db.exec(
      "INSERT INTO chunks (path, source) VALUES ('crystallizer/auto','skills'), ('crystallizer/auto','skills'), ('x','y')",
    );
    db.close();

    const out = await collectSkillEvolutionChecks({
      config: { skills: { evolution: { cadenceHours: 24 } } } as BitterbotConfig,
      now: NOW,
      dbPath,
      trailOpts: { configDir: dir },
    });
    const text = levels(out);
    expect(text).toContain(
      "warn: Evolution loop: last iteration 96h ago, cadence 24h; housekeeping is not reaching it",
    );
    expect(
      text.some((l) => l.startsWith("warn: Canary with no exposure rows after 5.0 days: silent")),
    ).toBe(true);
    expect(
      text.some((l) =>
        l.startsWith(
          "warn: Canary past its 28-day maximum with no verdict: ancient: 1 exposed / 0 control",
        ),
      ),
    ).toBe(true);
    expect(text).toContain(
      "ok: Canary monitor: healthy: 3 exposed / 2 control credited runs, 2.0d old, next look at 8",
    );
    expect(text).toContain(
      "warn: Evidence records: all 1 older than 2 days; housekeeping is not rebuilding them",
    );
    expect(text.some((l) => l.startsWith("warn: Crystallizer: 2 auto-minted chunks present"))).toBe(
      true,
    );
  });

  it("healthy records and a purged crystallizer are ok lines", async () => {
    await writeEvidence(dir, "curl-timeout-guard", { ladder: "stable" });
    await writeEvidence(dir, "local-notes", { ladder: "unmanaged", origin: "local" });
    const dbPath = path.join(dir, "memory.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT, source TEXT)");
    db.close();
    const out = await collectSkillEvolutionChecks({
      config: { skills: { evolution: {} } } as BitterbotConfig,
      now: NOW,
      dbPath,
      trailOpts: { configDir: dir },
    });
    const text = levels(out);
    expect(text).toContain("ok: Evidence records: 2 live skills, 1 managed (1 stable)");
    expect(text).toContain(
      "ok: Crystallizer: 0 auto-minted chunks (purged by migration v63, none since)",
    );
  });
});
