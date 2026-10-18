/**
 * PLAN-57 Phase 1: the `<compute-state>` block in the volatile tail.
 *
 * Contract: when supplied it renders below the cache boundary (never in the
 * cached prefix), never in minimal mode, and its absence costs nothing.
 */
import { describe, expect, it } from "vitest";
import { CACHE_BOUNDARY_MARKER, buildAgentSystemPrompt } from "./system-prompt.js";

const BLOCK = [
  "<compute-state v=7 as_of=3s_ago>",
  "jobs: 1 running (sha256 x12 on w1)",
  "</compute-state>",
].join("\n");
const base = { workspaceDir: "/tmp/bitterbot", toolNames: ["compute"] };

describe("compute state block placement", () => {
  it("renders below the cache boundary in full mode", () => {
    const prompt = buildAgentSystemPrompt({ ...base, computeState: BLOCK });
    const boundary = prompt.indexOf(CACHE_BOUNDARY_MARKER);
    const block = prompt.indexOf("<compute-state");
    expect(boundary).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(boundary);
    // The static section stays above the boundary, untouched by the block.
    expect(prompt.indexOf("## Compute Pools")).toBeLessThan(boundary);
  });

  it("is absent in minimal mode even when supplied", () => {
    const prompt = buildAgentSystemPrompt({ ...base, computeState: BLOCK, promptMode: "minimal" });
    expect(prompt).not.toContain("<compute-state");
  });

  it("changes nothing above the boundary between a turn with and without the block", () => {
    const withBlock = buildAgentSystemPrompt({ ...base, computeState: BLOCK });
    const without = buildAgentSystemPrompt({ ...base });
    const stable = (p: string) => p.slice(0, p.indexOf(CACHE_BOUNDARY_MARKER));
    expect(stable(withBlock)).toBe(stable(without));
    expect(without).not.toContain("<compute-state");
  });
});
