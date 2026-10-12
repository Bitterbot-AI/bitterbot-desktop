import { describe, expect, it } from "vitest";
import { bundleIsStale } from "./StaleBundleBanner";

describe("bundleIsStale", () => {
  it("flags a page older or newer than the gateway", () => {
    expect(bundleIsStale("1.2.0", "1.4.0")).toBe(true);
    expect(bundleIsStale("1.4.1", "1.4.0")).toBe(true);
  });

  it("stays quiet when versions match or either side is not a release", () => {
    expect(bundleIsStale("1.4.0", "1.4.0")).toBe(false);
    expect(bundleIsStale("dev", "1.4.0")).toBe(false);
    expect(bundleIsStale("1.4.0", "dev")).toBe(false);
    expect(bundleIsStale("1.4.0", "unknown")).toBe(false);
    expect(bundleIsStale("1.4.0", undefined)).toBe(false);
  });
});
