import { expect, it } from "vitest";
import { researchBriefUtcDate } from "./research-brief-contract.js";

it.each([
  ["2026-02-04", "2026-02-04"],
  ["2024-02-29", "2024-02-29"],
  ["2026-02-04T09:00:00Z", "2026-02-04"],
  ["2026-02-04T23:30:00-05:00", "2026-02-05"],
  ["2026-03-01T00:30:00+02:00", "2026-02-28"],
])("normalizes publication date %s to the declared UTC date %s", (source, expected) => {
  expect(researchBriefUtcDate(source)).toBe(expected);
});

it.each(["2026-02-04T23:30:00", "2026-02-30", "2026-02-30T09:00:00Z", "02/04/2026"])(
  "refuses ambiguous or invalid publication date %s",
  (source) => expect(() => researchBriefUtcDate(source)).toThrow(),
);
