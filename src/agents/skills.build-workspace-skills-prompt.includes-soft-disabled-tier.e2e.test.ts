import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";

// Phase 4 Tier B: skills toggled off by the user but otherwise eligible
// must surface to the agent as suggestable, with an explicit suggest policy.
// OS-incompatible / missing-requirement skills must not leak into Tier B.
describe("buildWorkspaceSkillSnapshot soft-disabled tier", () => {
  it("lists user-disabled-but-eligible skills with the suggest policy", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-soft-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "ready-skill"),
      name: "ready-skill",
      description: "Always available",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "off-skill"),
      name: "off-skill",
      description: "User disabled this one",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config: {
        skills: {
          entries: {
            "off-skill": { enabled: false },
          },
        },
      },
    });

    expect(snapshot.prompt).toContain("ready-skill");
    expect(snapshot.prompt).toContain("[Skills available but disabled by user]");
    expect(snapshot.prompt).toContain("off-skill: User disabled this one");
    expect(snapshot.prompt).toContain("Suggest at most one per turn");
    // off-skill is in soft-disabled tier; it should NOT appear in the active
    // skills array surfaced to consumers as enabled.
    expect(snapshot.skills.some((s) => s.name === "off-skill")).toBe(false);
    expect(snapshot.skills.some((s) => s.name === "ready-skill")).toBe(true);
  });

  it("hides OS-incompatible skills from both tiers (hard-disable)", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-os-"));
    const incompatible = process.platform === "darwin" ? "win32" : "darwin";
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "wrong-os"),
      name: "wrong-os",
      description: "Should not surface",
      metadata: `{"bitterbot": {"os": ["${incompatible}"]}}`,
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "off-skill"),
      name: "off-skill",
      description: "User disabled but compatible",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config: {
        skills: {
          entries: { "off-skill": { enabled: false } },
        },
      },
    });

    expect(snapshot.prompt).not.toContain("wrong-os");
    expect(snapshot.prompt).toContain("off-skill");
  });

  it("emits no soft-disabled section when nothing is soft-disabled", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-empty-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "ready-skill"),
      name: "ready-skill",
      description: "Active",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config: { skills: { entries: {} } },
    });

    expect(snapshot.prompt).toContain("ready-skill");
    expect(snapshot.prompt).not.toContain("[Skills available but disabled by user]");
  });
});
