/**
 * PLAN-52A: transcript readers are denied to subagents at every depth. A
 * subagent must not read the parent's (or any other session's) raw history,
 * tool outputs included.
 */
import { describe, expect, it } from "vitest";
import { isToolAllowedByPolicyName, resolveSubagentToolPolicy } from "./pi-tools.policy.js";

describe("subagent policy denies transcript readers", () => {
  it("at leaf depth and at orchestrator depth", () => {
    for (const depth of [0, 1, 2]) {
      const policy = resolveSubagentToolPolicy(
        { agents: { defaults: { subagents: { maxSpawnDepth: 2 } } } } as never,
        depth,
      );
      for (const name of ["deep_recall", "recall_range", "expand_message"]) {
        expect(isToolAllowedByPolicyName(name, policy), `${name} at depth ${depth}`).toBe(false);
      }
      // Sanity: an ordinary tool is still allowed.
      expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    }
  });
});
