import { ACTOR, PROPOSER, ADAPTER_REVISION } from "./episode.mjs";
import { EXPLICIT_CHECKLIST } from "./prerequisite-ledger.mjs";
export { checkFreeze, freezeSources, consumedCases, AUTHORIZATION } from "./procedure-protocol.mjs";
export { ACTOR, PROPOSER, ADAPTER_REVISION };
export const SOURCE = {
  indices: [0, 2, 36, 37, 39, 44],
  arms: ["baseline", "explicit", "ledger"],
  repetitions: 3,
  concurrency: 3,
  laneCeilingUsd: 30,
  partition: "development",
};
export const FRESH = {
  indices: [5, 6, 9, 10, 13, 48],
  repetitions: 3,
  concurrency: 3,
  laneCeilingUsd: 25,
  partition: "held-out",
};
export const ACTORS = {
  baseline: ACTOR,
  explicit: ACTOR + "\n\n" + EXPLICIT_CHECKLIST,
  ledger: ACTOR + "\n\n" + EXPLICIT_CHECKLIST,
};
export const DECISION =
  "All assigned episodes must terminate naturally with zero interface failures. Source eligibility: at least 17/18 repairs, at least two more than baseline, and no case-level baseline regression. Prefer the eligible arm with more successes; at equal success prefer the explicit checklist unless ledger uses at least 10% fewer model calls and no more uncached-equivalent cost. Freeze that source choice before fresh evaluation. Fresh requires at least two additional successes over baseline, no case-level regression and all natural completions. Gates are exploratory, not production promotion or autonomous learning evidence. No retries, tuning or reselection within stages. Only a baseline-versus-selected-arm fresh comparison may advance; no recipient transfer in this host-authored mechanism study.";
export function prerequisiteGate(protocol, rows) {
  const { indices, arms, repetitions, stage } = protocol;
  const expected = arms.flatMap((a) =>
    indices.flatMap((i) => Array.from({ length: repetitions }, (_, r) => `${a}:${r}:${i}`)),
  );
  const actual = rows.map((r) => `${r.arm}:${r.repetition}:${r.index}`);
  const complete =
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((e) => actual.includes(e));
  const natural =
    complete &&
    rows.every(
      (r) => ["user-ended", "human-transfer"].includes(r.termination) && r.interfaceFailures === 0,
    );
  const stats = (a) => ({
    successes: rows.filter((r) => r.arm === a && r.passed).length,
    calls: rows.filter((r) => r.arm === a).reduce((s, r) => s + r.modelCalls, 0),
    uncached: rows.filter((r) => r.arm === a).reduce((s, r) => s + r.uncachedEquivalentUsd, 0),
  });
  const base = stats("baseline");
  const candidates = arms
    .filter((a) => a !== "baseline")
    .map((arm) => {
      const m = stats(arm),
        regressions = indices.filter(
          (i) =>
            rows.filter((r) => r.arm === arm && r.index === i && r.passed).length <
            rows.filter((r) => r.arm === "baseline" && r.index === i && r.passed).length,
        );
      return {
        arm,
        ...m,
        regressions,
        eligible:
          natural &&
          m.successes >= base.successes + 2 &&
          !regressions.length &&
          (stage !== "source" || m.successes >= 17),
      };
    });
  const eligible = candidates.filter((c) => c.eligible);
  let selected = null;
  if (eligible.length === 1) selected = eligible[0].arm;
  else if (eligible.length === 2) {
    const explicit = eligible.find((c) => c.arm === "explicit"),
      ledger = eligible.find((c) => c.arm === "ledger");
    selected =
      ledger.successes > explicit.successes ||
      (ledger.successes === explicit.successes &&
        ledger.calls <= explicit.calls * 0.9 &&
        ledger.uncached <= explicit.uncached)
        ? "ledger"
        : "explicit";
  }
  return {
    passed: !!selected,
    selected,
    complete,
    natural,
    baseline: base,
    candidates,
    criterion: DECISION,
  };
}
