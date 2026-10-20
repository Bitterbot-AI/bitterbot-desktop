import { describe, expect, it } from "vitest";
import { CACHE_BOUNDARY_MARKER, buildAgentSystemPrompt } from "./system-prompt.js";

const prompt = (model: string) =>
  buildAgentSystemPrompt({
    workspaceDir: "/tmp/workspace",
    runtimeInfo: { model, defaultModel: "anthropic/claude-sonnet-5-5" },
  });

describe("the agent is told which model it runs on", () => {
  it("names this turn's model on its own line, after a mid-conversation switch too", () => {
    // Same conversation, switched from Fable 5.1 to Opus 5.5 between turns.
    const fable = prompt("anthropic/claude-fable-5-1");
    const opus = prompt("anthropic/claude-opus-5-5");
    expect(fable).toContain(
      "Model: you are running on Claude Fable 5.1 (anthropic/claude-fable-5-1) for this turn.",
    );
    expect(opus).toContain(
      "Model: you are running on Claude Opus 5.5 (anthropic/claude-opus-5-5) for this turn.",
    );
    expect(opus).not.toContain("claude-fable-5-1");
    expect(opus).toContain("answer from this line, not from memory");
    expect(opus).toContain(
      "New conversations start on Claude Sonnet 5.5 (anthropic/claude-sonnet-5-5).",
    );
  });

  it("sits after the cache boundary, so a switch never changes the cached part", () => {
    const fable = prompt("anthropic/claude-fable-5-1");
    const opus = prompt("anthropic/claude-opus-5-5");
    const stable = (p: string) => p.slice(0, p.indexOf(CACHE_BOUNDARY_MARKER));
    expect(fable.indexOf("Model: you are running on")).toBeGreaterThan(
      fable.indexOf(CACHE_BOUNDARY_MARKER),
    );
    expect(stable(fable)).toBe(stable(opus));
  });

  it("omits the default note when this turn runs on the default, and non-Claude ids stay as they are", () => {
    const p = buildAgentSystemPrompt({
      workspaceDir: "/tmp/workspace",
      runtimeInfo: { model: "openai/gpt-5.5", defaultModel: "openai/gpt-5.5" },
    });
    expect(p).toContain("Model: you are running on openai/gpt-5.5 for this turn.");
    expect(p).not.toContain("New conversations start on");
  });
});
