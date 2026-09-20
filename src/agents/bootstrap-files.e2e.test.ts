import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  WORKING_MEMORY_MAX_CHARS,
  WORKING_MEMORY_MAX_LINES,
  WORKING_MEMORY_TRUNCATED_LINE,
  capWorkingMemoryContent,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
} from "./bootstrap-files.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.name === "EXTRA.md")).toBe(true);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("PLAN-44 Phase 3: skill-evolution validation sessions get no bootstrap context, not even [MISSING] markers or hook extras", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });
    // An empty scratch workspace: every bootstrap file is absent.
    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-val-");
    const control = await resolveBootstrapContextForRun({
      workspaceDir,
      sessionKey: "agent:main:main",
    });
    expect(control.contextFiles.some((f) => f.content.startsWith("[MISSING]"))).toBe(true);
    for (const sessionKey of [
      "agent:main:skill-evolve-val-abc",
      "agent:main:skill-evolve-val-peer-abc",
    ]) {
      const result = await resolveBootstrapContextForRun({ workspaceDir, sessionKey });
      expect(result.bootstrapFiles).toEqual([]);
      expect(result.contextFiles).toEqual([]);
    }
  });

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });
});

describe("token-efficiency W4: context injection gating and working-memory cap", () => {
  it("HEARTBEAT.md is injected only when includeHeartbeatFile is set", async () => {
    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-hb-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "# Heartbeat tasks\n- check x");
    const off = await resolveBootstrapContextForRun({ workspaceDir });
    expect(off.contextFiles.some((f) => f.path.endsWith("HEARTBEAT.md"))).toBe(false);
    // The report still sees the file as a bootstrap file.
    expect(off.bootstrapFiles.some((f) => f.name === "HEARTBEAT.md")).toBe(true);
    const on = await resolveBootstrapContextForRun({ workspaceDir, includeHeartbeatFile: true });
    expect(on.contextFiles.some((f) => f.path.endsWith("HEARTBEAT.md"))).toBe(true);
  });

  it("MEMORY.md is capped at WORKING_MEMORY_MAX_LINES lines with a constant truncation line", async () => {
    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-mem-");
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), body);
    const { contextFiles } = await resolveBootstrapContextForRun({ workspaceDir });
    const memory = contextFiles.find((f) => f.path.endsWith("MEMORY.md"));
    expect(memory).toBeDefined();
    expect(memory?.content).toContain(WORKING_MEMORY_TRUNCATED_LINE);
    expect(memory?.content).toContain(`line ${WORKING_MEMORY_MAX_LINES - 1}`);
    expect(memory?.content).not.toContain(`line ${WORKING_MEMORY_MAX_LINES}\n`);
  });

  it("capWorkingMemoryContent is a no-op under the caps and byte-stable over it", () => {
    expect(capWorkingMemoryContent("short")).toBe("short");
    const big = "x".repeat(WORKING_MEMORY_MAX_CHARS + 500);
    const a = capWorkingMemoryContent(big);
    const b = capWorkingMemoryContent(`${big}yyyy`);
    expect(a).toBe(b);
    expect(a.endsWith(WORKING_MEMORY_TRUNCATED_LINE)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(
      WORKING_MEMORY_MAX_CHARS + WORKING_MEMORY_TRUNCATED_LINE.length + 2,
    );
  });
});

describe("light heartbeat context (token-efficiency build, 2026-09-20 fix)", () => {
  const HEARTBEAT_SESSION = "agent:main:main:heartbeat";
  const OTHER_FILES = ["GENOME.md", "PROTOCOLS.md", "TOOLS.md", "MEMORY.md"];

  async function seedWorkspace(): Promise<string> {
    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-light-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "# Heartbeat tasks\n- check x");
    for (const name of ["GENOME.md", "PROTOCOLS.md", "TOOLS.md"]) {
      await fs.writeFile(path.join(workspaceDir, name), `# ${name}\nbody`);
    }
    // Over the 8000-char adaptive MEMORY.md budget but under the 200-line cap
    // (the live file that logged "10210 chars (limit 8000)").
    const memory = Array.from({ length: 100 }, (_, i) => `- fact ${i}: ${"m".repeat(110)}`).join(
      "\n",
    );
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memory);
    return workspaceDir;
  }

  it("injects HEARTBEAT.md only and never budgets or warns about dropped files", async () => {
    const workspaceDir = await seedWorkspace();
    const warnings: string[] = [];
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      sessionKey: HEARTBEAT_SESSION,
      includeHeartbeatFile: true,
      warn: (message) => warnings.push(message),
    });
    expect(contextFiles.map((f) => path.basename(f.path))).toEqual(["HEARTBEAT.md"]);
    for (const name of OTHER_FILES) {
      expect(contextFiles.some((f) => f.path.endsWith(name))).toBe(false);
    }
    // The report still sees the full bootstrap set (the runner filters it separately).
    expect(bootstrapFiles.some((f) => f.name === "MEMORY.md")).toBe(true);
    expect(warnings.filter((w) => w.includes("MEMORY.md"))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("an explicit lightContext hint wins over config", async () => {
    const workspaceDir = await seedWorkspace();
    const light = await resolveBootstrapContextForRun({
      workspaceDir,
      sessionKey: HEARTBEAT_SESSION,
      includeHeartbeatFile: true,
      lightContext: true,
      config: {
        agents: { defaults: { heartbeat: { lightContext: false } } },
      } as BitterbotConfig,
    });
    expect(light.contextFiles.map((f) => path.basename(f.path))).toEqual(["HEARTBEAT.md"]);
  });

  it("lightContext: false keeps the full set and the MEMORY.md truncation warning", async () => {
    const workspaceDir = await seedWorkspace();
    const warnings: string[] = [];
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      sessionKey: HEARTBEAT_SESSION,
      includeHeartbeatFile: true,
      config: {
        agents: { defaults: { heartbeat: { lightContext: false } } },
      } as BitterbotConfig,
      warn: (message) => warnings.push(message),
    });
    const names = contextFiles.map((f) => path.basename(f.path));
    expect(names).toContain("HEARTBEAT.md");
    for (const name of OTHER_FILES) {
      expect(names).toContain(name);
    }
    expect(warnings.some((w) => w.includes("MEMORY.md") && w.includes("truncating"))).toBe(true);
    const memory = contextFiles.find((f) => f.path.endsWith("MEMORY.md"));
    expect(memory?.content).toContain(WORKING_MEMORY_TRUNCATED_LINE);
    expect(memory?.content).not.toMatch(/kept \d+/);
  });

  it("a non-heartbeat turn is untouched by the light flag", async () => {
    const workspaceDir = await seedWorkspace();
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      sessionKey: "agent:main:main",
    });
    const names = contextFiles.map((f) => path.basename(f.path));
    expect(names).not.toContain("HEARTBEAT.md");
    for (const name of OTHER_FILES) {
      expect(names).toContain(name);
    }
  });
});
