export const EVIDENCE_PROFILES = {
  compliance: {
    indices: [46, 47],
    arms: ["conditional"],
    repetitions: 3,
    concurrency: 3,
    laneCeilingUsd: 6,
    stage: "interface-qualification",
    caseSelection:
      "Focused fresh v8 reporting-coverage panel: two unused complex MMS cases (46,47), three unseeded draws each. Both require the MMS checks supported by the existing publication contract. The preceding v8 mixed-domain panel solved 6/6 but failed the frozen reporting-coverage gate because three episodes never used a supported diagnostic; that failed gate remains unchanged. No adapter or rule change for this follow-up. The nine-case comparison panel remains unchanged from the v7 preregistration.",
  },
  comparison: {
    indices: [4, 7, 20, 34, 36, 37, 39, 40, 44],
    arms: ["baseline", "static", "conditional"],
    repetitions: 3,
    concurrency: 3,
    laneCeilingUsd: 25,
    stage: "controlled-reminder-comparison",
    caseSelection:
      "Prospectively fixed metadata panel: mobile data (4,7), service (20), and MMS (34,36,37,39,40,44). Covers network, VPN, APN, permissions, allowance, roaming, SIM and suspension across varied personas. Three unseeded draws per case/arm. Deliberate mechanism coverage, not a random sample of users or tasks.",
  },
};

export function evidenceSchedule(profile) {
  const result = [];
  for (let repetition = 0; repetition < profile.repetitions; repetition++) {
    for (let position = 0; position < profile.arms.length; position++) {
      const arm = profile.arms[(position + repetition) % profile.arms.length];
      const offset = (repetition + position) % profile.indices.length;
      const ordered = [...profile.indices.slice(offset), ...profile.indices.slice(0, offset)];
      result.push({
        arm,
        repetition,
        store: `${arm}-${repetition}`,
        indices: repetition % 2 ? ordered.reverse() : ordered,
      });
    }
  }
  return result;
}

export function interfaceGate(rows, expected) {
  const complete = rows.length === expected;
  const invalid = rows.filter((r) =>
    ["simulator-observation-failure", "simulator-grounding-failure"].includes(r.termination),
  );
  const censored = rows.filter((r) => !["user-ended", "human-transfer"].includes(r.termination));
  const withoutRecords = rows.filter((r) => !r.nonemptyReports);
  const refreshedCases = [...new Set(rows.filter((r) => r.refreshedFacts > 0).map((r) => r.index))];
  return {
    passed: complete && !censored.length && !withoutRecords.length && refreshedCases.length >= 2,
    complete,
    invalid: invalid.map((r) => r.label),
    censored: censored.map((r) => r.label),
    withoutRecords: withoutRecords.map((r) => r.label),
    refreshedCases,
    reminderDeliveries: rows.reduce((sum, r) => sum + r.reminders, 0),
    note: "Require all assigned natural completions, explicit nonempty reporting in every episode and fresh evidence in at least two distinct cases. Native success and reminder activation are separate descriptive outcomes; zero activation does not prove benefit.",
  };
}

/** Resample whole cases, retaining all repetitions, rather than treating draws as independent tasks. */
export function clusterInterval(valuesByCase, iterations = 10000) {
  if (!valuesByCase.length) return null;
  let seed = 412783;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < valuesByCase.length; j++)
      sum += valuesByCase[Math.floor(random() * valuesByCase.length)];
    means.push(sum / valuesByCase.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: valuesByCase.reduce((s, v) => s + v, 0) / valuesByCase.length,
    low: means[Math.floor(iterations * 0.025)],
    high: means[Math.floor(iterations * 0.975)],
    cases: valuesByCase.length,
    method:
      "Descriptive paired case-cluster percentile bootstrap, 10000 fixed-seed draws. Convenience sample; repetitions are not independent tasks. No confirmatory significance or population claim.",
  };
}
