import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const MINIMAL_PARAMS = {
  workspaceDir: "/tmp/workspace",
};

describe("buildAgentSystemPrompt — workflow section", () => {
  it("includes workflow management section in full mode", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      promptMode: "full",
    });

    expect(prompt).toContain("## Workflow Management");
    expect(prompt).toContain("### Task Planning");
    expect(prompt).toContain("call `plan` with a structured task list");
    expect(prompt).toContain("### Autonomous Execution Rules");
    expect(prompt).toContain("Keep working through your plan until EVERY task is done");
    expect(prompt).toContain("### Completion");
    expect(prompt).toContain("call the `complete` tool");
    expect(prompt).toContain("Finish all planned tasks before calling `complete`");
  });

  it("includes workflow section by default (no promptMode specified)", () => {
    const prompt = buildAgentSystemPrompt(MINIMAL_PARAMS);

    expect(prompt).toContain("## Workflow Management");
    expect(prompt).toContain("### Task Planning");
    expect(prompt).toContain("### Completion");
  });

  it("excludes workflow section in minimal mode", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      promptMode: "minimal",
    });

    expect(prompt).not.toContain("## Workflow Management");
    expect(prompt).not.toContain("### Autonomous Execution Rules");
    expect(prompt).not.toContain("call the `complete` tool");
  });

  it("excludes workflow section in none mode", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      promptMode: "none",
    });

    // "none" mode returns just basic identity
    expect(prompt).not.toContain("## Workflow Management");
  });

  it("workflow section appears between Work Planning and Safety", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      promptMode: "full",
    });

    const workPlanningIdx = prompt.indexOf("## Work Planning");
    const workflowIdx = prompt.indexOf("## Workflow Management");
    const safetyIdx = prompt.indexOf("## Safety");

    expect(workPlanningIdx).toBeGreaterThan(-1);
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(safetyIdx).toBeGreaterThan(-1);
    expect(workflowIdx).toBeGreaterThan(workPlanningIdx);
    expect(safetyIdx).toBeGreaterThan(workflowIdx);
  });
});

describe("buildAgentSystemPrompt — complete/plan in the Tooling line", () => {
  // Token-efficiency W4: the Tooling section lists tool NAMES only, on one
  // sorted line. Summaries live in the tool definitions themselves.
  it("lists complete when complete is in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["complete"],
    });

    expect(prompt).toContain("Tools: complete");
    expect(prompt).not.toContain("Signal that all tasks are finished");
  });

  it("lists plan when plan is in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["plan"],
    });

    expect(prompt).toContain("Tools: plan");
  });

  it("lists both, sorted in byte order regardless of discovery order", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["plan", "complete"],
    });

    expect(prompt).toContain("Tools: complete, plan");
  });

  it("omits complete/plan from the Tooling line when not in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["exec", "read"],
    });

    expect(prompt).toContain("Tools: exec, read");
    expect(prompt).not.toMatch(/Tools: .*\bcomplete\b/);
    expect(prompt).not.toMatch(/Tools: .*\bplan\b/);
  });
});
