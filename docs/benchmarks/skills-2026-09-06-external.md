# Skill ablation 2026-09-07

PLAN-45 Phase 5.1/5.2. Regenerate with the command in the header; `--check` verifies this report against the committed corpus version.

```json
{
  "harnessVersion": 2,
  "generatedAt": "2026-09-07T03:23:41.981Z",
  "argv": [
    "--arms",
    "none,harvested,evolved,in-context",
    "--corpora",
    "external",
    "--external",
    "/tmp/claude-1000/-mnt-d-Bitterbot-bitterbot-desktop/0aedca56-5c41-42f0-85ae-12471562affe/scratchpad/csb",
    "--external-domains",
    "math",
    "--models",
    "primary",
    "--cap",
    "6",
    "--trials",
    "2",
    "--seed",
    "0",
    "--yes",
    "--out",
    "docs/benchmarks/skills-2026-09-06-external.md"
  ],
  "executor": "embedded",
  "generatorVersion": 5,
  "exemplarSha256": "c5aba5c68af0b4a382c5a2c3b92653933bbb493cb4b7bcff262b2792f40e51ed",
  "seed": 0,
  "cap": 6,
  "trials": 2,
  "corpusVersions": {
    "external": "csb-math-det63"
  },
  "models": {
    "primary": "anthropic/claude-opus-4-8"
  },
  "arms": {
    "none": [],
    "harvested": [
      "ebookfoundation-free-programming-books-alt",
      "freecodecamp-freecodecamp",
      "freecodecamp-freecodecamp-alt",
      "openclaw-openclaw-alt",
      "public-apis-public-apis",
      "sindresorhus-awesome"
    ],
    "evolved": [],
    "in-context": []
  },
  "nodeState": {
    "live": 6,
    "evolved": 0,
    "harvested": 6,
    "privateTasks": 0
  }
}
```

## Node state

- Live skills: 6 (evolved 0, harvested 6); private capability tasks: 0.
- Arm `evolved`: no evolved skill is live on this node.
- Arm `in-context`: no evolved skill to build a control for.
- Corpus `external`: ContinualSkillBench (Apache-2.0) deterministic subset: 63 tasks; skipped programmatic 12, rubric_judge 25 (need the benchmark's verifiers or a judge).

## Results

### primary (anthropic/claude-opus-4-8) on external (csb-math-det63)

| Arm       | Tasks | Trials | pass@1 |    pass^K | Read rate | Tokens | Errors |
| --------- | ----: | -----: | -----: | --------: | --------: | -----: | -----: |
| none      |     6 |     12 |    67% | 50% (K=2) |       n/a |  82638 |      0 |
| harvested |     6 |     12 |    83% | 83% (K=2) |        0% |  58915 |      0 |

| Comparison        |   n | W/L/T |      p | Mean delta |       95% CI | Credited W/L/T | Token delta |
| ----------------- | --: | ----: | -----: | ---------: | -----------: | -------------: | ----------: |
| harvested vs none |   6 | 2/0/4 | 0.2500 |      +0.17 | [0.00, 0.33] |          0/5/1 |       -0.29 |

- the harvested arm did not measurably beat the none arm (2/0/4 W/L/T over 6 tasks, delta +0.17, p=0.250, 95% CI [0.00, 0.33]); inconclusive. Token delta -0.29; credited (skill read) 0/5/1, p=1.000.

## Caveats

- n is small: the canonical corpus carries 9 capability tasks per seed; a paired test below 5 tasks makes no claim.
- The labeler's real-trace calibration accuracy is 0.52 on a stratified sample with rater B pending (benchmarks/skill-evolution/README.md); task checkers here are deterministic, so that does not affect these numbers, but it bounds what the live loop can learn from.
- Executor: embedded runs on anthropic/claude-opus-4-8; one node, one day.
