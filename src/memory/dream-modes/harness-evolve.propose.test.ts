import { describe, expect, it } from "vitest";
import type { FailureCluster } from "./harness-evolve.weakness.js";
import { defaultHarnessPolicy } from "../../agents/pi-embedded-runner/harness-policy.js";
import { proposeHarnessCandidates } from "./harness-evolve.propose.js";

const cluster: FailureCluster = {
  signature: {
    surface: "tools",
    terminalCause: "downstream-failure",
    mechanism: "modify:memory_search",
  },
  count: 4,
  lastTs: 1,
  sampleIds: ["i0"],
  exampleDetail: "tool=memory_search",
  score: 4,
};

describe("proposeHarnessCandidates (PLAN-25)", () => {
  it("parses LLM output into candidates that differ from live", async () => {
    const llmCall = async () =>
      JSON.stringify([
        {
          policy: {
            ...defaultHarnessPolicy(),
            tools: {
              descriptionOverrides: { memory_search: "Use for vector recall of past facts." },
            },
          },
          targetedMechanism: "modify:memory_search",
          rationale: "clarify when to use memory_search",
        },
      ]);
    const out = await proposeHarnessCandidates({
      live: defaultHarnessPolicy(),
      clusters: [cluster],
      llmCall,
    });
    expect(out.length).toBe(1);
    expect(out[0].candidate.tools.descriptionOverrides.memory_search).toContain("vector recall");
    expect(out[0].audit.surfacesTouched).toContain("tools");
  });

  it("handles fenced JSON and drops no-op candidates", async () => {
    const llmCall = async () =>
      "```json\n" +
      JSON.stringify([
        { policy: defaultHarnessPolicy(), targetedMechanism: "x", rationale: "no change" },
        {
          policy: {
            ...defaultHarnessPolicy(),
            prompt: { fragments: [{ id: "f", text: "do X", order: 0 }] },
          },
          targetedMechanism: "y",
          rationale: "add fragment",
        },
      ]) +
      "\n```";
    const out = await proposeHarnessCandidates({
      live: defaultHarnessPolicy(),
      clusters: [cluster],
      llmCall,
    });
    expect(out.length).toBe(1); // the no-op is dropped
    expect(out[0].candidate.prompt.fragments[0]?.text).toBe("do X");
  });

  it("returns [] on unparseable output or no clusters", async () => {
    expect(
      await proposeHarnessCandidates({
        live: defaultHarnessPolicy(),
        clusters: [cluster],
        llmCall: async () => "garbage",
      }),
    ).toEqual([]);
    expect(
      await proposeHarnessCandidates({
        live: defaultHarnessPolicy(),
        clusters: [],
        llmCall: async () => "[]",
      }),
    ).toEqual([]);
  });
});
