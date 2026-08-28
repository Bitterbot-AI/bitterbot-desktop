import { describe, expect, it } from "vitest";
import { compareBitterbotVersions, parseBitterbotVersion } from "./version.js";

describe("compareBitterbotVersions (PLAN-41 D-A CalVer guard)", () => {
  it("orders plain SemVer normally", () => {
    expect(compareBitterbotVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareBitterbotVersions("1.2.0", "1.0.9")).toBe(1);
    expect(compareBitterbotVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("orders CalVer among itself normally", () => {
    expect(compareBitterbotVersions("2026.2.15", "2026.2.16")).toBe(-1);
    expect(compareBitterbotVersions("2026.3.1", "2026.2.28")).toBe(1);
  });

  it("a CalVer-era version is OLDER than any SemVer release", () => {
    expect(compareBitterbotVersions("2026.2.15", "1.0.0")).toBe(-1);
    expect(compareBitterbotVersions("1.0.0", "2026.2.15")).toBe(1);
    expect(compareBitterbotVersions("2025.12.31", "0.9.0")).toBe(-1);
  });

  it("returns null on unparseable input", () => {
    expect(compareBitterbotVersions("nonsense", "1.0.0")).toBeNull();
    expect(compareBitterbotVersions(null, "1.0.0")).toBeNull();
  });

  it("parseBitterbotVersion handles v-prefix and revision", () => {
    expect(parseBitterbotVersion("v1.2.3-4")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      revision: 4,
    });
  });
});
