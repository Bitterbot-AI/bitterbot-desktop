# LongMemEval-V2 Medium implementation and preflight report

Full evaluation has not started. No official score exists. Work is in the current WSL checkout, on main at cd4562a7038a1700ae4d19a345223e98d5b9efb3. The existing root README.md change is preserved. All harness changes are under benchmarks/longmemeval-v2.

## Verified implementation

The harness uses real session ingestion, MemoryIndexManager sync/consolidate/dream/search, deferred embedding backfill and production working-memory synthesis. Workers run with generated isolated profiles, no credentials, Landlock file restrictions and seccomp network denial. Gold answers, evidence labels and evaluator metadata stay outside worker access. The official reader prompts, context truncation, scoring and packaging functions are imported from a pinned, unmodified upstream checkout.

Checkpoints commit only closed, hashed profiles at dream boundaries; incomplete attempts remain failures. Resume verifies source/configuration/data identity and checkpoint integrity. Costs and unresolved reservations persist in SQLite. Per-question failures stop progress and require explicit retry; they cannot silently reduce the denominator.

See README.md for exact historical clock, dream schedule, replay format, pins, CLI commands and limitations.

## Actual validation

- Eight harness tests passed: spending guard, durable unresolved charge, checkpoint corruption, label-schema rejection, ordered-history identity, full-run authorization, actual OS file/network containment, and OpenRouter request mapping.
- TypeScript check passed with exit code zero for the worker and its production dependency graph.
- Seven official upstream query-privacy tests passed.
- The pinned Qwen processor loaded and counted an actual trajectory goal using the unchanged official token-count function.
- A complete real official trajectory (080b970d, 35,417 bytes) passed ingestion, consolidation, LLM dream synthesis, embedding backfill, retrieval and durable checkpoint/resume. The final test produced 42 indexed chunks, three dream insights and 15 retrieval items in 48.6 seconds. Resume repeated no completed API work.
- Final successful test cost: US$0.01153548. Cumulative cost including development attempts: US$0.06318502 against the approved US$1 cap.
- Official dataset text/metadata checksums and indexed trajectory checksum passed. Screenshot archives have not been downloaded.
- The full reader, judge and submission packaging sequence has not been exercised end to end. Passing the memory test is not an official evaluation result.

Raw evidence lives under .runtime/checkpoint-final, .runtime/plumbing-budget and .runtime/typecheck.status.json. These artifacts are ignored by Git; retain them with a reproducibility archive. Failed development attempts were retained.

## Full-run screening estimate

The release has 451 questions (240 web, 211 enterprise) and 447 distinct ordered histories. Isolated replay requires 222,634 trajectory ingestions, about 176.9 GB of raw trajectory text and 6.67 million states. Most histories contain 500 trajectories.

Run `python3 benchmarks/longmemeval-v2/estimate.py` to regenerate projection.json from the measured plumbing ledger and pinned dataset inventory. A simple byte-scaled ingestion estimate plus scheduled dream cycles gives approximately US$3,250 in memory API charges. This is a screening estimate from one small trajectory, not a validated budget. Allowing a factor of two either way suggests roughly US$1,600–6,500 before scaling failures, extra dream work and infrastructure. That range is illustrative, not a statistical confidence interval.

Serial runtime is the larger concern: the final sample extrapolates to roughly 990 days. An earlier successful ingestion took about half as long, implying roughly 1.5–3 years of serial work at these small-sample rates. Growing databases, repeated sync/consolidation, checkpoint copying and API limits can make it slower. A representative full-history capacity pilot is required before treating any figure as reliable. No multi-year job has been started.

At the currently listed DeepInfra reader tariff, 451 calls each using 200k input and 20k output tokens cost about US$10.37; image accounting and actual token counts must be measured. GPT-5.2 judge output alone would cost US$25.86 if all 451 questions used the entire 4,096-token allowance; add judge input charges. Some questions use deterministic scoring. The reader is not the dominant projected API expense.

Time was approved as unlimited. A separate US$100 capacity pilot has now been authorized and launched. A full-run API dollar cap has not been approved.

## Hardware and storage

With a hosted reader, the memory host needs no GPU. Plan around 64 GB RAM and several TB of SSD storage until a full-history pilot measures retention and index growth. The current WSL allocation (4.8 GiB RAM, about 880 GB free disk) is insufficient for this conservative plan.

As an order-of-magnitude storage check, extrapolating 26 ingestion chunks per 35 KB gives about 130 million chunk occurrences. Two 1,536-dimensional float32 vector representations alone would approach 1.6 TB per retained profile generation. Two checkpoint generations plus query copies can bring this toward 4–8 TB before actual forgetting, deduplication, SQLite overhead and compression are measured. This is a capacity warning, not an asserted final database size.

If self-hosting the official reader, plan for a 48 GiB+ GPU and 64 GiB host RAM, then validate long-context vision capacity. The local 16 GiB RTX 4080 cannot hold approximately 18 GB of BF16 weights alone. Kaggle's bounded sessions and disk are better suited to separate reader batches than persistent full memory preparation. Prepare prompts before paying for a reader GPU.

## OpenRouter status and remaining decisions

The key in the Windows checkout's .env authenticated successfully; it was neither printed nor copied into the benchmark. Only free metadata/authentication endpoints were called.

The saved endpoint catalog lists DeepInfra BF16 for qwen/qwen3.5-9b, 262,144 context, top-k/top-p/temperature/reasoning support and US$0.10/M input, US$0.15/M output. The example configuration pins deepinfra/bf16, disables fallback, requires all parameters and enables reasoning. The catalog does not identify the exact Hugging Face weight revision. Actual image handling, reasoning behavior and official-reader request compatibility still require a paid endpoint probe. Endpoint support declarations alone do not establish strict reproducibility.

The OpenRouter example remains blocked until weight revision evidence and a dollar cap are supplied. OpenAI embeddings expose an alias rather than immutable weights; that limitation is declared and request IDs/served model names are recorded. Strict weight-level reproduction also requires a stable embedding deployment.

Next decisions are a full API spending cap and capacity-pilot budget, plus a host with sufficient memory/storage. A revision-verified Qwen endpoint is required before claiming a comparable, pinned official-reader run.

Sources: [official benchmark](https://github.com/xiaowu0162/LongMemEval-V2), [official dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2), [OpenRouter endpoint catalog](https://openrouter.ai/api/v1/models/qwen/qwen3.5-9b/endpoints), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Kaggle notebook limits](https://www.kaggle.com/docs/notebooks).

## Capacity pilot launch

The user authorized a cumulative US$100 pilot. The running controller uses capacity-pilot.json and capacity_pilot.py, with its own durable ledger under .runtime/capacity-pilot. Selection is deterministic and label-blind: the median-sized ordered web history (479 trajectories, 285,485,889 raw bytes) and enterprise history (500 trajectories, 531,524,884 raw bytes). It alternates domains at 4, 16, 64, 256 and full-history milestones; normal four-trajectory dream boundaries are unchanged.

Nine harness tests passed before launch, including a check that partial pilot stops cannot introduce an extra dream boundary. Live status is in .runtime/capacity-pilot/status.json; checkpoint measurements in capacity.jsonl; five-second process-tree RAM/swap samples in resources.jsonl; costs in accounting.sqlite. A final accounting report is written when the controller completes or stops. This launch is not a completed capacity result and does not revise the screening estimates above yet.

## Accuracy follow-up authorized

The user requested correct/incorrect results for the two selected histories within the same US$100 pilot cap. diagnostics/score_pilot.py is queued independently without changing the running capacity controller's pinned source or configuration. It will grade only complete histories and will retain blocked/error states otherwise. The reader uses DeepInfra BF16 Qwen3.5-9B, and the original official scorer uses the pinned GPT-5.2 judge when needed. The diagnostic manifest declares the unverified hosted weight revision. Two selected questions cannot support an overall performance estimate.

A one-time follow-up is scheduled for 08:00 America/Toronto to report overnight progress, costs, failures and any scored answers. The computer and WSL must remain running.

## Recovery work (2026-10-09)

The overnight run stopped after four committed web trajectories and an uncommitted four-trajectory enterprise group. A dream extraction request timed out at 600 seconds. Total reserved/known pilot charges were US$1.31915354; peak process-tree RSS was 614,100,992 bytes. No question was scored.

The authorized recovery adds up to three transient transport attempts, independent per-attempt accounting, immutable pre-dream snapshots and web-first processing. The immediate resumed target is 32 web trajectories for a better capacity review. The previously failed enterprise state remains preserved and is not accepted as complete. Fourteen tests passed, including fault-injected dream resume without repeated ingestion and budget checks before retries. A real-data recovery validation and its cost are recorded separately under .runtime/capacity-pilot/recovery-validation.

## Production synthesis repair (2026-10-09)

The subsequent run committed 20 web trajectories and preserved a clean pre-dream checkpoint for 24, then stopped because synthesis emitted 21 crystal pointers against a limit of 20. Cumulative charges at that stop were US$5.84057724. The fallback was rejected; no question was scored.

The production fix keeps the limit at 20 and shares it between the prompt and validator. Previously the prompt specified only an 800-token budget for the pointer section, without stating its count limit. Invalid output now receives one bounded LLM repair request; the corrected document is checked against the original prior state and all existing collapse/section guards. Invalid repair still falls back in ordinary production behavior and still stops this benchmark. There is no truncation or benchmark-specific answer logic.

Fifty-nine production tests, fourteen harness tests and the TypeScript check passed. The pilot resumed the failed dream from the immutable 24-trajectory pre-dream state, without reingesting those trajectories. Previous production files, manifest and the explicit revision amendment are retained under .runtime/capacity-pilot/synthesis-fix-v1. This pilot spans recorded source revisions and must not be presented as a single-version official score; a future official evaluation must start with the chosen fixed source revision.

The limit's stated purpose is eviction-runaway protection. Git history traces it to the initial commit and provides no experimental justification for exactly 20. Its numeric value remains a heuristic policy, not an established capacity boundary.

## Credit-refill recovery

The user confirmed the OpenAI credit balance had run out and was replenished. A real text-embedding-3-small request then succeeded, charged to the existing pilot ledger. The ledger's prior failed-request reservations were retained; the balance before resuming was US$8.96729578, not a claim of reconciled invoice spending.

The broker now rejects subsequent requests after an unrecovered API failure, and the worker aborts immediately after bounded retries fail instead of continuing production extraction calls. Fifteen harness tests passed. The source/configuration amendment and preflight evidence are under .runtime/capacity-pilot/credit-recovery-v1. Resume uses the same clean 24-trajectory pre-dream checkpoint and the unchanged US$100 cap.

## Small accuracy priority and US$500 authorization

The user authorized a combined US$500 cap and a separate Small-tier directional accuracy diagnostic. The shared ledger stood at US$12.62126638 when Medium was interrupted for this priority change; reservations and failed attempts were preserved. Medium's pre-dream checkpoint remains recoverable.

The immutable official Small haystack hash is 9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593. Small has two shared histories, each exactly 100 trajectories. Five deterministic ID-sampled questions per domain were selected without consulting labels. Total replay is 171,037,057 raw bytes. Web questions will be scored immediately after the web history completes; enterprise follows. Question-level results are published incrementally under .runtime/capacity-pilot/small-accuracy/report.md. Pending or failed questions are never represented as scored.

Fifteen harness tests passed before launch; deterministic selection was checked against reversed input ordering on the actual official release. Reader/scorer execution still requires completing a history. This ten-question diagnostic is not an overall benchmark score and retains the hosted reader revision caveat.

## Focused pointer repair

Small reached 20 committed / 24 ingested web trajectories and again rejected a 21-pointer synthesis after full-document repair. The saved pre-dream memory already contained 20 pointers, with related order-history, review-extraction and UI-workflow topics. The rejected model draft itself was not retained, so it is not claimed as an exact replay fixture.

The production repair now asks the LLM to merge only the pointer section into a structured JSON list targeting at most 16 entries. The original 20-entry hard limit remains unchanged. Acceptance requires every original search-query phrase to survive, with exact phrase boundaries after whitespace/semicolon normalization. Separate quoted query spans are normalized into one search string without deleting content. The rest of the document is preserved byte-for-byte and all existing whole-document guards run again. Invalid, lossy or over-limit repair is rejected.

A real model call using the actual saved 20-pointer section produced 13 merged entries. All original search phrases survived, all non-pointer content remained unchanged, and validation passed. This is a focused real-data repair check, not a benchmark answer or a guarantee that every future synthesis will pass.

Sixty-three production tests, fifteen harness tests and TypeScript checks passed. Previous source files/manifests, test outputs and the real probe are retained under .runtime/capacity-pilot/pointer-repair-v2. The Small controller resumes the clean pre-dream checkpoint for 24 trajectories, with the shared US$500 cap and existing ledger preserved.

### HTTP 520 recovery, 2026-10-10

Added HTTP 520 to bounded transient retries (three attempts, 2/4 second backoff). Corrected generic worker error wording so it does not imply retries occurred for permanent failures. Seventeen harness tests pass, including 520 recovery, exhaustion, ledger reservations, permanent-error fail-fast, budget protection and checkpoint reuse. Archived sources and manifests in `.runtime/capacity-pilot/http520-recovery-v1`; verified the immutable 32-trajectory pre-dream checkpoint. Shared $500 cap and prior charges retained. This amended diagnostic remains unsuitable as an official single-version benchmark score.
