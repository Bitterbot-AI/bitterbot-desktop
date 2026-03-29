import { describe, expect, it } from "vitest";
import type { WorkspaceBootstrapFile } from "./workspace.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";

function makeBootstrapFile(overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile {
  return {
    name: "TOOLS.md",
    path: "/tmp/workspace/TOOLS.md",
    content: "alpha",
    missing: false,
    ...overrides,
  };
}

describe("buildSystemPromptReport", () => {
  it("counts injected chars when injected file paths are absolute", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/TOOLS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [file],
      injectedFiles: [{ path: "/tmp/workspace/policies/TOOLS.md", content: "trimmed" }],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("keeps legacy basename matching for injected files", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/TOOLS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [file],
      injectedFiles: [{ path: "TOOLS.md", content: "trimmed" }],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });
});
