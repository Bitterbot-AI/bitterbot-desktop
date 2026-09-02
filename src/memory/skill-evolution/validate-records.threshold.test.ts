/**
 * Records mode: a judge's position bias (B always a hair above A) must not
 * count as evidence — pairs are discordant only above a minimum margin.
 */

import { describe, expect, it } from "vitest";
import { exactSignTest } from "./sign-test.js";
import { RECORDS_MIN_DISCORDANT_DELTA } from "./validate-records.js";

describe("records-mode discordance floor", () => {
  it("hairline deltas are ties; real margins count", () => {
    const hairline = Array.from({ length: 12 }, () => 0.01);
    const floored = hairline.map((d) => (Math.abs(d) >= RECORDS_MIN_DISCORDANT_DELTA ? d : 0));
    expect(exactSignTest(floored).pValue).toBe(1);

    const real = Array.from({ length: 6 }, () => 0.3);
    const flooredReal = real.map((d) => (Math.abs(d) >= RECORDS_MIN_DISCORDANT_DELTA ? d : 0));
    expect(exactSignTest(flooredReal).pValue).toBeLessThan(0.05);
  });
});
