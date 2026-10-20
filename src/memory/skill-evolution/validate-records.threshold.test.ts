/**
 * Records mode: a judge's position bias (B always a hair above A) must not
 * count as evidence — pairs are discordant only above a minimum margin.
 */

import { describe, expect, it } from "vitest";
import { exactSignTest } from "./sign-test.js";
import { buildScoringPrompt, RECORDS_MIN_DISCORDANT_DELTA } from "./validate-records.js";

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

describe("records-mode presentation orders (PLAN-44 Phase 2)", () => {
  it("swaps which version is the candidate and frames both bodies as untrusted", () => {
    const base = {
      candidateName: "x",
      candidateContent: "CANDIDATE BODY",
      incumbentContent: "INCUMBENT BODY",
      traces: [],
    };
    const normal = buildScoringPrompt(base);
    const swapped = buildScoringPrompt({ ...base, swap: true });
    expect(normal).toContain("VERSION B — Candidate");
    expect(swapped).toContain("VERSION A — Candidate");
    expect(normal).toContain("UNTRUSTED SKILL TEXT");
    expect(normal.indexOf("INCUMBENT BODY")).toBeLessThan(normal.indexOf("CANDIDATE BODY"));
    expect(swapped.indexOf("CANDIDATE BODY")).toBeLessThan(swapped.indexOf("INCUMBENT BODY"));
  });
});
