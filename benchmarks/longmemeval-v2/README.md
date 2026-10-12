# Bitterbot LongMemEval-V2 Medium harness

This is a separate V2 harness. The older `benchmarks/longmemeval` directory targets the ICLR 2025 V1 benchmark and is not a V2 evaluation.

The full run is **not launched**. See `REPORT.md` for real-data validation, measured spending, projections, and remaining endpoint/budget decisions.

## Official protocol and pins

The authoritative sources are [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2), its [dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2), and its [submission protocol](https://github.com/xiaowu0162/LongMemEval-V2/blob/main/leaderboard/README.md).

`pins.json` pins the upstream commit, dataset revision and published checksums, Bitterbot base commit, and Qwen processor revision. Runtime manifests additionally hash the actual production source, harness, configuration and dependency locks; record the Git HEAD, Node/Python versions and installed Python packages; and refuse changed-identity resumes. An uncommitted harness is identified by its file hashes, not misrepresented as the base commit.

Medium covers all 451 questions: 240 web and 211 enterprise. Its histories are question dependent: 236 distinct ordered web histories and 211 enterprise histories. An identical ordered history may reuse its pre-query memory checkpoint. Different histories never share memory state. No oracle/evidence-only selection, question-category routing, heuristic scoring, or answer-specific extraction is implemented.

The evaluator uses the original upstream functions for:

- Domain system prompts and multimodal message construction.
- Qwen processor-based context counting/truncation at 200,000 tokens.
- Qwen3.5-9B reader requests: temperature 0.6, top-p 0.95, top-k 20, thinking enabled, 20,000 completion-token cap.
- Boxed answer parsing, unknown handling, deterministic scoring and GPT-5.2 medium-reasoning judge prompts.
- Domain metrics, official domain combination and official LAFS package construction.

Only transport and orchestration are replaced for durable accounting and checkpoints. Upstream's BadRequest-to-empty-answer behavior is deliberately not used: request failures fail the case. This changes error handling, not the scoring rubric. Failed questions never disappear from the denominator; no complete score is emitted until every question succeeds.

## Real production memory path

`worker.ts` writes full public trajectories as native session JSONL, then calls `MemoryIndexManager.get()`, normal `sync()`, `consolidate()`, `dream()`, production deferred-embedding backfill and `search()`. No replacement vector store, fake embeddings or benchmark-specific answer generator is used.

Each trajectory goal is a user message; its full state/action observations and outcome are assistant transcript entries. The ordinary transcript parser, redaction, chunking, embedding, crystal classification, hormonal state and retrieval logic remain active. Production session extraction and working-memory synthesis occur during the dream path. Normal manager reopen discovers new files while file watchers are disabled.

Retrieval is Bitterbot's text hybrid search. It does not embed the query image. The official reader still receives the question image, plus existing screenshots referenced in retrieved snippets. This is a declared limitation of this memory method, not a text-only alteration of the benchmark questions. Raw screenshots are not captioned or converted into synthetic facts.

A dream API/parse failure cannot silently become a successful LLM run: transport failures stop the case, cycle errors/null cycles fail, working-memory provenance rejects heuristic fallback, and pending embeddings must be drained successfully before checkpoint acceptance.

## Isolation

Linux x86_64, Landlock ABI 3+ and seccomp are required. There is no unsandboxed fallback.

The worker can read production source, dependencies and its own code, and write only its generated profile. It cannot read the dataset/evaluator files, another profile, repository `.env`, personal HOME, live Bitterbot state, or /proc process files. Network socket creation/connect/bind and process-memory inspection are denied. No gateway or P2P sidecar starts; the production memory bridge has no orchestrator attached.

Model calls cross a typed stdin/stdout broker. The worker has no API keys and can request only embedding or dream calls. Reader/judge calls occur in the evaluator process. Repository environment files are parsed as text for named credentials, never sourced or logged.

Each profile supplies isolated HOME, BITTERBOT_HOME, BITTERBOT_STATE_DIR, config, OAuth, XDG and temporary directories. Watchers and automatic consolidation/dream/digest/health/trending/research jobs are disabled. Only the explicit replay schedule runs.

## Historical replay and dreaming

The public trajectories contain no acquisition timestamps. The declared synthetic clock is:

- Ordered trajectory zero: 2025-01-01 00:00:00 UTC.
- Trajectory i: epoch + i × 2 hours; preserve the official haystack order exactly.
- Consolidation: 30 minutes after each acquisition.
- Dream: 90 minutes after every fourth trajectory, plus the final partial group.
- Query: the start of the next 2-hour slot.

Thus normal full dream boundaries are eight simulated hours apart, with 90 simulated minutes idle. Calls are explicit operator-style dream triggers; they do not falsify live user-turn gate counters. The production engine's own readiness check remains in place and a non-running dream is an explicit case failure for review.

Wall-clock Date behavior is virtualized only inside the worker. Timers and Python/performance clocks remain real. Production cycle `durationMs` can consequently be zero; use `stages.jsonl` and API accounting for actual latency. Math.random is seeded per historical operation; generated UUIDs and hosted model output are not claimed to be bitwise deterministic.

## Setup

Run in the current WSL checkout:

```bash
cd /home/vicmg/bitterbot-desktop
export PATH="/home/vicmg/.nvm/versions/node/v22.22.1/bin:$PATH"
B=benchmarks/longmemeval-v2
mkdir -p "$B/.runtime"
git clone https://github.com/xiaowu0162/LongMemEval-V2.git "$B/.runtime/upstream"
git -C "$B/.runtime/upstream" checkout --detach 2cc8c540bdb87fe6761629b585e727e1c4704520
python3.12 -m venv "$B/.runtime/venv"
"$B/.runtime/venv/bin/pip" install --extra-index-url https://download.pytorch.org/whl/cpu -r "$B/requirements.lock.txt"
python3 "$B/prepare.py" --data-root "$B/.runtime/data" --screenshots
"$B/.runtime/venv/bin/python" "$B/.runtime/upstream/data/prepare_data.py" --data-root "$B/.runtime/data" --mode symlink
```

Validation used Python 3.12.3 and the pinned CPU Torch 2.6.0 / torchvision 0.21.0 processor runtime. Upstream suggests Python 3.11; this environment difference is recorded, not hidden. GPU model serving is a separate environment.

`prepare.py` downloads the immutable snapshot, checks official hashes, and streams trajectories into an evaluator-only SQLite index rather than loading 1.2 GB of JSON into the worker. Screenshot download/extraction is required for an actual evaluation. Only text/metadata was downloaded during development.

## Reader endpoint

Use the exact multimodal Qwen3.5-9B checkpoint, not Qwen Plus/Max or another size. On a suitably provisioned Linux NVIDIA machine, the following is a starting deployment recipe, **not yet validated on a reader GPU**:

```bash
python3 -m venv qwen-reader
source qwen-reader/bin/activate
pip install "vllm==0.31.0"
vllm serve Qwen/Qwen3.5-9B \
  --revision c202236235762e1c871ad0ccb60c8ee5ba337b9a \
  --served-model-name Qwen/Qwen3.5-9B \
  --dtype bfloat16 --max-model-len 262144 --max-num-seqs 1 \
  --reasoning-parser qwen3 --host 127.0.0.1 --port 8023
```

For a remote host, use an SSH port forward: `ssh -N -L 8023:127.0.0.1:8023 USER@GPU_HOST`. The reader URL is `http://127.0.0.1:8023/v1`. A 48 GiB+ GPU and 64 GiB host RAM are planning recommendations; validate vision and the required context capacity before use. A 16 GiB RTX 4080 cannot hold approximately 18 GB of BF16 weights alone.

Hosted APIs also list the exact model, for example [OpenRouter](https://openrouter.ai/qwen/qwen3.5-9b/providers). Before declaring a comparable run, verify checkpoint revision, precision, image support and all generation parameters. Disable automatic provider failover and pin the provider. Merely matching the model name does not establish the weight revision. The OpenRouter transport pins one BF16 provider, disables fallback and requires support for every sampling parameter. It translates the official vLLM thinking switch to OpenRouter's reasoning-enabled switch. Hosted revision evidence is required before a comparable run.

Kaggle can run bounded reader batches, but its [documented session/storage limits](https://www.kaggle.com/docs/notebooks) make it unsuitable for this harness's full persistent memory preparation. Do not rent/hold a reader GPU throughout ingestion: prepare prompts first, then run the reader stage.

## Run, resume, and accounting

Copy `full-run.example.json` to a run-specific file. Fill in the endpoint, reader tariff and explicit dollar budget, verify deployment provenance, and set `full_run_authorized` only after reviewing the estimate. The example is deliberately blocked by default. Time is unlimited per the user; only US$1 of plumbing API spend has been explicitly approved so far.

For an unauthenticated localhost reader, set `READER_API_KEY=local-reader` in the calling shell; real hosted credentials should remain in environment variables. The blocked `openrouter-run.example.json` selects DeepInfra BF16 at the catalog tariff. Pass `--credential-file /mnt/d/Bitterbot/bitterbot-desktop/.env` to load the user's OpenRouter key without copying it. Endpoint metadata and authentication were checked without generation charges; provider weight revision and actual vision/thinking behavior remain unverified.

OPENAI_API_KEY can be loaded from the repository `.env`; its value never enters manifests.

```bash
"$B/.runtime/venv/bin/python" "$B/run.py" \
  --config "$B/.runtime/full-run.json" --upstream "$B/.runtime/upstream" \
  --data-root "$B/.runtime/data" --output "$B/.runtime/medium" \
  --stage prepare-prompts

# Start/validate the reader only after prompts have been prepared.
"$B/.runtime/venv/bin/python" "$B/run.py" \
  --config "$B/.runtime/full-run.json" --upstream "$B/.runtime/upstream" \
  --data-root "$B/.runtime/data" --output "$B/.runtime/medium" \
  --stage evaluate
```

Reissue the same command to resume. An explicit `--retry-errors` is required after inspecting recorded failures. It retries failed operations from the last committed state; it does not skip them. Do not edit a running configuration or source; identity drift is an error.

At each scheduled dream boundary, ingestion/consolidation first closes the production manager and saves a hashed pre-dream profile. Dreaming runs against a separate copy, and only a successful dream publishes the completed-history checkpoint. The next generation is built on a copy; an interrupted generation is never resumed as if complete. Two latest profile generations are retained; older checksum manifests remain. Every query restores a separate pre-query snapshot so retrieval mutation cannot leak into another question.

Atomic per-question prompt, reader and score checkpoints avoid rerunning completed stages. `accounting.sqlite` persists per-call model, request hash/ID, phase, usage, latency, price-derived cost and errors. It reserves a conservative charge before dispatch. Unknown charges remain reserved after an interruption. Concurrent controllers on one budget are rejected. `stages.jsonl` records actual ingestion, consolidation, dream, retrieval and evaluation latency. Tariffs are pinned list-price estimates, not billing-invoice reconciliation; cached-input discounts are conservatively ignored.

Full completion writes per-domain `per_question.jsonl`, `aggregated_metrics.json`, official combined metrics, an official validated operating point and LAFS submission package. Packaging is local only; nothing is submitted or published. No score is fabricated before completion.

## Validation

```bash
python3 -m unittest discover -s "$B" -p 'test_*.py' -v
node_modules/.bin/tsgo --project "$B/tsconfig.json" --pretty false
"$B/.runtime/venv/bin/python" -m unittest discover -s "$B/.runtime/upstream/tests" -v
```

`plumbing.py` accepts a real trajectory JSON and writes a no-score result. `checkpoint_plumbing.py` exercises the actual history builder and restart without an evaluator call. They share the cumulative US$1 accounting database under `.runtime/plumbing-budget`; do not erase it to reset an approval. Security tests use canaries, not fabricated benchmark examples.

Known limitations: the full reader/judge/packaging path has not been run end to end; full-scale runtime is an extrapolation; the OpenAI embedding model exposes an alias rather than an immutable published weight revision. The alias, endpoint, returned model and API request IDs are recorded, but strict weight-level reproduction requires an immutable embedding endpoint.

## Authorized US$100 capacity pilot

The capacity pilot has a separate cumulative US$100 ledger, including failed attempts, under .runtime/capacity-pilot. Run `python3 benchmarks/longmemeval-v2/capacity_pilot.py`; resume uses the same command and identity, with explicit `--retry-errors` after a recorded failure. Never reset its ledger to renew a spending authorization.

It deterministically selects the upper-median raw-byte ordered Medium history from each domain, without reading questions or gold labels. It alternates domains at 4, 16, 64, 256 and full-history milestones. Each four-trajectory group uses the ordinary consolidation/dream schedule and durable checkpoints. Partial milestones preserve full-history identity and do not introduce extra dreams. Retrieval probes use public trajectory goals and produce no official score.

Five-second process-tree RSS, available RAM and swap samples are recorded in resources.jsonl. Each checkpoint records indexed chunks, profile/disk bytes, cumulative spending and wall time in capacity.jsonl. Disk growth over 50 GiB or available RAM below 384 MiB stops at a checkpoint. These are checkpoint guards, not hard operating-system memory quotas. The broker prevents dispatch beyond the dollar cap. Errors stop the pilot without skipping data. status.json and report.md show its current or final state.

The pilot does not need a Qwen reader. It measures the dominant memory preparation costs before any full evaluation is authorized.

## Queued two-question accuracy diagnostic

The authorized follow-up is diagnostics/score_pilot.py, run with the pinned processor Python environment. It prepares official screenshots, waits for the capacity controller to release its budget lock, and uses the same .runtime/capacity-pilot/accounting.sqlite with the same US$100 cumulative cap. No independent spending allowance is created. It selects the lexicographically first question matching each already-selected complete ordered history, without consulting answer labels for selection.

Incomplete histories are reported as blocked, never scored as complete histories. Complete, hash-verified memory checkpoints are copied into isolated retrieval profiles. Only public query inputs reach Bitterbot; gold labels remain in evaluator files. The unchanged official prompt, context truncation, boxed answer parsing and scorer are used. Qwen is routed to DeepInfra BF16 without fallback, with official sampling settings and thinking enabled. Hosted weight revision is not attested, so outputs are explicitly diagnostic and are not an official overall benchmark score.

Outputs are under .runtime/capacity-pilot/accuracy: per-domain prompt, reader response and scored record; results.json/report.md; and status.json for preparation, waiting, scoring, completion or failure. Existing successful reader responses are reused after a scoring interruption. Recorded case failures require inspection and explicit handling before retry. No fake inputs or heuristic grades are substituted.

Screenshot archives are pinned to their Hugging Face LFS SHA-256 values at the existing immutable dataset revision. The official extraction tool uses copy mode, keeping retrieved screenshots inside the evaluator screenshot root. The first preparation attempt exposed that the release's checksums.sha256 covers core files and question images, not trajectory archives; its failure metadata was retained, and the corrected attempt separately verifies both archive hashes.

## Recovery revision (2026-10-09)

The user authorized bounded transient retries, pre-dream checkpoints and web-first processing after a 600-second dream-extraction timeout. The prior source/configuration and manifest are retained under .runtime/capacity-pilot/recovery-v1. recovery-amendment.json records the old/new manifest hashes and allowed changes; the ledger is never reset. Models, ordered histories, synthetic timestamps and dream schedule are unchanged. The added close/reopen around the pre-dream boundary is recorded as an orchestration change, not claimed to reproduce hosted model output bit for bit.

Only timeouts, connection resets and HTTP 429/500/502/503/504 retry, with at most three total attempts and bounded backoff. Every attempt has an independent durable charge/reservation and must pass the cumulative cap before dispatch. Permanent errors stop immediately. Successful production calls are not replayed automatically within a live operation.

Each pre-dream profile is immutable while dreams run on a copy. With --retry-errors, a failed dream restores that hash-verified state instead of ingesting again. The old enterprise attempt has no such pre-dream snapshot and cannot be promoted from its already-mutated failed profile; it must replay once.

The resumed pilot defaults to --web-through 32, stopping for a capacity review after web milestones 16 and 32. --web-through 479 proceeds through the complete web history, scores its selected question under the same budget, then processes/scores enterprise. No evaluation uses an incomplete history. The web accuracy step is no longer delayed until enterprise finishes.

## Prioritized Small-tier accuracy diagnostic — combined US$500 cap

The user increased the combined authorization to US$500 and prioritized correctness feedback. Medium is suspended at its recoverable state. Its ledger, profiles, failed attempts and source amendments remain intact; Small uses that same accounting.sqlite under the same exclusive spending lock.

Run diagnostics/small_pilot.py with the pinned processor Python environment. Its manifest pins the official Small haystack SHA-256, current code/configuration/dependencies and the deterministic selection. It selects five IDs per domain by SHA-256([1701,domain,question_id]), without using question answers, evidence labels or grading categories. The official release has exactly one shared ordered 100-trajectory history per domain, so 200 trajectory ingestions serve ten questions. Complete histories and the existing time/dream schedule are preserved. Web is prepared and its five questions scored before enterprise preparation.

Inputs were measured at 77,387,914 raw bytes for web and 93,649,143 for enterprise. This remains substantial memory preparation; no short accuracy ETA is promised from the Small name alone. The scorer publishes each completed question immediately, keeps unscored questions pending, and stops on errors. Resume requires unchanged identity and explicit --retry-errors after inspected failures.

Live status, question selection, checkpoints, resource measurements and per-question records are under .runtime/capacity-pilot/small-accuracy. report.md/results.json show the evolving diagnostic result. Each answer uses production Bitterbot retrieval plus the fixed Qwen reader and unchanged official scoring functions; labels never enter the isolated memory worker. The model provider's exact Qwen weight revision remains unverified, and ten sampled Small questions are not a full Small or Medium score.

Production pointer repair now uses a structured section-only merge for eviction-runaway failures. It targets 16 entries, enforces the unchanged 20-entry maximum, preserves each original search-query phrase, and preserves other sections byte-for-byte. Full validation still runs afterward. Details and source-revision provenance are recorded in REPORT.md and the pilot's pointer-repair-v2 amendment.
