import assert from "node:assert/strict";
import { ACTOR } from "./episode.mjs";
import { ENGINEER } from "./rediscovery2-engineer.mjs";
export { ACTOR, ENGINEER };
export const TRAINING = [0, 2, 36, 37, 39, 44];
export const CONFIRMATION = [1, 14, 21, 28, 31, 45];
export const FRESH = [5, 6, 9, 10, 13, 48];
export const RECIPIENT = [11, 12, 15, 49];
export const BRANCHES = ["experience-0", "blind-0", "blind-1", "experience-1"];
export const ROUNDS = 3;
export const NATURAL = ["user-ended", "human-transfer"];
export const DECISION =
  "Two independent experience/blind pairs, three rounds and six evaluations per round. Both receive the same policy, tools, delivery-specific program contracts, model and maximum two program attempts per round. Only the experience branch receives complete selected actor-visible traces, grades and up to three native probes. Both receive their own compiler errors and previous submission. One immediate compiler-only revision is allowed after rejection, never manual repair. Parent is previous evaluated actor (baseline fallback if both attempts fail). Valid candidates are selected by repairs, then fewer calls, then earlier round; nominee fixed before confirmation. All 60 engineer-unseen confirmation trials must finish naturally; nominee >=11/12 and >=2 above baseline with no case regression; aggregate experience exceeds blind. Only then run 54 fresh trials: nominee >=2 above baseline and paired blind, no case regression, all natural. Exact purchase preference is an explicit benchmark variant, not official parity. No live promotion, peer publication or task-feedback repair during confirmation/fresh.";
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
