import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { resolveMemorySearchConfig, resolveRrfK, resolveRrfWeights } from "./memory-search.js";

const cfgWith = (hybrid: Record<string, unknown>): BitterbotConfig =>
  ({
    agents: {
      defaults: {
        memorySearch: { query: { hybrid } },
      },
    },
  }) as unknown as BitterbotConfig;

describe("memorySearch.query.hybrid RRF weights and k", () => {
  it("defaults to the shipped weights and k 60 when unset", () => {
    const resolved = resolveMemorySearchConfig(cfgWith({}), "main");
    expect(resolved).not.toBeNull();
    expect(resolved!.query.hybrid.rrfK).toBe(60);
    // unweighted RRF; the 2026-10-29 measurement kept it (docs/research/fusion-weights-2026-10-29.md)
    expect(resolved!.query.hybrid.rrfWeights).toEqual({ vector: 1, keyword: 1, graph: 1 });
  });

  it("reads explicit weights and k through to the resolved config", () => {
    const resolved = resolveMemorySearchConfig(
      cfgWith({ rrfWeights: { vector: 0.25, graph: 0 }, rrfK: 30 }),
      "main",
    );
    expect(resolved!.query.hybrid.rrfWeights).toEqual({ vector: 0.25, keyword: 1, graph: 0 });
    expect(resolved!.query.hybrid.rrfK).toBe(30);
  });

  it("falls back to the default with a warning for a negative or non-finite weight", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const weights = resolveRrfWeights(
      { vector: -0.5, keyword: Number.NaN, graph: 0.5 },
      undefined,
      warn,
    );
    expect(weights.keyword).toBe(1);
    expect(weights.graph).toBe(0.5);
    expect(weights.vector).toBe(resolveRrfWeights(undefined, undefined, warn).vector);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("rrfWeights.vector=-0.5");
    expect(warnings[1]).toContain("rrfWeights.keyword=NaN");
  });

  it("falls back to k 60 with a warning for a non-positive, non-finite or non-numeric k", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveRrfK(0, warn)).toBe(60);
    expect(resolveRrfK(-10, warn)).toBe(60);
    expect(resolveRrfK(Number.POSITIVE_INFINITY, warn)).toBe(60);
    expect(resolveRrfK("60", warn)).toBe(60);
    expect(warnings).toHaveLength(4);
    expect(resolveRrfK(undefined, warn)).toBe(60);
    expect(resolveRrfK(15, warn)).toBe(15);
    expect(warnings).toHaveLength(4);
  });

  it("lets an agent override one channel while the defaults set another", () => {
    const weights = resolveRrfWeights({ vector: 0.1 }, { vector: 0.5, graph: 0.2 }, () => {});
    expect(weights).toEqual({ vector: 0.1, keyword: 1, graph: 0.2 });
  });
});
