---
title: "HyperAgents-inspired learning: first study"
description: "Implementation, controlled experiments, costs and the limits of instruction-only learning-strategy evolution."
---

The first study supports keeping the evaluation and transfer infrastructure, but **does not support deploying evolving proposers as a source of collective improvement**. Fixed proposers solved 2/24 source held-out cases; evolving proposers solved 1/24. Transferring a learned proposer improved neither recipient setting. These are small synthetic feasibility results, not a general rejection of HyperAgents or self-improving agents.

Collected 1 November 2026 in Toronto, finishing 2 November UTC. The implementation is original Bitterbot code inspired by the [HyperAgents research](https://arxiv.org/html/2603.19461v1); no HyperAgents source was incorporated. See the [implementation guide](./learning-strategy-lab.md) for the implemented boundaries and experiment harness.

## What was implemented

`ProceduralLearning.strategies` adds an explicit, shadow-only host capability to the existing per-agent service and SQLite database. It provides separate bounded actor/proposer instructions, an immutable archive retaining unsuccessful branches, parent lineage, local execution evaluation, proposal accounting, final-panel seals, withdrawal and expiry. It reuses the existing resource ledger and authenticated peer envelope format. An imported strategy receives no source qualification and must be evaluated locally.

Strategy packets cannot enter the ordinary active-skill or crystal routes. Private development feedback makes its descendants private. No new background scheduler, live dream mutation, model-weight training, production activation or public-network publication was enabled. This is a finite experiment facility; sealed scopes do not automatically roll over into another learning epoch. The existing per-agent boundary is not a new per-user isolation system.

## Experiment

The [runner and reproduction instructions](../../benchmarks/learning-strategy/README.md) use `claude-sonnet-4-6` to discover finite numeric and sequence tool contracts. Actors see candidate definitions, choose up to three probes, and submit an implementation. An independently written host oracle checks behavior on a fixed challenge suite. Simulator/reference agreement passed 9,936 checks before paid collection.

The source study crossed fixed/evolving proposers with incumbent/population parent selection. Each of two seeded task cohorts used three development tasks, three proposal generations, and six final tasks per arm. Model sampling was not seeded. Population search sometimes explored a non-best archived branch. Candidate selection used development success, then observed execution cost. Both the selected candidate and unchanged starting actor were frozen before final evaluation. When selection retained the starting strategy, its single evaluation served both roles.

The recipient study reset actor instructions and transferred only the proposer from the predesignated first-cohort evolving-population source. Each recipient used four development cases, one proposal generation and six final cases. Fresh and transferred proposers ran in separate stores. The two settings were a new sequence domain and numeric-tool drift. Twelve isolated study databases and signed in-process envelopes exercised source/recipient boundaries; this was not a live Rust mesh test. The compatibility scope identified the stable lab interface, while simulated function domain/version varied inside its inputs.

Development and final panels used disjoint deployed hypothesis IDs within a cohort. Different IDs can still implement equivalent behavior, and both panels come from the same finite family. Final outcomes were never used for selection or proposals.

## Source results

All entries below are successes out of six final cases. Costs include starting-agent evaluations, all proposals and unsuccessful branches, final evaluation, and the baseline comparison.

| Task cohort | Proposer | Parent selection | Starting actor | Selected actor | Provider USD |
| ----------- | -------- | ---------------- | -------------: | -------------: | -----------: |
| 17011       | Fixed    | Incumbent        |              1 |              1 |     0.544749 |
| 17011       | Fixed    | Population       |              0 |              0 |     0.403587 |
| 17011       | Evolving | Incumbent        |              0 |              1 |     0.493359 |
| 17011       | Evolving | Population       |              0 |              0 |     0.527103 |
| 27011       | Fixed    | Incumbent        |              0 |              0 |     0.411126 |
| 27011       | Fixed    | Population       |              1 |              1 |     0.506748 |
| 27011       | Evolving | Incumbent        |              0 |              0 |     0.395865 |
| 27011       | Evolving | Population       |              0 |              0 |     0.410865 |

Across arms, selected actors scored 3/48 versus 2/48 for their starting actors. Evolving-minus-fixed proposer contrasts were 0, 0, 0 and −1 case across the four cohort/selector comparisons. Population and incumbent totals were 1/24 and 2/24 respectively. These pooled counts are descriptive: repeated tasks and shared starting instructions are not independent replications. Two task cohorts are insufficient for a reliable efficacy or significance claim.

## Recipient results

| Setting      | Starting proposer | Starting actor | Selected actor | Recipient USD | Allocated source USD | Standalone deployment USD |
| ------------ | ----------------- | -------------: | -------------: | ------------: | -------------------: | ------------------------: |
| Sequence, v1 | Fresh             |            1/6 |            1/6 |      0.266682 |                    0 |                  0.266682 |
| Sequence, v1 | Transferred       |            0/6 |            0/6 |      0.239919 |             0.527103 |                  0.767022 |
| Numeric, v2  | Fresh             |            0/6 |            0/6 |      0.267072 |                    0 |                  0.267072 |
| Numeric, v2  | Transferred       |            1/6 |            0/6 |      0.357435 |             0.527103 |                  0.884538 |

The imported proposer differed from the initial proposer; this was an actual strategy transfer. In the sequence setting, selection retained the original actor. Under numeric drift, the transferred proposer produced a child scoring 1/4 on development but 0/6 on final tasks, below its starting actor's 1/6. No recipient benefit was demonstrated.

Source discovery was physically paid once. For each standalone transfer deployment, the table conservatively allocates the complete source arm cost, including its evaluation overhead. Those allocations must not be added again to physical study spending. A shared deployment could amortize that cost, but amortization does not create a performance gain.

## Strong control and failure diagnosis

A deterministic information-gain policy, with the same public hypotheses and observable probes, solved all **24/24 distinct final-panel cases** without provider calls. This is a stronger and cheaper solution to this particular finite problem.

A post-collection audit classified all 230 development and final episodes: 16 passed, 19 had invalid actions, 161 failed with a submission inconsistent with observed probe results, and 34 failed despite a submission consistent with the limited observations. Every observed history admitted at least one consistent hypothesis. All 929 provider calls ended normally; no main-study proposal failed schema validation. Thus the main results were not another text-truncation pilot failure.

These diagnostic categories were computed after collection and are not causal treatment estimates. They suggest the main bottleneck was reliable calculation and hypothesis tracking. The actor had no computation/scratchpad tool, extended thinking was not enabled, and responses were constrained to action JSON. Longer instructions did not reliably overcome those execution limitations. This is a narrow instruction-only test, not a reproduction of HyperAgents' executable-code evolution or Bitterbot's full agent harness.

## Accounting and amendments

| Run        | Known provider USD | Unresolved reservation USD | Interpretation                                                         |
| ---------- | -----------------: | -------------------------: | ---------------------------------------------------------------------- |
| Pilot v1   |   No usage receipt |                   0.073722 | Sandbox network failure; liability retained                            |
| Pilot v2   |           0.147381 |                          0 | Text-only action formatting/truncation failure; excluded from efficacy |
| Pilot v3   |           0.165462 |                          0 | Schema-constrained actions; 2/6 numeric and 2/6 sequence successes     |
| Main study |           4.824510 |                          0 | 929 priced calls; complete assigned arms                               |
| Total      |       **5.137353** |               **0.073722** | **5.211075** maximum accounted exposure against the $10 ceiling        |

These are usage-based list-price estimates using frozen [provider pricing](https://platform.claude.com/docs/en/about-claude/pricing), not invoices. They exclude engineering time and local compute. No usage receipt means unknown spending, not a claim of zero cost.

Pilot v3 qualified the main source headroom gate. Before main collection, the panel generator was amended to enforce disjoint development/final hypothesis IDs and the final baseline comparisons were specified. No main outcome informed those changes. All paid pilot attempts remain in accounting.

The main run froze its protocol and 12 source files before paid calls. After completion, the original analyzer rejected an effectively zero reservation balance of `-5.551115123125783e-17` USD, produced by floating-point subtraction. The analyzer was corrected to accept only negligible roundoff after checking that every intent has a unique receipt; a regression test still rejects a 0.001 USD reservation. Future status output normalizes the tiny residue. Original collection files and frozen sources were preserved. The [analysis amendment](../../benchmarks/learning-strategy/data/study-sonnet-2026-11-01-v1.zip) records the correction and hashes the post-collection analysis code.

The audit independently recomputed all 929 charges from raw provider usage, checked prompt hashes and model identity, and reconciled provider and node totals. The initial sandbox-failure reservation remains separate and unresolved.

## Engineering validation and decision

63 targeted tests passed: 14 strategy/persistence/ingestion tests, 12 benchmark/oracle/accounting/analysis tests, and 37 existing procedural-learning and skill-ingestion regression tests. The full `tsc --noEmit` check passed. Scoped lint and formatting checks passed. The repository's native TypeScript checker and type-aware lint executable were unavailable in this installation, so verification used standard TypeScript plus ordinary lint. Immediate SQLite close/reopen was tested; actual 24-hour retention was not.

Keep the archive, execution evidence, cost accounting and local recipient validation. They make future learning claims testable and fit the current service boundaries. **Do not enable evolving proposers in the live dream loop on this evidence.** The current study shows neither a source advantage nor useful transfer.

The next justified experiment would use real, qualified workflow failures with the normal computation tools and compare against the existing verified-procedure/cache system, a strong fixed policy and current curiosity selection. Executable procedures or bounded host-defined policy primitives are a more direct response to the observed tracking failures than further prompt growth. A larger study should be contingent on genuine headroom against those stronger controls, with its outcome and full acquisition-plus-use cost criteria fixed before collection.

This study establishes no broad cross-user learning, native-network efficacy, multi-user privacy guarantee, production improvement or model-weight learning. Its value is a working experimental path and a recorded negative result for this particular variant.

Evidence: [analysis](../../benchmarks/learning-strategy/data/study-sonnet-2026-11-01-v1.zip), [receipt and failure audit](../../benchmarks/learning-strategy/data/study-sonnet-2026-11-01-v1.zip), [frozen protocol](../../benchmarks/learning-strategy/data/study-sonnet-2026-11-01-v1.zip), [complete results](../../benchmarks/learning-strategy/data/study-sonnet-2026-11-01-v1.zip). Raw synthetic responses, signed transfer bytes and per-node SQLite databases remain beside those files.
