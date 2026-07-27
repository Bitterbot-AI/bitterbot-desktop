import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const probeSqliteVec = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../memory/sqlite-vec.js", () => ({
  probeSqliteVec,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider,
}));

import { runMemorySearchChecks } from "./doctor-memory-search.js";
import { doctorFindings, resetDoctorOutcome } from "./doctor-outcome.js";
import { detectLegacyWorkspaceDirs } from "./doctor-workspace.js";

describe("runMemorySearchChecks", () => {
  const cfg = {} as BitterbotConfig;
  const findings = () => doctorFindings().filter((f) => f.section === "Memory search");
  const warns = () => findings().filter((f) => f.level === "warn");

  beforeEach(() => {
    resetDoctorOutcome();
    note.mockReset();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    probeSqliteVec.mockReset();
    probeSqliteVec.mockResolvedValue({ ok: true });
  });

  it("reports healthy (no warns) when remote apiKey is configured for explicit provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      local: {},
      remote: { apiKey: "from-config" },
    });

    await runMemorySearchChecks(cfg);

    expect(warns()).toEqual([]);
    // Healthy is now an explicit ok finding, not silence — a healthy section
    // must be distinguishable in --json from one that never ran.
    expect(findings().some((f) => f.level === "ok" && /openai/.test(f.message))).toBe(true);
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("reports healthy in auto mode when remote apiKey is configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: { apiKey: "from-config" },
    });

    await runMemorySearchChecks(cfg);

    expect(warns()).toEqual([]);
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("resolves provider auth from the default agent directory", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: GEMINI_API_KEY",
      mode: "api-key",
    });

    await runMemorySearchChecks(cfg);

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "google",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(warns()).toEqual([]);
  });

  it("records a warn finding when sqlite-vec fails to load, even with a healthy provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      local: {},
      remote: { apiKey: "from-config" },
    });
    probeSqliteVec.mockResolvedValue({ ok: false, error: "vec0 not found" });

    await runMemorySearchChecks(cfg);

    expect(probeSqliteVec).toHaveBeenCalled();
    // The finding is structured (visible to --json and the rollup), not just prose.
    const vecWarn = warns().find((f) => /sqlite-vec extension did not load/.test(f.message));
    expect(vecWarn).toBeTruthy();
    expect(vecWarn?.message).toContain("keyword-only");
    expect(vecWarn?.message).toContain("vec0 not found");
  });
});

describe("detectLegacyWorkspaceDirs", () => {
  it("returns active workspace and no legacy dirs", () => {
    const workspaceDir = "/home/user/bitterbot";
    const detection = detectLegacyWorkspaceDirs({ workspaceDir });
    expect(detection.activeWorkspace).toBe(path.resolve(workspaceDir));
    expect(detection.legacyDirs).toEqual([]);
  });
});
