import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";

// Phase 2: SkillStatusEntry now carries a single-value `state` enum plus
// `reasons[]` and `platformLabel`. The renderer relies on this; if the
// derivation drifts, the UI starts mis-categorizing skills.
describe("buildWorkspaceSkillStatus state derivation", () => {
  const incompatibleOs = process.platform === "darwin" ? "win32" : "darwin";

  it("marks ready when nothing is wrong", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-state-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "ok-skill"),
      name: "ok-skill",
      description: "All good",
    });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const entry = report.skills.find((s) => s.skillKey === "ok-skill");
    expect(entry?.state).toBe("ready");
    expect(entry?.reasons).toEqual([]);
  });

  it("prefers OS mismatch over user disable (hard-disable wins)", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-state-os-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "wrong-os"),
      name: "wrong-os",
      description: "Won't run here",
      metadata: `{"bitterbot": {"os": ["${incompatibleOs}"]}}`,
    });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: {
        skills: { entries: { "wrong-os": { enabled: false } } },
      },
    });
    const entry = report.skills.find((s) => s.skillKey === "wrong-os");
    expect(entry?.state).toBe("missing-os");
    expect(entry?.platformLabel).toBeDefined();
  });

  it("marks user-disabled when otherwise eligible", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-state-off-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "off-skill"),
      name: "off-skill",
      description: "Toggled off",
    });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { entries: { "off-skill": { enabled: false } } } },
    });
    const entry = report.skills.find((s) => s.skillKey === "off-skill");
    expect(entry?.state).toBe("disabled-by-user");
  });

  it("marks missing-bin when a required binary is absent", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-state-bin-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "needs-bin"),
      name: "needs-bin",
      description: "Wants a bin",
      metadata: `{"bitterbot": {"requires": {"bins": ["this-binary-does-not-exist-xyzzy"]}}}`,
    });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const entry = report.skills.find((s) => s.skillKey === "needs-bin");
    expect(entry?.state).toBe("missing-bin");
    expect(entry?.reasons.join(" ")).toContain("this-binary-does-not-exist-xyzzy");
  });
});
