import { describe, expect, it } from "vitest";
import { probeSqliteVec } from "./sqlite-vec.js";

describe("probeSqliteVec", () => {
  it("loads the bundled extension and confirms vec0 is usable", async () => {
    // Doubles as a packaging regression check: if sqlite-vec or its platform
    // binary is missing/unloadable on this platform, this fails loudly instead
    // of degrading silently to keyword search.
    const result = await probeSqliteVec();
    expect(result.ok).toBe(true);
    expect(result.extensionPath).toBeTruthy();
  });

  it("reports a reason instead of throwing when the extension path is bogus", async () => {
    const result = await probeSqliteVec("/nonexistent/path/to/vec0.so");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
