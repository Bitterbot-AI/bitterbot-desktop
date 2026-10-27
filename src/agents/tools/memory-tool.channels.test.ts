/**
 * PLAN-58: what the memory_search tool shows the model about retrieval
 * channels is a config decision, and "off" must be byte-identical to the
 * pre-PLAN-58 result shape.
 */
import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import { resolveChannelDiagnostics } from "../memory-search.js";
import { projectChannelDiagnostics } from "./memory-tool.js";

const result: MemorySearchResult = {
  path: "memory/a.md",
  startLine: 1,
  endLine: 3,
  score: 2 / 61,
  snippet: "hello",
  source: "memory",
  fusion: "rrf",
  channels: { vector: { rank: 2, score: 0.83 }, keyword: { rank: 5, score: 0.4 } },
};

describe("projectChannelDiagnostics", () => {
  it("ranks mode keeps fusion and compact v/k/g ranks only", () => {
    const [out] = projectChannelDiagnostics([result], "ranks");
    expect(out?.fusion).toBe("rrf");
    expect(out?.channels).toEqual({ v: 2, k: 5 });
    expect(out?.score).toBe(result.score);
    expect(JSON.stringify(out)).not.toContain("0.83");
  });

  it("ranks mode includes g when the graph channel contributed", () => {
    const [out] = projectChannelDiagnostics(
      [{ ...result, channels: { graph: { rank: 1, score: 0.7 } } }],
      "ranks",
    );
    expect(out?.channels).toEqual({ g: 1 });
  });

  it("full mode returns the manager's block untouched", () => {
    const [out] = projectChannelDiagnostics([result], "full");
    expect(out).toBe(result);
  });

  it("off mode strips channels and fusion so the shape matches pre-PLAN-58 output", () => {
    const [out] = projectChannelDiagnostics([result], "off");
    expect(out).toEqual({
      path: "memory/a.md",
      startLine: 1,
      endLine: 3,
      score: 2 / 61,
      snippet: "hello",
      source: "memory",
    });
    expect("channels" in (out as object)).toBe(false);
    expect("fusion" in (out as object)).toBe(false);
  });

  it("leaves results without channels alone in every mode", () => {
    const bare: MemorySearchResult = { ...result, channels: undefined, fusion: undefined };
    for (const mode of ["ranks", "off", "full"] as const) {
      const [out] = projectChannelDiagnostics([bare], mode);
      expect(out?.channels).toBeUndefined();
    }
  });
});

describe("resolveChannelDiagnostics", () => {
  it("defaults to ranks and accepts only the three known values", () => {
    expect(resolveChannelDiagnostics(undefined)).toBe("ranks");
    expect(resolveChannelDiagnostics("full")).toBe("full");
    expect(resolveChannelDiagnostics("off")).toBe("off");
    expect(resolveChannelDiagnostics("ranks")).toBe("ranks");
    expect(resolveChannelDiagnostics("verbose")).toBe("ranks");
    expect(resolveChannelDiagnostics(42)).toBe("ranks");
  });
});
