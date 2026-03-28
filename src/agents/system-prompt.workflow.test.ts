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

describe("buildAgentSystemPrompt — complete/plan tool summaries", () => {
  it("includes complete tool summary when complete is in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["complete"],
    });

    expect(prompt).toContain("- complete: Signal that all tasks are finished");
  });

  it("includes plan tool summary when plan is in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["plan"],
    });

    expect(prompt).toContain("- plan: Emit a structured task plan");
  });

  it("includes both when both are in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["plan", "complete"],
    });

    expect(prompt).toContain("- plan:");
    expect(prompt).toContain("- complete:");
  });

  it("plan appears before complete in tool listing (follows toolOrder)", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["plan", "complete"],
    });

    const planIdx = prompt.indexOf("- plan:");
    const completeIdx = prompt.indexOf("- complete:");
    expect(planIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeLessThan(completeIdx);
  });

  it("omits complete/plan from tool listing when not in toolNames", () => {
    const prompt = buildAgentSystemPrompt({
      ...MINIMAL_PARAMS,
      toolNames: ["exec", "read"],
    });

    expect(prompt).not.toContain("- complete:");
    expect(prompt).not.toContain("- plan:");
  });
});
