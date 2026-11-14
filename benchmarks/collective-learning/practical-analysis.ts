/** Descriptive paired analysis for the disclosed small practical pilot. */
export const PRACTICAL_ARMS = ["frozen", "local", "exchange", "pooled", "context"] as const;
export type PracticalArm = (typeof PRACTICAL_ARMS)[number];
export type PracticalFinal = {
  replica: number;
  task: string;
  family: string;
  arm: PracticalArm;
  outcome: string;
  verifiedSkillRead: boolean;
};
export function analyzePractical(
  planned: Array<{ replica: number; task: string; family: string }>,
  runs: PracticalFinal[],
) {
  const key = (r: { replica: number; task: string }) => `${r.replica}:${r.task}`;
  if (new Set(planned.map(key)).size !== planned.length) throw new Error("Duplicate planned block");
  const index = new Map<string, PracticalFinal>();
  for (const run of runs) {
    if (
      !planned.some((p) => key(p) === key(run) && p.family === run.family) ||
      !PRACTICAL_ARMS.includes(run.arm)
    )
      throw new Error("Unexpected final observation");
    const id = key(run) + ":" + run.arm;
    if (index.has(id)) throw new Error("Duplicate final observation");
    index.set(id, run);
  }
  const arms = Object.fromEntries(
    PRACTICAL_ARMS.map((arm) => {
      const relevant = runs.filter((r) => r.arm === arm),
        passed = relevant.filter((r) => r.outcome === "pass").length,
        failed = relevant.filter((r) => r.outcome === "task-failure").length;
      return [
        arm,
        {
          planned: planned.length,
          recorded: relevant.length,
          passed,
          checkedFailures: failed,
          unresolved: relevant.length - passed - failed,
          missing: planned.length - relevant.length,
          verifiedSkillReads: relevant.filter((r) => r.verifiedSkillRead).length,
          checkedSuccessRate: passed + failed ? passed / (passed + failed) : null,
          plannedDenominatorSuccessRate: planned.length ? passed / planned.length : null,
        },
      ];
    }),
  );
  const contrast = (candidate: PracticalArm, baseline: PracticalArm) => {
    const pairs = planned.map((p) => {
      const a = index.get(key(p) + ":" + candidate),
        b = index.get(key(p) + ":" + baseline);
      const checked = (r: PracticalFinal | undefined) =>
        r && ["pass", "task-failure"].includes(r.outcome);
      const eligible = Boolean(checked(a) && checked(b));
      return {
        ...p,
        eligible,
        delta: eligible ? Number(a!.outcome === "pass") - Number(b!.outcome === "pass") : null,
        verifiedUse: Boolean(a?.verifiedSkillRead && b?.verifiedSkillRead),
      };
    });
    const completed = pairs.filter((p) => p.eligible),
      mean = (items: typeof completed) =>
        items.length ? items.reduce((s, p) => s + p.delta!, 0) / items.length : null;
    const families = [...new Set(planned.map((p) => p.family))];
    return {
      candidate,
      baseline,
      plannedPairs: planned.length,
      completePairs: completed.length,
      missingOrUnresolvedPairs: planned.length - completed.length,
      pairedDelta: mean(completed),
      improvements: completed.filter((p) => p.delta === 1).length,
      regressions: completed.filter((p) => p.delta === -1).length,
      unverifiedUsePairs: completed.filter((p) => !p.verifiedUse).length,
      verifiedUseDelta: mean(completed.filter((p) => p.verifiedUse)),
      familyDeltas: Object.fromEntries(
        families.map((f) => [f, mean(completed.filter((p) => p.family === f))]),
      ),
      leaveOneFamilyOut: Object.fromEntries(
        families.map((f) => [f, mean(completed.filter((p) => p.family !== f))]),
      ),
      confidenceInterval: null,
      pairs,
    };
  };
  return {
    arms,
    primary: contrast("pooled", "exchange"),
    secondary: contrast("exchange", "local"),
    localVersusFrozen: contrast("local", "frozen"),
    localVersusContext: contrast("local", "context"),
    complete:
      runs.length === planned.length * PRACTICAL_ARMS.length &&
      runs.every((r) => ["pass", "task-failure"].includes(r.outcome)),
    efficacyEstablished: false,
    interpretation:
      "Descriptive staged-candidate utility pilot. Four task families do not support the requested powered five-percentage-point efficacy claim. Missing and infrastructure outcomes remain visible; no retention or human quality score is inferred.",
  };
}
