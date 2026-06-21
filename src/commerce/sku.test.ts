import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brandedSku, canonicalizeSku } from "./sku.js";

// Load the committed protocol conformance vectors so the implementation stays
// pinned to the published spec (docs/protocol/aubaine-v1). If the canonicalizer
// and the spec ever diverge, this test fails.
const vectorsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/protocol/aubaine-v1/test-vectors/sku-canonicalization.json",
);
const skuVectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  cases: Array<{ structured_spec: unknown; sku_canonical: string }>;
};

describe("aubaine SKU canonicalization", () => {
  it("reproduces every published conformance vector byte-for-byte", () => {
    for (const testCase of skuVectors.cases) {
      expect(canonicalizeSku(testCase.structured_spec as never)).toBe(testCase.sku_canonical);
    }
  });

  it("matches the documented reference hash for the keycap spec", () => {
    expect(skuVectors.cases[0]?.sku_canonical).toBe(
      "sha256:2e763a4d2bf3dff41ae70ad0f1b7751eaddc85bfef2a1acd05cc5ae20f261849",
    );
  });

  it("is invariant to key order, casing, and whitespace (spec-lock property)", () => {
    const a = canonicalizeSku({
      category: "Keycap-Set",
      material: "  PBT  ",
      colorway: "Nautilus",
      version: 1,
    });
    const b = canonicalizeSku({
      version: 1,
      colorway: "NAUTILUS",
      material: "pbt",
      category: "keycap-set",
    });
    expect(a).toBe(b);
  });

  it("drops null and empty fields (omitted == empty)", () => {
    expect(canonicalizeSku({ a: "x", b: "", c: null })).toBe(canonicalizeSku({ a: "x" }));
  });

  it("produces a different pool when the spec actually changes (no silent drift)", () => {
    const v1 = canonicalizeSku({ colorway: "nautilus", version: 1 });
    const v2 = canonicalizeSku({ colorway: "nautilus", version: 2 });
    expect(v1).not.toBe(v2);
  });

  it("brandedSku is lowercased and pipe-joined, dropping empties", () => {
    expect(brandedSku("GMK", "Olivia", "")).toBe("brand:gmk|olivia");
    expect(brandedSku(" Keychron ", "Q1", "Black")).toBe("brand:keychron|q1|black");
  });
});
