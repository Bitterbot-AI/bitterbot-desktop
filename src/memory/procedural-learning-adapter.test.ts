import { expect, it, vi } from "vitest";
import { createToolProcedureAdapter } from "./procedural-learning-adapter.js";
import { learningHash } from "./procedural-learning-contract.js";
it("runs bounded registered bindings through host authorization and rejects arbitrary tools", async () => {
  const call = vi.fn(async (input: unknown) => ({
    output: input,
    cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
  }));
  const adapter = createToolProcedureAdapter({
    id: "authorized-read",
    scope: { tool: "read", version: "1", operation: "read", contractHash: learningHash("read") },
    isolation: "read-only",
    qualificationCases: ["a", "b"],
    tools: new Map([["read", { call, quote: { providerUsd: 0, toolCalls: 1, wallMs: 100 } }]]),
    bindings: new Map([["input", (input) => input]]),
    describeExperience: () => ({
      cue: "authorized read",
      context: { source: "fixture" },
      action: "read",
      check: "compare source",
      detail: "redacted receipt",
    }),
    verifier: {
      revision: "1",
      quote: { providerUsd: 0, toolCalls: 1, wallMs: 100 },
      verify: async (input, output) => ({
        passed: input === output,
        cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
      }),
    },
  });
  const program = JSON.stringify({ steps: [{ tool: "read", binding: "input" }] });
  expect(adapter.quote(program, "a").toolCalls).toBe(2);
  expect((await adapter.execute(program, "a", new AbortController().signal)).output).toBe("a");
  expect(() =>
    adapter.quote(JSON.stringify({ steps: [{ tool: "exec", binding: "input" }] }), "a"),
  ).toThrow("Unregistered");
  const abort = new AbortController();
  abort.abort();
  await expect(adapter.execute(program, "a", abort.signal)).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
  expect(adapter.describeExperience?.("a", "a")?.detail).toBe("redacted receipt");
});
