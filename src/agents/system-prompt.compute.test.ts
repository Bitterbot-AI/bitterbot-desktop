/**
 * PLAN-57 Phase 0: the static "Compute Pools" section.
 *
 * Contract: present exactly when the `compute` tool is available and the
 * prompt is not minimal; byte-identical from one build to the next (it sits
 * above the cache boundary); carries no numbers, because live state belongs
 * to the tool and to the tail block.
 */
import { describe, expect, it } from "vitest";
import { CACHE_BOUNDARY_MARKER, buildAgentSystemPrompt } from "./system-prompt.js";

const base = { workspaceDir: "/tmp/bitterbot" };

describe("compute section in the system prompt", () => {
  it("is absent when the compute tool is not available", () => {
    const prompt = buildAgentSystemPrompt({ ...base, toolNames: ["wallet", "exec"] });
    expect(prompt).not.toContain("## Compute Pools");
  });

  it("is present when the compute tool is available, and names the rules", () => {
    const prompt = buildAgentSystemPrompt({ ...base, toolNames: ["compute"] });
    expect(prompt).toContain("## Compute Pools");
    expect(prompt).toContain("never guess counts");
    expect(prompt).toContain("shape_only_trusted_worker");
    expect(prompt).toContain("Personal and confidential memory never leaves this machine");
    expect(prompt).toContain("only the owner funds it");
  });

  it("is absent in minimal (subagent) mode", () => {
    const prompt = buildAgentSystemPrompt({
      ...base,
      toolNames: ["compute"],
      promptMode: "minimal",
    });
    expect(prompt).not.toContain("## Compute Pools");
  });

  it("sits above the cache boundary and contains no digits", () => {
    const prompt = buildAgentSystemPrompt({
      ...base,
      toolNames: ["compute"],
      userTimezone: "UTC",
      userTime: "2026-10-17T12:00:00Z",
    });
    const start = prompt.indexOf("## Compute Pools");
    const end = prompt.indexOf("## Bitterbot CLI Quick Reference");
    const boundary = prompt.indexOf(CACHE_BOUNDARY_MARKER);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    if (boundary !== -1) {
      expect(start).toBeLessThan(boundary);
    }
    const section = prompt.slice(start, end).replace("sha256", "");
    expect(section).not.toMatch(/\d/);
  });

  it("is byte-identical across builds (stable prefix)", () => {
    const a = buildAgentSystemPrompt({ ...base, toolNames: ["compute"] });
    const b = buildAgentSystemPrompt({ ...base, toolNames: ["compute"] });
    const section = (p: string) =>
      p.slice(p.indexOf("## Compute Pools"), p.indexOf("## Bitterbot CLI Quick Reference"));
    expect(section(a)).toBe(section(b));
  });
});
