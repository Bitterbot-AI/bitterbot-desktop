/**
 * PLAN-52A: the memory section tells the model how to reach offloaded text,
 * but only when recall_range is actually available (static per agent, so the
 * cached prefix does not vary by session).
 */
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("system prompt recall_range line", () => {
  it("is present when recall_range is in the tool set", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      toolNames: ["memory_search", "recall_range", "deep_recall"],
    });
    expect(prompt).toContain("`recall_range` / `deep_recall`");
    expect(prompt).toContain("[Context offloaded]");
  });

  it("is absent otherwise", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      toolNames: ["memory_search", "deep_recall"],
    });
    expect(prompt).not.toContain("[Context offloaded]");
  });
});
