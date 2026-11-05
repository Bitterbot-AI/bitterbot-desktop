# Synthetic workflow data for the learning-strategy lab

This bundle contains **150 English customer-service tasks** from Sierra Research's [tau-bench v2.0.0](https://github.com/sierra-research/tau2-bench/releases/tag/v2.0.0). These supply simulated users, tool workflows and outcome criteria without waiting for production conversations. We downloaded the actual task definitions, policies, language metadata and frozen subset manifests; this is more than a dataset shortlist.

The data is pinned to commit `989d3285ae669e49503324bdb9981bf14fccedeb`, benchmark `text-v1`, revision `regional-release-data-v16`. Upstream files retain the [MIT license](upstream/LICENSE). [provenance.json](provenance.json) records each source path and Git blob hash; [inventory.json](inventory.json) contains the task catalog and SHA-256 hashes. The inventory is for the experiment host, not the acting agent.

| Domain  | Cases | Example work                                          | Reward components in these task files                |
| ------- | ----: | ----------------------------------------------------- | ---------------------------------------------------- |
| Airline |    50 | Booking changes, cancellations and policy compliance  | Database state plus communication checks             |
| Retail  |    50 | Returns, exchanges and order changes                  | Database state plus natural-language assertions      |
| Telecom |    50 | Device/network diagnosis, account and service repairs | Environment assertions; 9 also require action checks |

**Start with the 41 telecom cases whose reward basis contains only environment assertions.** Their declared success checks operate on environment state, giving us an initial panel without natural-language success grading. The user simulator still requires model calls. The exact IDs are in `inventory.json` under `stateOnlyTelecomTaskIds`; these are candidates for qualification, not a validated learning panel yet.

Data integrity and basic schema checks passed for all **16 upstream files and 150 tasks**. Downloading this bundle made no paid model calls. Subsequent work added a [native telecom adapter and qualification](../../telecom/README.md): all 41 supported reference repairs pass, while all no-op and omitted-repair controls fail. Airline, retail and action-graded telecom execution remain outside that adapter's scope.

## Verification and execution boundary

From the Bitterbot repository root:

```sh
node benchmarks/learning-strategy/datasets/tau-bench-v2-en/verify.mjs
```

The verifier checks byte-exact upstream Git hashes, frozen subset SHA-256 hashes, task counts, unique IDs, subset membership and basic evaluation fields. Do not format files under `upstream/`; `.gitattributes` preserves their bytes across checkouts.

This is a **data bundle, not a standalone simulator**. The [telecom sidecar](../../telecom/README.md) now supplies the pinned native tool implementations, base databases and environment assertions, with a custom text interaction loop integrated into the shadow strategy lab. It uses the English telecom task overrides. Full benchmark reproduction still requires the upstream runner and language/persona bindings; version 2 results are not comparable with the earlier 1.x benchmark.

Preserve native outcome evaluation. Reference actions commonly construct the expected database state; they are not automatically a required exact sequence. The pinned evaluation documentation says telecom does not use action checks, but the actual task files contain `ACTION` in 9 reward bases. The inventory follows the versioned task data.

## Proposed experiment

1. Qualify the runtime with successful reference executions and deliberately wrong/no-op executions. Confirm both intended outcomes and preservation of unrelated state. Check that the acting agent has normal tools and sufficient opportunity to reason, and that a baseline leaves measurable room for improvement.
2. Freeze development and held-out groups by underlying issue family or combination. Renaming a user or task does not create an independent problem. If the 41 cases cannot support distinct groups, use them for development and obtain additional scenarios before estimating transfer.
3. Compare no retained learning, the existing verified procedure/cache baseline, and learned procedures with the strategy lab. Give each arm the same task order, tools, model and budget. Separate procedure learning from an evolving-proposer ablation so we can identify what helped.
4. Transfer only the approved generalized procedure or strategy into a fresh recipient node with an isolated database. Requalify it locally, then evaluate on held-out users and cases. Source conversations and private user facts must not become shared skills.
5. Measure strict task success, regressions, repeated-run reliability, tool calls and total cost. Include user simulation, grading, proposals, failed requests and source discovery in the existing ledger. Freeze the final test before training; report this as a Bitterbot adaptation study, not an official benchmark score.

Task IDs sometimes spell out the hidden diagnosis. Keep IDs, task descriptions/purposes, reference actions, expected states, evaluation criteria and this inventory outside actor/proposer prompts and transferable memory. The actor receives public policy, tool schemas and observations/conversation. Private scenario instructions belong to the simulated user; the host alone receives grading data. Do not train candidates on held-out reference trajectories.

## Other sources investigated

| Source                                                            | Fit for Bitterbot                                                                                                                                | Current decision                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hyper-tau](https://github.com/sierra-research/hyper-tau-bench)   | 53 construction tasks: an outer developer builds an agent, then held-out simulated users test it. Directly relevant to the HyperAgents question. | Strong later test of broader agent construction; needs a Docker construction runtime and several model roles. Not downloaded or run here.                                                                                           |
| [AppWorld](https://github.com/StonyBrookNLP/appworld)             | Executable multi-app workflows; Bitterbot already has an adapter.                                                                                | Reuse the infrastructure with new task families. Our [previous composition panel](../../../../docs/memory/appworld-compositional-panel-qualification.md) reached 23/24 strict source successes and offers little accuracy headroom. |
| [ToolSandbox](https://github.com/apple-aiml-research/ToolSandbox) | Stateful personal-assistant tasks with dependencies and milestone/state checks.                                                                  | Useful backup, especially non-search scenarios. Check its own license and isolate execution; some search tools need external services.                                                                                              |
| [ThinkingBox](https://github.com/microsoft/thinkingbox)           | Advertises 507 synthetic business workflows with isolated tool sessions.                                                                         | Promising, but the separate data repository returned 404 and the dataset connection returned 401 during this investigation. Full executable data access remains unverified. The framework alone has only a smoke-test environment.  |
| [SynthTools](https://github.com/namkoong-lab/SynthTools)          | Large synthetic tool/task collection.                                                                                                            | Not imported: the inspected README limits use to academic review, and LLM-simulated state/judging is a weaker primary outcome check for this study.                                                                                 |

These tasks can establish evidence of learning and transfer in simulation. They cannot by themselves establish improvement for real users or long-term distributed deployment.
