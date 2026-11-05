// Selected prospectively from task metadata, never from new model outcomes.
export const DIAGNOSTIC_PROTOCOL = {
  purpose: "missing-diagnostic-mechanism-qualification",
  indices: [2, 28, 31],
  repetitions: 1,
  schedule: [
    { arm: "baseline", repetition: 0, indices: [2, 28, 31] },
    { arm: "static", repetition: 0, indices: [28, 31, 2] },
    { arm: "conditional", repetition: 0, indices: [31, 2, 28] },
  ],
  minimumHeadroomUsd: 2.5,
  estimatedNewSpendUsd: [1, 2.5],
  hypothesis:
    "When MMS still fails after reported strong signal and allowance is unknown, a targeted check reminder can prevent omitted diagnostics without reducing task success.",
  comparison:
    "Single new rule: original actor, identical rule predicates/text always present, and the rule conditionally delivered from public observations. This isolates the missing-check hypothesis rather than combining it with the previous four rules.",
  caseSelection:
    "Three previously unexecuted cases selected from pinned metadata: index 2 mobile-data/roaming control; index 28 MMS/permission/allowance problem; index 31 MMS/network/permissions problem without exhausted allowance. Deliberate coverage, one draw per arm/case, not a population accuracy estimate. Hidden case labels, states and solutions never enter actor prompts or reminder routing.",
  isolation:
    "Fresh sealed SQLite per arm with three-case panels, and fresh native environment per episode. Same v5 grounded simulator in all arms. Customer device tools remain private; routing sees public speech and owned account tool results only.",
  decision:
    "Require all nine natural completions. First report whether the conditional mechanism actually activates, its evidence and the next diagnostic actions. Apply the same descriptive paired no-regression/call/cost gate against both controls, but regard zero activation as unexercised even if cheaper. No promotion or efficacy conclusion from three unseeded pairs. Grounding/resource stops censor the comparison and remain charged.",
  noTuning:
    "Freeze before any new call. No retries, replacement cases, mutation or rule tuning during collection. Cases become consumed as soon as dispatched. Rotate case order within arm blocks. Arm order is fixed baseline/static/conditional and is not counterbalanced; order and caching remain confounders. Report uncached-equivalent cost alongside actual usage.",
  budget:
    "Explicitly authorized cumulative ceiling is $15; pass 15 at preparation and collection. This distinct nine-episode protocol requires $2.50 headroom before dispatch. Conservative per-call reservations and the global cumulative cap can stop collection earlier; no automatic cap increase.",
};
