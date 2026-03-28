/**
 * Tests for endocrine state resolution.
 *
 * resolveEndocrineState() dynamically imports the MemoryIndexManager singleton,
 * so we test the edge case paths and type shape without a full manager.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { EndocrineStateForPrompt } from "./endocrine-state.js";

describe("Endocrine State Resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no manager is available", async () => {
    // Mock the dynamic import to return a manager that resolves to null
    vi.mock("../memory/manager.js", () => ({
      MemoryIndexManager: {
        get: async () => null,
      },
    }));

    const { resolveEndocrineState } = await import("./endocrine-state.js");
    const state = await resolveEndocrineState({
      agentId: "test",
      workspaceDir: "/nonexistent",
    });
    expect(state).toBeUndefined();
  });

  it("EndocrineStateForPrompt type has expected shape", () => {
    // Type-level test: verify the shape of the output type
    const mockState: EndocrineStateForPrompt = {
      dopamine: 0.3,
      cortisol: 0.15,
      oxytocin: 0.4,
      briefing: "Balanced state, no special modulation needed.",
      phenotypeSummary: "A curious, technically-minded agent.",
      maturity: 0.5,
    };

    expect(mockState.dopamine).toBeTypeOf("number");
    expect(mockState.cortisol).toBeTypeOf("number");
    expect(mockState.oxytocin).toBeTypeOf("number");
    expect(mockState.briefing).toBeTypeOf("string");
    expect(mockState.briefing.length).toBeLessThan(800);
  });
});
