import { expect, it } from "vitest";
import { checkResearchBriefDeliverables } from "./research-brief.js";

it("requires both a correct factual brief and the requested human-readable deliverable", () => {
  const input = {
    question: "Compare outcomes",
    followUpOwner: "Sam",
    sources: [
      {
        id: "s1",
        metric: "returns",
        value: 3,
        publishedAt: "2026-02-04T23:30:00-05:00",
        status: "current",
      },
    ],
  };
  const output = {
    question: input.question,
    findings: [{ metric: "returns", value: 3, sourceId: "s1", date: "2026-02-05" }],
    uncertainties: [],
    recommendation: "Continue measuring",
    followUp: { owner: "Sam", action: "Collect a second sample" },
  };
  expect(checkResearchBriefDeliverables(input, output, "# Brief\nThree returns [s1].")).toBe(true);
  expect(checkResearchBriefDeliverables(input, output, null)).toBe(false);
  expect(checkResearchBriefDeliverables(input, output, " \n")).toBe(false);
  expect(
    checkResearchBriefDeliverables(
      input,
      { ...output, findings: [{ ...output.findings[0], date: "2026-02-04" }] },
      "# Brief",
    ),
  ).toBe(false);
});
