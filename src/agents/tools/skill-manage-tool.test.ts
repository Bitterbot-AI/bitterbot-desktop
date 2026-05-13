import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { createSkillManageTool } from "./skill-manage-tool.js";

// These tests exercise the tool's argument validation + dispatch shape.
// End-to-end staging/promotion against the filesystem is covered by the
// underlying skill-manage.test.ts, skill-promote.test.ts, and
// skill-storage.test.ts which can redirect roots via resolveStorageRoots(
// { configDir }). The tool itself reads CONFIG_DIR at module init, which
// is not redirectable from this layer, so we don't assert on real on-disk
// writes here.

const minimalConfig: BitterbotConfig = { gateway: { hostId: "test-host" } } as BitterbotConfig;

function readPayload(result: { details?: unknown }): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

describe("createSkillManageTool", () => {
  it("returns null when no config is provided", () => {
    const tool = createSkillManageTool({});
    expect(tool).toBeNull();
  });

  it("registers under name=skill_manage with a thorough description", () => {
    const tool = createSkillManageTool({ config: minimalConfig });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("skill_manage");
    // Description must explain the staging/gate/promote workflow.
    const desc = (tool?.description ?? "").toLowerCase();
    expect(desc).toContain("stage");
    expect(desc).toContain("promote");
    expect(desc).toContain("rollback");
  });

  it("returns ok=false with structured error when content is missing for create", async () => {
    const tool = createSkillManageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const result = await tool.execute("test-call", {
      action: "create",
      name: "alpha",
      reason: "no content",
    });
    const payload = readPayload(result);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("content required");
  });

  // End-to-end create + promote is covered by skill-manage.test.ts and
  // skill-promote.test.ts directly against the same orchestrators. We don't
  // duplicate it here because CONFIG_DIR is module-init-evaluated, so the
  // tool's hard-coded storage roots cannot be redirected via runtime env
  // mutation. The dispatch tests below confirm the tool routes each action
  // to the correct orchestrator with the expected error semantics.

  it("rejects a patch with no oldString", async () => {
    const tool = createSkillManageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const result = await tool.execute("test-call", {
      action: "patch",
      name: "alpha",
      reason: "x",
      newString: "y",
    });
    expect(readPayload(result).error).toContain("oldString required");
  });

  it("rejects rollback without a version", async () => {
    const tool = createSkillManageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const result = await tool.execute("test-call", {
      action: "rollback",
      name: "alpha",
      reason: "x",
    });
    expect(readPayload(result).error).toContain("version required");
  });

  it("rejects consolidate without the into target", async () => {
    const tool = createSkillManageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const result = await tool.execute("test-call", {
      action: "consolidate",
      name: "alpha",
      reason: "x",
    });
    expect(readPayload(result).error).toContain("into required");
  });
});
