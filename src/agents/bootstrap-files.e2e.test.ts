import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  WORKING_MEMORY_MAX_CHARS,
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

  it("MEMORY.md is capped at 200 lines with a constant truncation line", async () => {
    const workspaceDir = await makeTempWorkspace("bitterbot-bootstrap-mem-");
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), body);
    const { contextFiles } = await resolveBootstrapContextForRun({ workspaceDir });
    const memory = contextFiles.find((f) => f.path.endsWith("MEMORY.md"));
    expect(memory).toBeDefined();
    expect(memory?.content).toContain(WORKING_MEMORY_TRUNCATED_LINE);
    expect(memory?.content).toContain("line 199");
    expect(memory?.content).not.toContain("line 200\n");
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
