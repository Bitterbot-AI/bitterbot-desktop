import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";

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
