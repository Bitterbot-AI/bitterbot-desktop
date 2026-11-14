# Two-node deployment driver

`deployment-cli.ts` runs the actual Bitterbot embedded model runner and package coordinator in two separate worker processes. Each condition gets a fresh pair of identities, SQLite databases, package stores, credential profiles, and workspaces. Only two workers run at a time. They exchange signed, encrypted Circle messages over loopback HTTP; this deployment never joins the production public mesh.

The driver implements `StudyDriver` in `study.ts`. A deployment can execute all four conditions, resume completed commands without repeating model calls, collect independently checked outputs, and run fresh-session retention after 24 real hours. Node qualification ledgers retain their original receipts. The controller's group ledger is the authoritative source for aggregate study costs, so the same execution is not counted twice.

The `research-brief-v3` task contract explicitly requires converting timestamped publication dates to UTC before taking their calendar date. Date-only values stay unchanged. Both incumbent and candidate receive this rule, including the requirement to use matching dates in JSON and Markdown. Ambiguous timestamps without a timezone and impossible dates are rejected before model execution. The public instructions, date schema and conversion logic are bound to the environment/checker identity, and `readiness.json` includes the public contract for review.

Earlier v2 smoke receipts are preserved. Their offset-date rejection remains inconclusive because the task did not state the checker's UTC requirement. Use a newly prepared v3 deployment for subsequent comparisons; never relabel those earlier observations as v3 evidence. The baseline package remains the same experimental library, and any proposed package correction must pass the ordinary local gate.

## Prepare

Run on Linux or WSL with Node 22, the repository dependencies, Docker, and a prepared image containing the package's Python requirements. Images are inspected and pinned; the driver never pulls images or installs packages. A disposable, network-disabled probe verifies the ordinary shell/sleep entry point and Python 3 before any model request. Use an existing provider configuration and credential directory. Preparation copies the provider configuration into private study directories without altering the normal gateway configuration.

On WSL, keep the deployment directory on the native Linux filesystem, for example under `~/.local/share/bitterbot-studies/`. Windows-mounted directories can make SQLite schema creation and durable writes substantially slower. The repository itself may remain on the Windows drive. Keep the deployment directory private and persistent for the 24-hour retention interval.

```sh
node --import tsx benchmarks/collective-learning/deployment-cli.ts corpus /absolute/path/development-corpus.json
node --import tsx benchmarks/collective-learning/deployment-cli.ts prepare /absolute/path/spec.json /absolute/path/new-deployment
```

Example specification:

```json
{
  "schemaVersion": 1,
  "id": "collective-development-pilot",
  "purpose": "development-pilot",
  "baseConfig": "/home/operator/.bitterbot/bitterbot.json",
  "authAgentDirectory": "/home/operator/.bitterbot/agents/main/agent",
  "model": "YOUR_EXISTING_PROVIDER/YOUR_EXISTING_MODEL",
  "sandboxImage": "YOUR_PREPARED_LINUX_IMAGE",
  "initialPackageDirectory": "/absolute/repo/test/fixtures/collective-learning/research-brief",
  "corpusFile": "/absolute/path/development-corpus.json",
  "seed": 20261111,
  "conditions": ["frozen", "local", "exchange", "pooled"],
  "groupCeiling": { "providerUsd": 10000, "toolCalls": 1000000, "wallMs": 604800000 },
  "maxCanaryBatches": 5,
  "retentionHours": 24
}
```

The ceiling applies to each entire condition, across both nodes and all cost phases. It is not a per-call allowance. Interrupted and unresolved calls retain their reservations. Credential files and raw study artifacts belong in an ignored private directory such as `reports/collective-learning/`, never in a publication bundle.

Evaluation uses the provider's sampling defaults, a 4,096-token output cap and a 16,000-token context cap. These settings are included in the environment fingerprint. This supports models such as Claude Opus 4.8 that reject non-default sampling parameters; a zero-temperature override is not required for the paired statistical gate.

Validation and proposal runs disable the tool-result cache, and that setting is part of the host environment fingerprint. Fresh scratch directories alone do not isolate a process-wide cache: different containers use the same visible paths, such as `/workspace/sources.json`. Ordinary agent runs scope cached results to a single tool binding, and cache hits still pass through current authorization and abort checks.

The first funded development deployment exposed cross-task read reuse and was stopped. Its entire performance sample is excluded, including apparently successful tasks; original receipts and unresolved cost reservations remain intact. The corrected deployment has a new frozen identity and uses the remaining original authorization. Do not combine the two deployments into one performance sample or reuse the old environment's qualification. The corrected pilot is still in progress; no efficacy or retention result is established.

Preparation refuses an existing destination. It freezes the exact corpus, initial package, model/environment fingerprints, configuration hashes, installed image digest, and execution source hashes. Startup verifies the same state again. Changes require a new deployment; an old result is never relabeled as current. The initial package is a common fixed experimental library, not a fabricated locally qualified release. Any learned update must earn qualification and finish its canary before it becomes the study's selected procedure or is published.

## Run and resume

```sh
node --import tsx benchmarks/collective-learning/deployment-cli.ts run /absolute/path/deployment
node --import tsx benchmarks/collective-learning/deployment-cli.ts report /absolute/path/deployment
node --import tsx benchmarks/collective-learning/deployment-cli.ts retention /absolute/path/deployment
```

The same `run` command resumes completed commands from durable journals. If a response was lost but the worker journal proves completion, the controller reconciles it. A command left running after a crash is not automatically repeated. Inspect both `study.sqlite` and the affected node's `node.sqlite` and `worker.log`; unknown provider costs require actual provider receipts before reconciliation. No command marks an unknown cost as zero.

Study grants are initialized once. Restarting preserves revocation and expiry, refuses to recreate a removed grant, and cannot restore disabled Circle membership. Recipient adoption is checked again before a qualified canary becomes the selected procedure.

Each condition follows the same acquisition, selection-reporting and final task schedule. Local learning proposes from the node's own observed failures. The pooled condition first exchanges eligible acquisition summaries and makes its single proposal opportunity from independent observations; it does not gain an extra same-day proposal. Package exchange follows local qualification in both exchange conditions. All proposed or received changes pass the paired gate and checked canary. Non-improvement, absent evidence or incomplete qualification remains visible and leaves the incumbent selected.

The corpus reserves 19 fresh selection panels for qualification/canaries and a twentieth common reporting panel. Six regression instances remain fixed. Final tasks and new users are separate from acquisition/selection. No generated task is substituted after a gate fails. Exhausting frozen panels stops that work. Learning closes before final evaluation. Retention refuses execution before the real deadline or before the first final evaluation; each execution opens a fresh session.

For a paid readiness check, prepare a **separate** deployment with `conditions: ["frozen"]` and run:

```sh
node --import tsx benchmarks/collective-learning/deployment-cli.ts smoke /absolute/path/separate-readiness-deployment
```

This performs one model task per node. It cannot be run against a four-condition deployment, so the smoke calls cannot alter its acquisition data or cost balance.

## Artifacts and human review

`study.sqlite` records reservations, actual costs, tokens, outcomes, checker identities, accessed package files, briefs and command journals. Each node retains its package receipts and lineage history. `observations.json` and `pilot-report.json` provide exported results, including unknown costs. Logs and complete briefs remain local; peers receive only permitted structured summaries.

Infrastructure errors retain bounded, redacted diagnostics in the local artifact and report. Those diagnostics never become peer evidence. When a condition has unresolved reservations, its reported `dollars` is `null`; `knownDollars` and `reservedDollars` remain separate. Missing usage never becomes a zero-cost receipt.

Recoverable tool warnings are recorded separately from model failures. A completed model run still reaches the host checker: valid deliverables can pass after a failed optional tool probe, and incorrect or missing deliverables remain task failures. A tool warning cannot hide a regression as unavailable infrastructure.

```sh
node --import tsx benchmarks/collective-learning/deployment-cli.ts review /absolute/path/deployment /absolute/path/blind-bundle.json
node --import tsx benchmarks/collective-learning/deployment-cli.ts ratings /absolute/path/deployment /absolute/path/ratings.json
```

The review bundle omits condition, model, package identity, automated verdict and costs. Raters score usefulness and recommendation quality separately from factual checking. Keep `review-map.json` and `review-key` away from raters. A ratings file contains `raterId` and `items`, each with `reviewId`, integer `usefulness` and `recommendation` scores from 1–5, and optional comments. Conflicting replacements of submitted ratings are refused; multiple independent raters are retained and averaged only for reporting.

## Interpretation

The generated corpus is an authored development fixture, not a sample of real users. Its 20 parameterized research families support deployment and feasibility checks; they do not establish population efficacy or justify an independent-family power assumption. A successful smoke call is evidence that the model, sandbox, hidden checker and accounting path work together. It is not evidence that exchanging packages improves performance.

For an efficacy study, supply a separately frozen independent corpus, use `purpose: "efficacy-study"`, and pass the preregistered manifest as the final argument to `run` and `retention`. The driver binds it before acquisition and checks model, tools, library, corpus, seed and group ceilings. Use the existing pilot planning CLI to determine sample requirements from a suitable independent development pilot. `analyze` requires the bound manifest and refuses to make an efficacy claim for a development deployment. Missing retention, unresolved costs, incomplete observations or negative results remain inconclusive/negative.

This implementation uses two independent processes on one machine. It exercises real encrypted transport and separate durable state; it does not claim two independent physical hosts or a geographically distributed network. Public publishing stays disabled. A multi-host driver would need authenticated remote process control and separate deployment configuration.
