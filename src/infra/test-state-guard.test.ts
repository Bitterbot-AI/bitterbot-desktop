import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotRealStateUnderTest } from "./test-state-guard.js";

const realHome = path.resolve("/home/someone");
const liveDb = path.join(realHome, ".bitterbot", "memory", "main.sqlite");
const underTest = { VITEST: "true" } as NodeJS.ProcessEnv;

describe("assertNotRealStateUnderTest", () => {
  it("refuses a path inside the real state dir while under vitest", () => {
    expect(() => assertNotRealStateUnderTest(liveDb, { env: underTest, realHome })).toThrow(
      /real state directory/,
    );
    expect(() =>
      assertNotRealStateUnderTest(path.join(realHome, ".bitterbot"), { env: underTest, realHome }),
    ).toThrow(/real state directory/);
  });

  it("refuses the reindex temp and backup siblings of the live database too", () => {
    expect(() =>
      assertNotRealStateUnderTest(`${liveDb}.tmp-1234`, { env: underTest, realHome }),
    ).toThrow(/real state directory/);
  });

  it("allows isolated paths, including a temp home that mirrors the layout", () => {
    const isolated = path.join(
      path.resolve("/tmp/bitterbot-test-home-abc"),
      ".bitterbot",
      "memory",
      "main.sqlite",
    );
    expect(() => assertNotRealStateUnderTest(isolated, { env: underTest, realHome })).not.toThrow();
    // A sibling whose name merely starts with the state dir name is not inside it.
    expect(() =>
      assertNotRealStateUnderTest(path.join(realHome, ".bitterbot-other", "x.sqlite"), {
        env: underTest,
        realHome,
      }),
    ).not.toThrow();
  });

  it("does nothing outside a test run", () => {
    expect(() => assertNotRealStateUnderTest(liveDb, { env: {}, realHome })).not.toThrow();
  });

  it("exempts live suites, which use real state on purpose", () => {
    for (const flag of ["LIVE", "BITTERBOT_LIVE_TEST", "BITTERBOT_LIVE_GATEWAY"]) {
      const env = { VITEST: "true", [flag]: "1" } as NodeJS.ProcessEnv;
      expect(() => assertNotRealStateUnderTest(liveDb, { env, realHome })).not.toThrow();
    }
  });

  it("does nothing when the real home cannot be determined", () => {
    expect(() =>
      assertNotRealStateUnderTest(liveDb, { env: underTest, realHome: null }),
    ).not.toThrow();
  });
});
