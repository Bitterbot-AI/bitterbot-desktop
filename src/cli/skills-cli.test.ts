import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { SkillEntry } from "../agents/skills.js";
import type { SkillEvidenceRecord } from "../memory/skill-evolution/evidence-record.js";
import { captureEnv } from "../test-utils/env.js";
import {
  formatSkillEvidence,
  formatSkillInfo,
  formatSkillsCheck,
  formatSkillsList,
} from "./skills-cli.format.js";

// Unit tests: don't pay the runtime cost of loading/parsing the real skills loader.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  loadSkillsFromDir: () => ({ skills: [] }),
  formatSkillsForPrompt: () => "",
}));

function createMockSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "test-skill",
    description: "A test skill",
    source: "bundled",
    bundled: false,
    filePath: "/path/to/SKILL.md",
    baseDir: "/path/to",
    skillKey: "test-skill",
    emoji: "🧪",
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createMockReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    skills,
  };
}

describe("skills-cli", () => {
  describe("formatSkillsList", () => {
    it("formats empty skills list", () => {
      const report = createMockReport([]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("No skills found");
      expect(output).toContain("bitterbot skills");
    });

    it("formats skills list with eligible skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "test-bundled",
          description: "Capture UI screenshots",
          emoji: "📸",
          eligible: true,
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("test-bundled");
      expect(output).toContain("📸");
      expect(output).toContain("✓");
    });

    it("formats skills list with disabled skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "disabled-skill",
          disabled: true,
          eligible: false,
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("disabled-skill");
      expect(output).toContain("disabled");
    });

    it("formats skills list with missing requirements", () => {
      const report = createMockReport([
        createMockSkill({
          name: "needs-stuff",
          eligible: false,
          missing: {
            bins: ["ffmpeg"],
            anyBins: ["rg", "grep"],
            env: ["API_KEY"],
            config: [],
            os: ["darwin"],
          },
        }),
      ]);
      const output = formatSkillsList(report, { verbose: true });
      expect(output).toContain("needs-stuff");
      expect(output).toContain("missing");
      expect(output).toContain("anyBins");
      expect(output).toContain("os:");
    });

    it("filters to eligible only with --eligible flag", () => {
      const report = createMockReport([
        createMockSkill({ name: "eligible-one", eligible: true }),
        createMockSkill({
          name: "not-eligible",
          eligible: false,
          disabled: true,
        }),
      ]);
      const output = formatSkillsList(report, { eligible: true });
      expect(output).toContain("eligible-one");
      expect(output).not.toContain("not-eligible");
    });

    it("outputs JSON with --json flag", () => {
      const report = createMockReport([createMockSkill({ name: "json-skill" })]);
      const output = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.skills).toHaveLength(1);
      expect(parsed.skills[0].name).toBe("json-skill");
    });
  });

  describe("formatSkillInfo", () => {
    it("returns not found message for unknown skill", () => {
      const report = createMockReport([]);
      const output = formatSkillInfo(report, "unknown-skill", {});
      expect(output).toContain("not found");
      expect(output).toContain("bitterbot skills");
    });

    it("shows detailed info for a skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "detailed-skill",
          description: "A detailed description",
          homepage: "https://example.com",
          requirements: {
            bins: ["node"],
            anyBins: ["rg", "grep"],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
          missing: {
            bins: [],
            anyBins: [],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
        }),
      ]);
      const output = formatSkillInfo(report, "detailed-skill", {});
      expect(output).toContain("detailed-skill");
      expect(output).toContain("A detailed description");
      expect(output).toContain("https://example.com");
      expect(output).toContain("node");
      expect(output).toContain("Any binaries");
      expect(output).toContain("API_KEY");
    });

    it("outputs JSON with --json flag", () => {
      const report = createMockReport([createMockSkill({ name: "info-skill" })]);
      const output = formatSkillInfo(report, "info-skill", { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.name).toBe("info-skill");
    });
  });

  describe("formatSkillsCheck", () => {
    it("shows summary of skill status", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-1", eligible: true }),
        createMockSkill({ name: "ready-2", eligible: true }),
        createMockSkill({
          name: "not-ready",
          eligible: false,
          missing: { bins: ["go"], anyBins: [], env: [], config: [], os: [] },
        }),
        createMockSkill({ name: "disabled", eligible: false, disabled: true }),
      ]);
      const output = formatSkillsCheck(report, {});
      expect(output).toContain("2"); // eligible count
      expect(output).toContain("ready-1");
      expect(output).toContain("ready-2");
      expect(output).toContain("not-ready");
      expect(output).toContain("go"); // missing binary
      expect(output).toContain("bitterbot skills");
    });

    it("outputs JSON with --json flag", () => {
      const report = createMockReport([
        createMockSkill({ name: "skill-1", eligible: true }),
        createMockSkill({ name: "skill-2", eligible: false }),
      ]);
      const output = formatSkillsCheck(report, { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.summary.eligible).toBe(1);
      expect(parsed.summary.total).toBe(2);
    });
  });

  describe("integration: loads real skills from bundled directory", () => {
    let tempWorkspaceDir = "";
    let tempBundledDir = "";
    let envSnapshot: ReturnType<typeof captureEnv>;
    let buildWorkspaceSkillStatus: typeof import("../agents/skills-status.js").buildWorkspaceSkillStatus;

    beforeAll(async () => {
      envSnapshot = captureEnv(["BITTERBOT_BUNDLED_SKILLS_DIR"]);
      tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-skills-test-"));
      tempBundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-bundled-skills-test-"));
      process.env.BITTERBOT_BUNDLED_SKILLS_DIR = tempBundledDir;
      ({ buildWorkspaceSkillStatus } = await import("../agents/skills-status.js"));
    });

    afterAll(() => {
      if (tempWorkspaceDir) {
        fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
      }
      if (tempBundledDir) {
        fs.rmSync(tempBundledDir, { recursive: true, force: true });
      }
      envSnapshot.restore();
    });

    const createEntries = (): SkillEntry[] => {
      const baseDir = path.join(tempWorkspaceDir, "test-bundled");
      return [
        {
          skill: {
            name: "test-bundled",
            description: "Capture UI screenshots",
            source: "bitterbot-bundled",
            filePath: path.join(baseDir, "SKILL.md"),
            baseDir,
          } as SkillEntry["skill"],
          frontmatter: {},
          metadata: { emoji: "📸" },
        },
      ];
    };

    it("loads bundled skills and formats them", async () => {
      const entries = createEntries();
      const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
        managedSkillsDir: "/nonexistent",
        entries,
      });

      // Should have loaded some skills
      expect(report.skills.length).toBeGreaterThan(0);

      // Format should work without errors
      const listOutput = formatSkillsList(report, {});
      expect(listOutput).toContain("Skills");

      const checkOutput = formatSkillsCheck(report, {});
      expect(checkOutput).toContain("Total:");

      // JSON output should be valid
      const jsonOutput = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.skills).toBeInstanceOf(Array);
    });

    it("formats info for a real bundled skill (test-bundled)", async () => {
      const entries = createEntries();
      const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
        managedSkillsDir: "/nonexistent",
        entries,
      });

      // test-bundled is a bundled skill that should always exist
      const testBundled = report.skills.find((s) => s.name === "test-bundled");
      if (!testBundled) {
        throw new Error("test-bundled fixture skill missing");
      }

      const output = formatSkillInfo(report, "test-bundled", {});
      expect(output).toContain("test-bundled");
      expect(output).toContain("Details:");
    });
  });
});

describe("formatSkillEvidence (PLAN-45 Phase 6)", () => {
  const NOW = Date.UTC(2026, 8, 7, 12);
  function record(overrides: Partial<SkillEvidenceRecord> = {}): SkillEvidenceRecord {
    return {
      version: 1,
      name: "curl-timeout-guard",
      generatedAt: NOW - 3_600_000,
      windowDays: 14,
      origin: "wiki-evolution",
      ladder: "canary",
      ladderAt: NOW - 2 * 86_400_000,
      ladderBy: "gate",
      canary: { startedAt: NOW - 2 * 86_400_000, endedAt: null, reason: "gate" },
      modelDrift: null,
      reads: {
        total: 7,
        runs: 6,
        pass: 5,
        fail: 1,
        indeterminate: 1,
        successRate: 5 / 6,
        maxEvidenceLevel: 3,
        lastReadAt: NOW - 7_200_000,
      },
      lifetime: { usageCount: 9, successCount: 7, errorCount: 1, lastUsedAt: NOW - 7_200_000 },
      gate: {
        verdict: "accepted",
        mode: "tasks",
        pValue: 0.031,
        wins: 6,
        losses: 1,
        trials: 21,
        trialsPerTask: 3,
        corpusVersion: "gen5",
        candidateReadRate: { capability: 0.9, regression: 0.1 },
        tokens: { incumbent: 5000, candidate: 4200 },
        validatedAt: NOW - 3 * 86_400_000,
      },
      models: { validatedOn: ["anthropic/claude-opus-4-8"], readBy: ["anthropic/claude-opus-4-8"] },
      descriptionRepairs: 1,
      publishedAt: null,
      gateHistory: [
        {
          at: NOW - 3 * 86_400_000,
          action: "promote",
          verdict: "accepted",
          score: 0.86,
          detail: null,
        },
      ],
      ...overrides,
    };
  }

  it("lists managed skills only by default and everything with --all", () => {
    const records = [record(), record({ name: "local-notes", ladder: "unmanaged", gate: null })];
    const listed = formatSkillEvidence(records, undefined, { json: false }, NOW);
    expect(listed).toContain("curl-timeout-guard");
    expect(listed).not.toContain("local-notes");
    expect(listed).toContain("gate accepted");
    const all = formatSkillEvidence(records, undefined, { json: false, all: true }, NOW);
    expect(all).toContain("local-notes");
    expect(JSON.parse(formatSkillEvidence(records, undefined, { json: true }, NOW))).toHaveLength(
      1,
    );
  });

  it("renders one record with the ladder, gate, canary and read numbers verbatim from the record", () => {
    const out = formatSkillEvidence([record()], "curl-timeout-guard", { json: false }, NOW);
    expect(out).toContain("canary");
    expect(out).toContain("started 2d ago (gate), running");
    expect(out).toContain("accepted (tasks mode, p=0.031)");
    expect(out).toContain("6 wins / 1 losses over 21 trials (3 per task)");
    expect(out).toContain("capability 90%, regression 10%");
    expect(out).toContain(
      "7 in 6 runs; pass 5, fail 1, indeterminate 1; success 83%; max evidence level L3",
    );
    expect(out).toContain("Description repairs:");
    expect(out).toContain("promote");
    expect(
      JSON.parse(formatSkillEvidence([record()], "curl-timeout-guard", { json: true }, NOW)).name,
    ).toBe("curl-timeout-guard");
  });

  it("explains a missing record instead of inventing one", () => {
    const out = formatSkillEvidence([], "nope", { json: false }, NOW);
    expect(out).toContain('No evidence record for "nope"');
    expect(formatSkillEvidence([], undefined, { json: false }, NOW)).toContain(
      "No evidence records yet",
    );
    expect(JSON.parse(formatSkillEvidence([], "nope", { json: true }, NOW))).toEqual({
      error: "not found",
      skill: "nope",
    });
  });
});
