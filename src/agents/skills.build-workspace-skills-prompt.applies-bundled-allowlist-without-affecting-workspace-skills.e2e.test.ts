import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

describe("buildWorkspaceSkillsPrompt", () => {
  it("applies bundled allowlist without affecting workspace skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "test-bundled");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "test-bundled",
      description: "Capture UI",
      body: "# Test Bundled Skill\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { allowBundled: ["missing-skill"] } },
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("test-bundled");
  });
});
