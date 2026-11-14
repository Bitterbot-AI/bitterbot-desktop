import { expect, it } from "vitest";
import { analyzePractical, PRACTICAL_ARMS, type PracticalFinal } from "./practical-analysis.js";
const planned = [
  { replica: 0, task: "a-1", family: "a" },
  { replica: 1, task: "b-1", family: "b" },
];
const success = (): PracticalFinal[] =>
  planned.flatMap((p) =>
    PRACTICAL_ARMS.map((arm) => ({ ...p, arm, outcome: "pass", verifiedSkillRead: true })),
  );
it("does not turn repeated successes into a learning effect or an efficacy claim", () => {
  const result = analyzePractical(planned, success());
  expect(result.complete).toBe(true);
  expect(result.primary.pairedDelta).toBe(0);
  expect(result.efficacyEstablished).toBe(false);
  expect(result.primary.confidenceInterval).toBeNull();
});
it("keeps unresolved and missing observations out of success claims and visible in denominators", () => {
  const runs = success().filter((r) => !(r.task === "b-1" && r.arm === "pooled"));
  runs.find((r) => r.task === "a-1" && r.arm === "exchange")!.outcome = "infrastructure";
  const result = analyzePractical(planned, runs);
  expect(result.complete).toBe(false);
  expect(result.primary.completePairs).toBe(0);
  expect(result.primary.missingOrUnresolvedPairs).toBe(2);
  expect(result.arms.pooled.missing).toBe(1);
  expect(result.arms.exchange.unresolved).toBe(1);
  expect(result.primary.pairedDelta).toBeNull();
});
it("reports improvements and regressions paired by task, with a separate verified-use result", () => {
  const runs = success();
  runs.find((r) => r.task === "a-1" && r.arm === "exchange")!.outcome = "task-failure";
  runs.find((r) => r.task === "b-1" && r.arm === "pooled")!.outcome = "task-failure";
  runs.find((r) => r.task === "a-1" && r.arm === "pooled")!.verifiedSkillRead = false;
  const result = analyzePractical(planned, runs).primary;
  expect(result.pairedDelta).toBe(0);
  expect(result.improvements).toBe(1);
  expect(result.regressions).toBe(1);
  expect(result.verifiedUseDelta).toBe(-1);
  expect(result.leaveOneFamilyOut).toEqual({ a: -1, b: 1 });
});
it("rejects duplicates and unplanned observations", () => {
  expect(() => analyzePractical(planned, [...success(), success()[0]])).toThrow("Duplicate");
  expect(() => analyzePractical(planned, [{ ...success()[0], family: "unseen" }])).toThrow(
    "Unexpected",
  );
});
