import assert from "node:assert/strict";
import { ACTOR } from "./episode.mjs";
import { ENGINEER } from "./rediscovery-engineer.mjs";
export { ACTOR, ENGINEER };
export const TRAINING = [0, 2, 36, 37, 39, 44];
export const CONFIRMATION = [1, 14, 21, 28, 31, 45];
export const FRESH = [5, 6, 9, 10, 13, 48];
export const RECIPIENT = [11, 12, 15, 49];
export const BRANCHES = ["experience-0", "blind-0", "blind-1", "experience-1"];
export const ROUNDS = 3;
export const NATURAL = ["user-ended", "human-transfer"];
export const DECISION =
  "Two independent discovery pairs, three rounds per branch, exactly two engineer calls and six evaluation episodes per round. Experience gets parent public traces, outcomes and up to three native diagnostic experiments; blind receives no execution history, grades, diagnostics or host selection feedback. Both get identical policy/tools, program vocabulary, model and maximum generation/evaluation allowance. Actual token/cost/native-probe use is reported, not claimed equal. Invalid programs are archived as invalid attempts, evaluated with baseline fallback to preserve assignment counts and excluded from selection; no manual edits or extra retries. Parent is previous round (or baseline fallback), not host-selected winner. After all rounds, choose each branch's valid candidate by successes, then fewer model calls, then earlier round. Nominate an experience branch by that same rule, breaking ties by branch order, before confirmation. All 60 confirmation trials on engineer-unseen but previously consumed cases are retained. Advance only if every confirmation trial completes naturally, nominated experience repairs >=11/12 and >=2 more than baseline with no case regression, and combined experience repairs strictly exceed the two blind controls. This gate is exploratory, not production promotion or statistical proof. Fresh comparison uses baseline, the nominated experience candidate and its paired blind candidate, three repeats over six globally untouched cases; require all natural, >=2 extra experience repairs over both controls, and no case-level baseline regression. No fresh tuning or reselection; no recipient collection or live activation in this experiment.";
export function selectCandidate(rows) {
  return (
    rows
      .filter((r) => r.valid)
      .toSorted(
        (a, b) => b.successes - a.successes || a.modelCalls - b.modelCalls || a.round - b.round,
      )[0] ?? null
  );
}
export function comparisonSchedule(arms, indices, repetitions) {
  return Array.from({ length: repetitions }, (_, repetition) =>
    arms.map((_, offset) => ({
      arm: arms[(offset + repetition) % arms.length],
      repetition,
      indices: repetition % 2 ? [...indices].reverse() : [...indices],
    })),
  ).flat();
}
export function advancementGate(protocol, rows) {
  const expected = protocol.arms.length * protocol.indices.length * protocol.repetitions;
  const keys = new Set(rows.map((r) => `${r.arm}:${r.repetition}:${r.index}`));
  const complete =
    rows.length === expected &&
    keys.size === expected &&
    protocol.schedule.every((b) =>
      b.indices.every((i) => keys.has(`${b.arm}:${b.repetition}:${i}`)),
    );
  const natural = complete && rows.every((r) => NATURAL.includes(r.termination));
  const score = (arm) => rows.filter((r) => r.arm === arm && r.passed).length;
  const selected = protocol.nominated;
  const regressions = protocol.indices.filter(
    (i) =>
      rows.filter((r) => r.arm === selected && r.index === i && r.passed).length <
      rows.filter((r) => r.arm === "baseline" && r.index === i && r.passed).length,
  );
  const experience = protocol.arms
    .filter((a) => a.startsWith("experience"))
    .reduce((s, a) => s + score(a), 0);
  const blind = protocol.arms
    .filter((a) => a.startsWith("blind"))
    .reduce((s, a) => s + score(a), 0);
  const performance =
    protocol.stage === "confirmation"
      ? score(selected) >= 11 && score(selected) >= score("baseline") + 2 && experience > blind
      : score(selected) >= score("baseline") + 2 &&
        score(selected) >= score(protocol.pairedBlind) + 2;
  return {
    passed: natural && performance && !regressions.length,
    complete,
    natural,
    nominated: selected,
    selectedRepairs: score(selected),
    baselineRepairs: score("baseline"),
    experienceRepairs: experience,
    blindRepairs: blind,
    regressions,
    criterion: DECISION,
  };
}
export function checkPartitions() {
  const all = [...TRAINING, ...CONFIRMATION, ...FRESH, ...RECIPIENT];
  assert.equal(new Set(all).size, all.length);
}
