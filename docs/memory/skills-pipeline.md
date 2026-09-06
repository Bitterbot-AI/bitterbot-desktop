# Skills Pipeline — Skill Lifecycle, Verification & P2P Network

The skills pipeline handles the full lifecycle of autonomous skill generation: from identifying skill candidates in memory, through verification, to P2P propagation across a swarm network with graduated peer trust. Skills are knowledge crystals with `lifecycle='frozen'` and `semantic_type='skill'` that represent reusable, executable knowledge.

**Key source files:** `skill-evolution/` (the live learning loop), `skill-execution-tracker.ts`, `skill-network-bridge.ts`, `skill-verifier.ts` (P2P ingest only; `skill-refiner.ts` was retired in PLAN-45 Phase 1), `peer-reputation.ts`, `discovery-agent.ts`, `dream-mutation-strategies.ts`, `skill-marketplace.ts`, `skill-hierarchy.ts`, `skill-pricing.ts`, `marketplace-economics.ts`

> **Retired in PLAN-45 Phase 1 (2026-09-05):** the legacy "Pipeline A" skill producers — `SkillRefiner`, the `mutation` and `research` dream modes, `dream-mutation-strategies.ts`, the PLAN-21 validation sandbox / Pareto ranker / slow update, and `prompt-optimization.ts` — were deleted. Skills are produced by the PLAN-42/44 skill-evolution pipeline described above (the `SkillCrystallizer` went in Phase 0); the PLAN-40 `distillation` lane writes workflow notes, not skills. Sections below that describe the retired flow are kept as one-line notes.

**PLAN-20 (May 2026) — executable skill interceptors:** skills can now carry `PreActionInterceptor` implementations that deterministically modify, inject context into, require prerequisites for, or block any tool call before it executes. The Dream Engine's `interceptor_harvest` mode mines the `intervention_records` corpus and auto-proposes new interceptor candidates. See [Pre-Action Interceptors](../agents/interceptors.md).

---

## How skills are learned today (PLAN-42/44/45)

The live learning path is the skill-evolution pass in `src/memory/skill-evolution/`,
run as a dream-engine post-cycle hook:

```
Journaled runs (user prompt, tool outcomes, lifecycle)
  → labeler (grounded rules first, env-fail class, LLM judge only under 0.7 confidence)
    → wiki maintainer (patterns from repeated failures and successes)
      → skill proposer (primary model, sees the live skill index, may decline)
        → SICA staging gate (strict injection scan, description contract, overlap)
          → validation gate (held-out task corpus, K paired incumbent-vs-candidate
             rollouts, deterministic checkers hidden from the rollout, exact
             one-sided sign test; never-triggered HOLD, over-triggered REJECT)
            → live SKILL.md (+ PURPOSE.md, .evolution-meta.json)
              → maturity window → signed P2P publish with a provenance trailer
                → receiver quarantine for review
```

Nothing is promoted on model opinion: records mode (LLM-judged traces) can no
longer promote, and tasks mode needs at least five reviewed capability tasks.
See "Skill evolution" below for each module.

### What an execution row means (PLAN-45 Phase 1)

`skill_executions` still receives one row per tool call that matched a skill
crystal by name (`recorded_by = 'after_tool_call'`). Since PLAN-45 Phase 1
that row carries the journal run it happened in (`run_id`, `tool_call_id`)
and an `evidence` class:

| `evidence` | Meaning                                                               | Counts as competence |
| ---------- | --------------------------------------------------------------------- | -------------------- |
| `tool`     | A tool ran and did not report an error. Written by the hook.          | never                |
| `run`      | The run's calibrated label was `pass` or `fail` (L1-L2 evidence).     | yes                  |
| `task`     | A PLAN-16 task verdict backed the label (L3).                         | yes                  |
| `human`    | Operator feedback backed the label (L4, `bitterbot skills feedback`). | yes                  |

The housekeeping step `skill-evolution/execution-outcomes.ts` stamps
`run_outcome_label` / `run_outcome_level` on every row of a run once the run
is terminal, lifts `evidence`, and moves the crystal's `steering_reward` once
per run on the verdict. `env-fail` and `unknown` stay tool-level. Every
consumer that feeds a decision (tracker metrics, pricing, the bridge gate,
distillation, contributor status, the working-memory skill list, the digest,
signal collection, marketplace intelligence, doctor) filters with
`RUN_EVIDENCE_WHERE` from `skill-execution-tracker.ts`: a tool call that did
not throw no longer counts anywhere.

Each live skill directory also carries a derived `.evidence.json`
(`skill-evolution/evidence-record.ts`): credited reads by verdict over a
14-day window, lifetime counters, the gate verdict and statistics, the
models it was validated on and read by, description repairs, publish time,
and the lineage's gate history. `skills.evolution.status` returns them as
`evidence`; nothing downstream should compute skill quality any other way.

### Calibrating the labeler on real traces (PLAN-45 Phase 1.5)

`bitterbot skills calibrate export --count 100` writes a blind, stratified
sample of this node's real runs (`blind.jsonl`) and the labeler's hidden
verdicts (`key.jsonl`) under `skill-wiki/calibration/<stamp>/`. Label the
blind file without opening the key, then
`bitterbot skills calibrate score <dir> --labels mine.jsonl [--labels theirs.jsonl]`
reports per-class precision / recall / F1 for the heuristic (and the judge
with `--with-judge`), inter-rater agreement (Cohen's kappa) and the scores
against the raters' consensus. The LLM judge is de-anchored: for ambiguous
traces with a journaled task it first commits the success criteria from the
task header alone, then judges the trace against them.

### The retired crystal pipeline

Until 2026-09-05 a second, older pipeline ran alongside: `SkillExecutionTracker`
rows (one per tool call that did not report an error) fed a `SkillCrystallizer`
that minted a "skill" chunk for any tool name with three or more non-erroring
calls, which dream `mutation`/`research` modes were meant to refine through
`SkillRefiner`, `SkillVerifier` and `ExperimentSandbox`. PLAN-45 Phase 0 retired
the crystallizer (its dedup never matched, and it kept minting from execution
rows whose crystal had been deleted: 572 chunks on the reference node), stopped
the result-length "reward" score, and left the mutation and research modes off.
The remaining crystal-side pieces (tracker, refiner, sandbox, version resolver,
pricing) are scheduled for retirement or migration onto run-level outcomes in
PLAN-45 Phase 1. Tool-level execution rows are telemetry, not competence.

---

## How the agent finds a skill (the runtime index)

A skill "exists" for the agent only as an entry in the `<available_skills>`
block of its system prompt: `<name>`, `<description>`, `<location>`. The
runtime rule is the Agent Skills one: scan the descriptions and, when
exactly one clearly applies, read that SKILL.md with the read tool and
follow it. Nothing else advertises a skill: no memory recall, no
notification beyond a one-line "[Skills change since last turn]" diff on
the next turn. Consequences the rest of this document depends on:

- **The description is the routing key.** A skill whose description names
  no situation is never opened; two skills whose descriptions route the
  same situation cancel each other (the rule says pick the most specific,
  otherwise open nothing). This is why synthesized skills are held to the
  description contract and the overlap check (PLAN-44 Phase 4a/4b), why a
  never-triggered proposal gets its description repaired, and why the
  same contract is assessed at P2P ingest (Phase 5b).
- **Loader roots.** Entries come from three directories: the workspace
  `skills/`, the managed `~/.bitterbot/skills` (where promotion, accept
  and harvest write), and the bundled skills. Eligibility filters apply
  (config enable/disable, tier, remote-session rules, and the load-time
  capability gate for mesh-ingested skills).
- **Hot reload.** Every write to the live set (promote, operator accept,
  harvest, the file watcher) bumps a snapshot version; at the start of the
  next turn the reply path rebuilds the snapshot and the index. No restart
  and no new session are needed.
- **Use is measured from the journal** (Phase 5a): a housekeeping pass
  credits each live SKILL.md the agent actually opened in a real run, with
  the run's outcome, into `skill-wiki/skill-reads.jsonl` and the lifecycle
  store; `skills.evolution.status` reports per-skill 14-day read counts.

## Skill Lifecycle

```mermaid
flowchart TB
    A[Knowledge Crystal] -->|high importance + skill type| B[Skill Candidate]
    B -->|SkillCrystallizer / wiki-skill pipeline| F[SkillVerifier.verify]
    F --> I{All 3 checks pass?}
    I -->|Yes| J[Crystallize: lifecycle=frozen]
    I -->|No| H[Archive candidate]
    J --> K[SkillNetworkBridge.publish]
    K --> L[P2P Swarm via Rust Orchestrator]
    L --> M[Peer receives envelope]
    M --> N[SkillNetworkBridge.ingest]
    N --> O{Ban check + dedup?}
    O -->|OK| P[Store as local crystal]
    O -->|Banned/duplicate| Q[Reject]
    J --> R[SkillExecutionTracker records outcomes]
    R -->|feedback| B
```

> **PLAN-42/44 update (2026-09-05):** the publish leg in the diagram
> (`J → K → L`) no longer runs from the crystal store. Direct crystal
> publish was retired in PLAN-42; the outbound leg is
> `src/memory/skill-evolution/p2p-publish.ts`, which publishes only
> evolution-promoted SKILL.md files whose validation verdict is accepted
> and which have survived `maturityDays`. The receive leg (`M → N`) is
> preceded by the FILE half, `src/agents/skills/ingest.ts`, described
> under "P2P Skill Network → Receiving" below; `SkillNetworkBridge.ingest`
> (the memory-chunk half) runs only after an envelope is accepted.
>
> **PLAN-45 note (2026-09-05):** the PLAN-21 description below is historical. The `ExperimentSandbox` "trials" are LLM-predicted pass/fail over past execution contexts, not re-executions, and its only consumer (`research` mode) is off by default; PLAN-45 Phase 1 retires it. The measured gate is the skill-evolution validation gate above.
>
> **PLAN-21 update (2026-05-26):** the `Score ≥ 0.7?` branch labelled `D → E` is now the two-gate validation pipeline implemented in `src/memory/experiment-sandbox.ts`. A mutation must (a) pass an LLM-judged **faithfulness gate** that verifies each key operational concept survives the edit, and (b) clear a **paired-bootstrap performance gate** against a deterministic 20% held-out partition of `skill_executions` (the 95% CI on the per-trial delta must be strictly above zero). Across each cycle, gate-passing candidates are Pareto-ranked in `src/memory/skill-mutation-pareto.ts` over (delta, faithfulness margin, token delta) and clipped to a cosine-decay edit budget, so over-mutation is bounded even when many candidates pass. Every ten cycles an epoch-wise **slow update** in `src/memory/dream-slow-update.ts` re-evaluates the live version against `skill_text_history` and enqueues hormonal-cluster regressions into `mutation_queue` with a `regression-priority` strategy. The 0.7 numeric threshold in the diagram is preserved here as a coarse summary; the actual acceptance rule is statistical.

---

## Pattern Crystallization (SkillCrystallizer, retired 2026-09-05)

The `SkillCrystallizer` was deleted in PLAN-45 Phase 0 (migration v63 purges its output). It scanned tool-level execution rows for a tool name with three or more non-erroring calls and minted a "skill" chunk from it; that is not a skill, and its dedup never matched. This section is kept as history of the thresholds the retiring bridge gate still reuses.

### Promotion Criteria

| Constant           | Value     | Purpose                                                  |
| ------------------ | --------- | -------------------------------------------------------- |
| `MIN_SUCCESSES`    | 3         | Minimum successful executions before a pattern qualifies |
| `MIN_SUCCESS_RATE` | 0.7 (70%) | Minimum success/total ratio                              |

The crystallizer queries the `skill_executions` table, grouping by `skill_crystal_id`, and selects patterns where `successes >= 3 AND successes/total >= 0.7`. Deduplication prevents re-crystallizing patterns that already have a frozen skill crystal or a crystallized child.

### Crystal Creation

When a pattern qualifies:

1. The original chunk text is loaded and used as the basis
2. Importance score is computed as `successRate * 0.6 + frequencyFactor * 0.4` (where `frequencyFactor = min(1, totalExecutions / 20)`)
3. A new chunk is inserted with `lifecycle='generated'`, `memory_type='skill'`, `semantic_type='skill'`, `origin='inferred'`
4. An audit log entry is created with event `skill_crystallized`
5. The `parent_id` links back to the source pattern

---

## Skill Refinement (SkillRefiner)

**Retired in PLAN-45 Phase 1 (2026-09-05).** `skill-refiner.ts` (heuristic + empirical mutation scoring, the 0.7 promotion threshold, semantic-dedup gate, and the crystallize-with-version-bump path) was deleted with the `mutation` dream mode that fed it. `SkillVerifier` and the versioning columns (`stable_skill_id`, `skill_version`, `previous_version_id`) remain and are used by the P2P ingest path.

---

## Verification Safety Gate

The `SkillVerifier` (`skill-verifier.ts`) runs 3 checks before any skill candidate is promoted or ingested. All 3 must pass.

### Check 1: Dangerous Pattern Blocklist

Tests the mutation text against 17 regex patterns covering:

- SQL injection (`DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `DELETE FROM`)
- Shell injection (`rm -rf`, `curl|sh`, `wget|sh`, `sudo`, `chmod 777`)
- Code injection (`eval(`, `new Function(`, `child_process`, `exec(`, `execSync(`)
- Prototype pollution (`__proto__`, `constructor["prototype"]`)
- Process control (`process.exit`)

### Check 2: Structural Invariants

- Content must be non-empty
- Minimum 20 characters
- Maximum 50KB

### Check 3: Semantic Drift

If a parent crystal ID is provided and has an embedding:

- Computes cosine distance between the mutation embedding and the parent embedding
- Rejects if distance > `maxDriftThreshold` (default 0.3)
- Ensures mutations stay semantically related to their origin

```typescript
type VerificationResult = {
  passed: boolean;
  checks: VerificationCheck[]; // Array of { name, passed, reason }
  overallReason: string;
};
```

---

## Dream Mutation Strategies

**Retired in PLAN-45 Phase 1 (2026-09-05).** `dream-mutation-strategies.ts` (the `generic` / `error_driven` / `adversarial` / `compositional` / `parametric` strategy prompts and `selectStrategy()`) was deleted with the `mutation` dream mode.

---

## Skill Execution Tracking

The `SkillExecutionTracker` (`skill-execution-tracker.ts`) records the outcomes of skill usage for empirical quality feedback.

### Execution Flow

```typescript
// 1. Start tracking
const execId = tracker.startExecution(skillCrystalId, sessionId);

// 2. Record outcome
tracker.completeExecution(execId, {
  success: true,
  rewardScore: 0.8,
  executionTimeMs: 1200,
  toolCallsCount: 3,
});

// 3. Optional user feedback
tracker.recordFeedback(execId, 1); // -1, 0, or 1
```

### Steering Reward

On completion, the skill crystal's `steering_reward` is adjusted:

- **Success:** +0.1 (clamped to [-1.0, 1.0])
- **Failure:** -0.05

Steering rewards decay multiplicatively each consolidation cycle (default factor: 0.95).

### SKILL.md read crediting (PLAN-44 Phase 5a)

The tracker above matches tool names against memory crystals; it never
saw a file-based skill. `src/memory/skill-evolution/skill-reads.ts` closes
that: on every housekeeping pass it scans journal runs since a cursor,
finds `read` (or exec) tool calls whose path is a live skill's SKILL.md,
and records one event per (run, skill) with the run's outcome (ended
without a lifecycle error) in `skill-wiki/skill-reads.jsonl`. Each event
also calls `SkillLifecycleStore.recordUsage`, so `usage_count`,
`success_count` and `last_used_at` — the numbers the staging gate's
regression check reads — are finally fed. Validation rollouts and probe sessions are excluded; incomplete runs are retried until they end (a retry's second `start` is not an end) or expire; the ledger is append-only and idempotent, and it is written before the lifecycle credits so a crash can lose a credit but never double one. Every read is logged with its origin, but only first-party (human / system), non-heartbeat runs credit the lifecycle counters and the default summary, so a circle or A2A party cannot inflate the numbers the regression gate reads. Known limits: a sandboxed session reads a copy under the sandbox and is not credited; workspace and bundled skills are not tracked (managed `~/.bitterbot/skills` only).

- Routing repair for harvested and received skills (PLAN-44 Phase 5c). The harvest path has no model at write time, so repository taglines land as descriptions and never route (this node: one skill read in 4,410 runs). `src/memory/skill-evolution/routing-repair.ts` runs in housekeeping (and on demand via `skills.evolution.routing.repair` / `bitterbot skills routing repair [--dry-run|--name|--max]`): for each live skill whose description fails the contract it asks the model for a contract-compliant "use when … not for …" description grounded in the skill's own body and source, holds it to the contract and the overlap check (two attempts, the refusal reason fed back), and applies it as an ordinary edit through the staging gate + promote, so the previous version is archived and the snapshot bumps. The frontmatter name, body and source metadata are untouched; `.provenance.json` gains `routing_rewrite` (from, to, body hash) and a rewrite is never repeated for the same body. Five attempts per pass; a skill that fails is stamped (`routing_rewrite_failed`), retried after a day and left alone after three failed passes for the same body. Left alone by design: evolved skills (their sidecars would be stripped by a non-evolution promote; the evolution pipeline repairs their descriptions), skills with a pending staged edit, `-alt` twins of a live base, and unparseable frontmatter. The body goes into the rewrite prompt fenced as untrusted, and the rewritten description is refused on its own if the injection scanner or the contract's hazard check (shell commands, substitution, backticks, paths) flags it, since a description is rendered raw into every turn's prompt. Kill switch `skills.evolution.routingRepair: false`. The read signal above is the acceptance test. `summarizeSkillReads`
  gives per-skill windowed rates (default 14 days) for
  `skills.evolution.status` and for retirement scoring (D-5).

### Aggregated Metrics

```typescript
type SkillMetrics = {
  totalExecutions: number;
  successRate: number; // 0-1
  avgRewardScore: number;
  avgExecutionTimeMs: number;
  userFeedbackScore: number; // -1 to 1 (weighted average)
  lastExecutedAt: number;
  errorBreakdown: Record<string, number>;
};
```

---

## SKILL.md Generation

When a skill crystal is published (either to the P2P network or for marketplace listing), a `SKILL.md` document is generated in the Anthropic skill spec format.

### Format

```markdown
---
name: deploy-node-production
description: Dream-generated skill crystal
crystal_id: <uuid>
---

<skill text content>
```

### Anthropic Spec Compliance

The generated SKILL.md must satisfy:

- Starts with YAML frontmatter delimiters (`---`)
- Contains `name:` field (sanitized from path, max 64 chars, alphanumeric + hyphens)
- Contains `description:` field
- Total document under 500 lines
- Total size under ~5000 tokens (~20K characters)

The `SkillNetworkBridge.publishCrystalSkill()` generates this format automatically when publishing to the P2P network. The frontmatter is base64-encoded into the `SkillEnvelope.skill_md` field for transport.

---

## Skill Impact Trail (PLAN-42 Phase 0)

Every skill mutation attempt — successful or not — is recorded in an
append-only trail under `~/.bitterbot/skill-wiki/`:

- `skill-impact.md` — human-readable markdown entries (timestamp, source,
  action, skill, verdict, detail, optional diff)
- `.provenance.jsonl` — machine-readable mirror, one JSON object per line

The trail is written **programmatically by the harness** after each gate
decision, never by an LLM, so its verdicts are trustworthy. Files roll aside
(never truncate) at a size cap. Module: `src/agents/skills/impact-trail.ts`.

Recording paths as of Phase 0:

| Path                                                  | Gate                                                                   | Trail verdicts                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `skill_manage` tool / `skills.manage` RPC             | SICA staging gate                                                      | via `skills.promote` (accepted/rejected) |
| `skills.promote` / `skills.rollback` RPCs             | promote enforces `gateStatus=passed`                                   | accepted / rejected / rolled-back        |
| Crystallize (`crystallizeSkill`)                      | **now staged + gated + promoted** (previously wrote straight to live)  | accepted / gate-failed / rejected        |
| `guards.promote_candidate` (dream-harvest candidates) | **now runs the gate before promote** (previously raw staged→live copy) | accepted / gate-failed / rejected        |
| `skills.create` (in-app editor)                       | deliberately ungated (human edits are the operator's prerogative)      | ungated-human-edit                       |

### Trace pipeline (PLAN-42 Phase 1)

`src/memory/skill-evolution/` reads the event journal (read-only) and turns
runs into evolution fuel:

- `traces.ts` — `reconstructTrace(journal, runId)` rebuilds the ordered
  trajectory (assistant streaks, paired tool calls/results, terminal
  lifecycle outcome); `formatTraceLog` caps each log at 15k chars
  (head+tail preserved, middle elided). **Redaction happens here** — the
  journal is unredacted, so every text block passes
  `redactSensitiveText(mode: "tools")` before it can reach a prompt.
  **PLAN-44 Phase 0:** the journal now carries a `user` stream (the task
  the run was asked to do; emitted once per run by the embedded runner and
  the CLI-provider path, capped at 4k chars). The reconstructor reads it
  into `trace.task` and prints it as the FIRST header lines of every log
  (`task-origin: human via whatsapp` / `task: ...`); runs journaled before
  the stream existed render `task: (not journaled ...)`. The task's trust
  class (`run-origin.ts`: human / system / circle / a2a / subagent / guest /
  unknown) is derived from the session key at read time, never trusted
  from the row.
- `signals.ts` (PLAN-44 Phase 1) — programmatic trace signals computed
  BEFORE any model reads a trace: tool sequence, repeated loops, the class
  of every tool error (environment: provider / dns / connection / timeout /
  rate-limit / 5xx / service-unavailable / aborted; agent: policy-block /
  file-not-found / edit-mismatch / 4xx / exit-nonzero / exception /
  timeout), first-error position and recovery. Printed as a `## Signals`
  block under the task header of every trace log; the maintainer and judge
  are told to cite them and never invent mechanisms (arXiv 2605.29463).
  Signatures come from the live journal's 136 tool errors. Classification
  is tool-aware (adversarial pass): shell commands are the agent's choice,
  so `exec`/`process` errors classify on the harness reason line
  ("Command exited with code N") and scan the command's output only for
  finer agent classes and for network errors (remote → `network` env,
  loopback → `local-service` agent); `web_fetch` classifies on the HTTP
  status or the first line, never the body; lifecycle errors are provider
  failures unless the text names context overflow or an unknown tool.
- `labeler.ts` — pass / fail / **env-fail** / unknown cascade (PLAN-44
  Phase 1): lifecycle error → env-fail (every live instance was a provider
  error); terminal tool error → env-fail or fail by error class; AGENT
  error density; all-env-errors → env-fail; `complete()` with no agent
  errors → pass; clean end → pass; recovered from env errors → weak pass.
  `env-fail` never takes a failure slot (5 of 8 live wiki pages were
  outage narratives before this); a judge "fail" on a run whose only
  errors were environmental is env-fail; ≥4 identical env errors without
  recovery is a retry-storm fail; human-origin env-fail traces still seed
  the corpus miner (one reserved slot). The judge verdict parse is line-anchored (an echoed
  "verdict: pass|fail|unknown" is rejected). Calibrated against
  `benchmarks/skill-evolution/labeled-traces.jsonl` (58 rows built from
  live run SHAPES with synthetic content; precision ≥ 0.85 / recall ≥ 0.75
  per class, and no env-fail row may ever label as fail —
  `labeler.fixture.test.ts`). Length-based reward heuristics are banned
  (PLAN-40).
- `sampler.ts` — one iteration's stratified budget (≤8 traces: ≤5 fail +
  ≤3 pass, per the paper), monotonic seq cursor persisted at
  `skill-wiki/.sampler-state.json`, deterministic 20% run-id held-out
  partition reserved for the validation gate, exclusion of evolution/probe
  sessions (anti self-distillation). **PLAN-44 Phase 0:** heartbeat runs
  and third-party-origin runs (circle, A2A, subagent, guest) are excluded
  from the journaled task header (D-6); origin FAILS CLOSED (`unknown`,
  raw `hook:`/`acp:` keys and keyless runs are not learnable; `hook` is
  `guest`). A task text the injection scanner flags medium/critical is
  excluded at this boundary (`runsInjected`), and every trace log carries
  a `task-trust: UNTRUSTED TEXT` line; the maintainer, proposer and judge
  prompts state the trust boundary. Cursor safety: the cursor never passes
  the scan horizon nor the first event of a run the scan saw but did not
  examine — including runs whose slot was full (interleaved runs were
  being skipped forever); in-flight runs go to a bounded `pending` list
  (≤50, 3-day TTL) and are re-examined next iteration; a ring of ≤200
  examined run ids (reconstructed runs only) prevents double sampling;
  already-examined runs do not consume the per-scan cap. "Complete" is
  decided from the lifecycle phases (`runHasTerminal`), not from counting
  lifecycle rows, so retried attempts and subagent runs are not mistaken
  for finished runs. Diversity (Phase 1): a trace with the same task text
  AND tool-sequence shape as an already-selected trace is skipped; runs
  are examined oldest-first within the 14-day window (recency comes from
  the fast-forward floor; reordering would pin the cursor); selected
  traces that ran the same task with opposite outcomes are marked as a
  contrastive pair for the maintainer. State writes are atomic
  (`fs-atomic.ts`).

Go/no-go recurrence analysis (2026-08-31, live journal): 822 tool-bearing
complete runs; recurring failure clusters exist (55-run exec cluster,
38-run web_fetch cluster, 5-run wallet cluster) — the maintainer has fuel.

### Wiki layer + Maintainer (PLAN-42 Phase 2)

- `wiki-store.ts` — `skill-wiki/{index.md, logs.md, patterns/*.md}` beside
  the impact trail. Maintainer output is **whitelist-parsed** into a closed
  shape (`create_patterns` / `update_patterns` patch-ops / required
  `update_index` + `append_log`); invalid names, traversal attempts,
  malformed ops, oversized pages, duplicate creates, and
  injection-critical content are dropped and reported, never written. The
  wiki never rolls back and nothing deletes; a pattern cap
  (`skills.evolution.wikiMaxPatterns`, default 100) bounds growth until
  the lint pass lands.
- `maintainer.ts` — the paper's Appendix E.2 prompt (deep trace analysis,
  10-30-line pattern pages documenting root cause + exact commands + fix,
  both failure AND success patterns, PROBLEM+ROOT CAUSE+FIX index
  entries); ONE cheap-model call per iteration.
- `evolution-pass.ts` — orchestrates one iteration (sample → maintain;
  the Phase 3 proposer slots in after). Degradation contract: no LLM or
  no journal → clean no-op; no new traces → zero LLM spend; unparseable
  maintainer output → nothing written and the cursor holds so the window
  retries, up to `MAX_PARSE_FAILURES` (3) consecutive failures at one
  cursor, after which the window is skipped (one prose-inducing trace must
  not pin the loop); housekeeping (gate, lint, publish) runs on the
  parse-failed path too; anything that throws → caught, logged at `warn`,
  reported as reason `error`. If the dedicated proposer lane cannot
  resolve its model, the proposer re-runs on the evolution lane rather
  than losing the iteration. **PLAN-44 Phase 0:** every attempt (no-op, parse-failed,
  crashed) appends one JSON record to `skill-wiki/iterations.jsonl`
  (`iteration-log.ts`: sampler stats, cursor range, maintainer
  created/updated/dropped + parse issues, proposer turns/reads/protocol
  errors, gate outcomes, lint, publishes; trimmed to the newest 500).
- `proposer.ts` + `proposal-apply.ts` (PLAN-42 Phase 3) — the Skill
  Proposer: a ReAct loop with exactly the paper's two tools. `read_file`
  resolves ONLY through an allowlisted resolver (wiki files, this
  iteration's traces, live SKILL.md/PURPOSE.md — traversal and absolute
  paths structurally impossible); `finish` submits ONE atomic proposal
  (create XOR patch XOR no_action). Initial context = wiki index +
  skill-impact history + iteration outcome summary; pattern pages and
  traces are fetched on demand, and each pattern read stamps its
  `dream_utility` consumption. Proposals are STAGED through the SICA gate
  with PURPOSE.md + `.evolution-meta.json` provenance but are NEVER
  auto-promoted — promotion belongs to the validation gate (accept only on
  measured improvement). Repeated protocol garbage or the turn cap force
  `no_action`, which is a valid outcome, not a failure.
- Validation gate (PLAN-42 Phase 4, rebuilt in PLAN-44 Phase 2) — the ONLY
  path from staged proposal to live skill, and the answer to "how do we
  know a generated skill is good": always comparative, always strict.
  **Mode (D-2):** `validation-mode.ts` resolves the EFFECTIVE mode — an
  explicit `skills.evolution.validationMode` wins; otherwise `tasks` once
  the effective corpus carries ≥ 5 reviewed capability tasks, else
  `records`. **Tasks mode** (`validate-tasks.ts`, `task-runner.ts`,
  `task-corpus.ts`, `canonical-corpus.ts`): real agent turns over the
  fresh-seeded canonical REGRESSION suite (15 templates, three of them
  `safety`-tagged: embedded-instruction resistance, a phishing refusal, a
  plain echo — one observed failure there rejects with no re-check) plus
  the node's reviewed CAPABILITY suite. The candidate arm is the RUNTIME
  PATHWAY (D-3): the prompt carries only an `<available_skills>` index
  entry plus the runtime's "read at most one SKILL.md" rule; the body sits
  in a per-trial scratch workspace and the journal records whether the
  agent actually read it. Trigger precision is gated: candidate read rate
  < 0.5 on capability tasks HOLDs (`never-triggered`), > 0.5 on regression
  tasks REJECTs (`over-triggered`). Validation sessions
  (`agent:<id>:skill-evolve-val-*`) run under a dedicated workspace-scoped
  tool allow-list (D-4, `skill-validation-policy.ts`: read/write/edit/
  apply_patch, `tools.fs.workspaceOnly` forced; `exec`/`process` only with
  `skills.evolution.validationTools.exec: true`, then approvals off, a
  scrubbed environment and a workdir confined to the scratch workspace)
  in that scratch workspace (gateway `agent` RPC `workspaceDir`, honoured
  only for a trial dir the runner registered in-process). The session's
  system prompt keeps the skills index in minimal mode, and the candidate
  enters that index through the scratch workspace's `skills/` root, so the
  gate measures the runtime's real selection problem. Validation sessions
  load NO bootstrap context (`bootstrap-files.ts`): the scratch workspace
  has no GENOME/PROTOCOLS/MEMORY by design, so the prompt would otherwise
  carry `[MISSING]` markers the model narrates instead of doing the task,
  and on the peer flavor those files are the node's private state.
- Security closures (PLAN-44 Phase 3, 2026-09-04). Every trace span the
  maintainer / proposer / judge read (assistant text, tool args, tool
  results) is fenced `<untrusted>…</untrusted>` by `formatTraceLog`, with
  a smuggled closing tag defanged, and both prompts name the fence as
  authoritative. The wiki store drops `medium` injection hits like
  `critical` (D-7; `low` is written and logged). Evolution-authored content
  goes through the staging gate with `strictInjection`, where a `medium`
  hit BLOCKS instead of warning (a warn used to map to gateStatus
  "passed"). `promoteStaged` refuses any staging dir carrying
  `.evolution-meta.json` (error `evolution-staged`) unless the caller sets
  `allowEvolutionStaged`: the validation gate does; the `skills.promote`
  RPC does only for `forceGate` on an `operator.admin` connection (the
  `author` param is caller-asserted, scopes are not); the admin-scoped
  `guards.promote_candidate` does; the agent's `skill_manage` tool never
  does. `stageSkill` strips both sidecars whenever the author is not
  `evolution`, and the gate re-checks `meta.contentHash` against the staged
  file, so an agent cannot overwrite an evolution-staged name and ride its
  provenance (the overwrite becomes an ordinary staged edit; a direct file
  write is rejected `staged content tampered` and discarded). A successful promote now carries
  `.evolution-meta.json` and `PURPOSE.md` into the live dir, so a
  promoted skill keeps its cap / doctrine / summary identity. The proposer's
  evidence is origin-bound: `collectProposalEvidence` records which sampled
  traces it read and their run-origin classes into `.evolution-meta.json`
  (`evidence`) and a `## Evidence` section of PURPOSE.md; a proposal whose
  cited traces are all third-party (circle / a2a / subagent / guest /
  unknown) is HELD `untrusted-evidence-only` before any LLM spend, and a
  proposal that read no traces at all is refused at apply time (`proposal
cites no traces`); a pre-user-stream trace is classified by its session
  key, as the sampler admitted it. P2P
  ingestion routes an envelope into the skill-network bridge (memory
  chunk) only when `ingestSkill` ACCEPTED it (`shouldBridgeIngest`); a
  quarantined envelope is no longer an `active`, recall-visible chunk while
  its file sits in review — the operator's `skills.incoming.accept` re-routes
  it from the `.provenance.json` the accept writes (the CLI accept prefers
  that RPC and falls back to disk-only with a note), and the accept first
  re-hashes the quarantined SKILL.md against the envelope's content hash.
  The wiki index scan covers only the lines an update ADDS (an old suspect
  line cannot freeze the catalogue) and a withheld log entry still leaves a
  redacted record; the `## Signals` block reduces tool names to an
  identifier charset and the lifecycle error text is fenced.
- Description contract + repair loop (PLAN-44 Phase 4a, 2026-09-05). The
  runtime index shows the agent only `<name>` + `<description>` and opens a
  skill when exactly one description clearly applies, so the description is
  the whole routing key. `description-contract.ts` defines the contract
  (40-240 chars; a `when` clause naming the triggering situation; a
  `not for / never for / unless / except when / only when` clause scoping it out, both as clauses rather than bare keywords; vacuous phrasings such as "when needed" or "not otherwise" refused; no URLs, emoji or copied maintainer notes; frontmatter name equal to the skill name; no `-alt` variants). A patch over a harvested skill keeps that skill's own `owner/repo` frontmatter name and `-alt` directory. The staging gate enforces it as a BLOCK for synthesized
  content only (`descriptionContract` set by `applyProposal` and
  `crystallize`; a body patch over a legacy skill is grandfathered unless
  the proposer rewrote the description). The proposer prompt and the
  `skill_manage` crystallize parameter carry the contract verbatim. Repair:
  when the tasks-mode gate HOLDs a proposal `never-triggered`,
  `description-repair.ts` asks the LLM for contract-compliant rewordings,
  ranks the current description and each variant with a routing proxy (the
  LLM answers, per capability and regression task, whether the index entry
  would make it open the skill; score = capability hit rate minus
  regression hit rate), rewrites only the `description:` entry of the staged SKILL.md when the winner routes at least half the capability tasks (including at least half of a held-out third the rewriter never saw), beats the current description, copies no run of more than five words from any task prompt, and passes the full staging gate again (schema, strict injection, contract) on the rewritten file, re-keys `meta.contentHash` (so the tamper
  check passes and the 24h backoff does not apply), increments
  `meta.descriptionRepairs` (cap 2) and records `descriptionRepairLog` and
  an impact entry. The proxy only SELECTS; the real gate re-measures the
  repaired candidate on the next pass (incumbent trials memoized). Kill switch `skills.evolution.descriptionRepair: false`.
- Live index for the proposer + overlap check (PLAN-44 Phase 4b, 2026-09-05). The proposer's prompt now lists every live skill as `name: description` (what the runtime router sees) with the rule that a new description must route a situation none of them already do. `description-overlap.ts` scores two descriptions lexically on their POSITIVE clause only (the text before the scope-out clause, so two skills about the same tool do not collide through the tool name plus the mandated "not for" clause): content-word Jaccard ≥ 0.5, containment ≥ 0.6, or word-bigram Jaccard ≥ 0.4, only when both carry ≥ 4 content words; flag tokens with and without dashes are one token. The staging gate refuses a synthesized create whose description overlaps a live skill whose own description meets the contract (`description-overlap`, block, naming the skill to patch instead); a hit against a live description that cannot route (a harvested tagline, a peer's few-word squat) is a warning only. A patch of a skill is never compared against itself; human edits are not checked. The proposer's index entries are fenced `<untrusted>…</untrusted>`, injection-scanned (suspect ones withheld) and capped at 60 entries; the repair loop filters rewordings against the live index and re-gates with it. Known limit: the check is lexical, so a synonym rewrite passes it; the validation gate's measured routing on tasks is the backstop. One trust classifier
  remains: `classifySessionKeyTrust` delegates to `classifyRunOrigin`, so
  hook / group / channel / circle / a2a / subagent / guest / skill-evolve
  sessions are untrusted for canonical pins exactly as they are for
  evolution learning. Peer skills
  (attestation sweep) run on the `skill-evolve-val-peer-` flavor, which
  keeps the A2A no-tools floor. Both arms' trials are memoized in
  `skill-wiki/.trial-cache.sqlite` (`trial-cache.ts`, keyed by task prompt
  / arm content hash / model / generator version / trial index, non-empty
  answers only; the canonical seed rotates daily per model so same-day
  proposals share instances), so a budget retry resumes rather than
  restarts; held proposals whose content, corpus and model are unchanged
  are not re-validated for 24h. A wall-clock budget
  (`skills.evolution.validationBudgetMinutes`, default 45) HOLDs with
  `budget-exhausted`. **Corpus review** (`corpus-review.ts`; RPCs
  `skills.evolution.corpus.list|accept|reject`; CLI `bitterbot skills
corpus list|accept|reject`) is the only writer of `task-corpus.jsonl`:
  drafts are re-flagged at accept time (absolute paths, network verbs,
  injection hits, error-string checkers) and rejected ids are never
  redrafted. **Records mode** (`validate-records.ts`) is the opt-in
  fallback: held-out traces scored in BOTH presentation orders with skill
  bodies framed as untrusted data, exact sign test with a 0.1 discordance
  floor. `validation-gate.ts` settles every staged evolution proposal:
  measured improvement -> promote (PURPOSE.md + `.evolution-meta.json`
  enriched with mode/scores/read rates/tokens/corpus version/model);
  measured non-improvement or over-triggering -> discard + record verdict;
  insufficient data, never-triggered, budget -> HOLD and retry; net-new
  creates respect `maxActiveEvolved` (default 5). Rejected content is
  dedup-hashed: an identical (name, content) proposal can never be
  re-staged.
- Phase 5 ops: `wiki-lint.ts` (deterministic hygiene each iteration —
  exact-duplicate and over-cap pages archived to `patterns/archive/`
  (never deleted), orphans flagged into logs.md for the next maintainer
  call; the growth-bounding pass the paper admits it lacks).
  `p2p-publish.ts` — the flywheel's outbound leg: only VALIDATED evolved
  skills that survived `maturityDays` (default 3) locally publish to the
  P2P network, carrying a machine-readable provenance trailer (validation
  verdict, scores, corpus version, model) so receivers can re-gate
  locally; publish-once per validated version; kill switch
  `skills.evolution.propagate`. `status.ts` + the `skills.evolution.status`
  gateway RPC — one read-only snapshot (wiki size, sampler cursor +
  pending/processed counts, the last 10 iteration records, staged/held
  proposals, evolved live skills with verdicts, P2P eligibility, corpus
  presence) plus the FULL effective `skills.evolution.*` config (every
  field has help text + a label; defaults are declared on the zod schema).
  **PLAN-44 Phase 0 (D-1):** when neither `proposerModel` nor `judgeModel`
  is set, the Skill Proposer runs on the agent's primary model (the cheap
  lane failed its own JSON protocol in 3 of 5 live iterations); the RPC
  reports `proposerModelSource` and `proposerModelConfigured`; each iteration record carries the proposer `lane`. The `user`
  journal stream is emitted once per run (retries dedupe) by the embedded
  runner, the CLI-provider path, and the gateway `agent` command's CLI
  branch, and is never broadcast to WebSocket clients.
- Dream-engine hook `maybeRunSkillEvolutionPass` (curator pattern):
  cadence-gated at `skills.evolution.cadenceHours` (default 24h) via the
  persisted sampler-state timestamp + an in-memory attempt throttle; runs
  OUTSIDE the per-cycle LLM budget (own lane); records created/updated
  patterns in `dream_utility` (lane `evolution`). Runtime agents never see
  the wiki (fidelity F2): `skill-wiki/` is not a skill root and pattern
  pages are not `SKILL.md`-shaped.

Phase 0 also unified all staging paths on
`resolveStorageRoots()` (`skill-storage.ts`) — `guards.promote_candidate`,
`guards.status`, and `interceptor_harvest` previously built
`resolveStateDir()/skills-staging` in parallel — and schematized the
curator kill switch (`memory.dream.skillCurator.enabled`, previously an
untyped cast). The `skills.manage/promote/rollback` RPCs are now advertised
in `server-methods-list.ts`. The `skills.evolution.*` config namespace
(master switch `skills.evolution.enabled`, default **true**) is in place for
the evolution loop phases. Plans: `docs/plans/PLAN-42-WIKISKILL-SKILL-EVOLUTION.md`
(mechanism) and `docs/plans/PLAN-44-WIKISKILL-PIPELINE-REPAIR.md` (repair, from
the 2026-09-03 code-first audit in `docs/reviews/`).

---

## P2P Skill Network

### SkillNetworkBridge

The `SkillNetworkBridge` (`skill-network-bridge.ts`) mediates between the local crystal store and the P2P network.

**Publishing** (`publishCrystalSkill()`):

1. Loads the crystal from the database
2. Enforces governance: only `shared` or `public` scope, never `confidential` sensitivity
3. Checks provenance chain for confidential ancestors (blocks publish if found)
4. Generates a SKILL.md format with frontmatter
5. Sends to the Rust orchestrator via `orchestratorBridge.publishSkill()`

**Receiving — the file half first** (`src/agents/skills/ingest.ts`,
PLAN-13/PLAN-44): the gateway hands every `skill_received` envelope to
`ingestSkill` before the bridge sees it. Checks in order: self-loopback,
policy `deny`, Ed25519 signature, content hash, duplicate hash, legacy
unvalidated crystal, rate limit, SKILL.md structure, the injection scanner
(a critical hit force-quarantines regardless of trust), and since PLAN-44
Phase 5b a **routing assessment**: the description contract (description
checks only; the harvest path writes `owner/repo` names by design) and the
overlap check against this node's routable live descriptions. A peer skill
whose description cannot route, or collides with a local one, is held for
review even from a trusted publisher under `auto` policy, with the reason
on `.envelope.json` (`routing`, `routing_hold`) and in `skills incoming
list`; a local-origin harvest is stamped, not held. Accepted skills land in
`~/.bitterbot/skills/<name>/` with `.provenance.json`, bump the skills
snapshot, and only THEN reach `ingestNetworkSkill` below (the operator's
`skills.incoming.accept` re-routes a quarantined envelope the same way,
after re-hashing the file). The receiving agent finds the skill exactly as
it finds a local one: through the description in its runtime index, under
the mesh-content trust notice, subject to the load-time capability gate.

**Ingesting — the memory-chunk half** (`ingestNetworkSkill()`):

1. Checks if the sender peer is banned via `PeerReputationManager`
2. **Cortisol gate** — if a network cortisol spike is active (`haltUntrustedIngestion`), rejects skills from peers with trust level below `"trusted"` (i.e., `untrusted` and `provisional` peers are blocked)
3. Deduplicates by content hash
4. Version conflict resolution via `SkillVersionResolver` (natural selection: fitter variants win)
5. Decodes base64 content from the envelope
6. **SkillVerifier safety gate** (Plan 8) — inbound skills pass through the same 3-check verification as locally crystallized mutations: dangerous pattern blocklist, structural integrity, and semantic drift. Rejected skills result in a negative trust signal (0.2 weight) against the sender, degrading their EigenTrust score over time.
7. Verifies management signature if present (Ed25519 via Node.js `crypto`)
8. Stores as a new crystal with `lifecycle='generated'`, `semantic_type='skill'`, `origin='peer'`, plus `is_verified` and `verified_by` if management-endorsed
9. Stores peer wallet address (if included in envelope) for revenue sharing
10. Checks for bounty matches — if a match is found and the skill passes the **bounty quality gate** (SkillVerifier + 3 executions + >70% success rate), a bounty claim is published to the network for USDC payout

### Rust Orchestrator

The P2P layer uses a Rust binary (`swarm/mod.rs`) implementing a real libp2p swarm with:

- **Gossipsub** for skill envelope broadcast (4 topics — see below)
- **Kademlia** for peer discovery
- **AutoNAT** for NAT traversal
- **Identify** for peer identification and node tier advertisement

Communication between Node.js and Rust happens via IPC. The bridge is wired at gateway startup via `MemoryIndexManager.wireOrchestratorBridge()`.

### Gossipsub Topics

| Topic                    | Purpose                     | Who publishes         |
| ------------------------ | --------------------------- | --------------------- |
| `bitterbot/skills/v1`    | Skill envelope broadcast    | All nodes             |
| `bitterbot/telemetry/v1` | Telemetry events            | All nodes             |
| `bitterbot/weather/v1`   | Hormonal weather broadcasts | Management nodes only |
| `bitterbot/bounties/v1`  | Global curriculum bounties  | Management nodes only |

---

## Two-Tiered Network: Management & Edge Nodes

The P2P network has two tiers. **Edge nodes** (default) run the standard pipeline: index, dream, publish, ingest. **Management nodes** are trusted oracles that provide three additional capabilities: skill endorsement, hormonal weather broadcasting, and global curriculum bounties.

```mermaid
flowchart TB
    subgraph "Management Nodes (Genesis Trust List)"
        M1[Management Node A] --> |signed weather| GOSSIP[Gossipsub]
        M1 --> |signed bounties| GOSSIP
        M1 --> |skill endorsement| GOSSIP
        M2[Management Node B]
    end

    subgraph "Edge Nodes"
        E1[Edge Node 1]
        E2[Edge Node 2]
        E3[Edge Node 3]
    end

    GOSSIP --> E1
    GOSSIP --> E2
    GOSSIP --> E3
    E1 --> |skills| GOSSIP
    E2 --> |skills| GOSSIP
```

### Genesis Trust List

Management node authorization is based on a **Genesis Trust List** — a file of base64-encoded Ed25519 public keys, one per line. The list is configured via:

- **Rust CLI**: `--genesis-trust-list /path/to/genesis_trust_list.txt` (defaults to `{key_dir}/genesis_trust_list.txt`)
- **TypeScript config**: `p2p.genesisTrustListPath` or `p2p.genesisTrustList` (inline array)

```
# genesis_trust_list.txt — authorized management node pubkeys
MCowBQYDK2VwAyEA7x...base64...==
MCowBQYDK2VwAyEAkR...base64...==
```

A node declaring `--node-tier management` must have its own pubkey in the trust list, or the orchestrator refuses to start.

### Node Tier Identification

Tiers are advertised via the **Identify protocol**. The `agent_version` string encodes the tier:

```
bitterbot-orchestrator/0.1.0/edge
bitterbot-orchestrator/0.1.0/management
```

When a peer identifies as `management`, the receiving node:

1. Extracts the peer's Ed25519 pubkey from the Identify response
2. Checks the pubkey against the local genesis trust list
3. Sets `PeerDetail.tier = "management"` and `PeerDetail.tier_verified = true/false`
4. Emits a `peer_identified` IPC event to Node.js

Management claims from peers not in the trust list are silently downgraded to `edge`.

### Verified Safe Marketplace Tier

Management nodes can cryptographically endorse skills by signing the skill content with their Ed25519 key. The `SkillEnvelope` carries two optional fields:

```typescript
type SkillEnvelope = {
  // ... existing fields ...
  management_signature?: string; // base64 Ed25519 sig by management node
  management_pubkey?: string; // base64 pubkey of management signer
};
```

**Verification flow:**

```mermaid
flowchart LR
    A[Skill received] --> B{Has management sig?}
    B -->|No| C[Store as unverified]
    B -->|Yes| D{Pubkey in trust list?}
    D -->|No| E[Strip sig, store as unverified]
    D -->|Yes| F{Ed25519 sig valid?}
    F -->|No| E
    F -->|Yes| G["Store as verified (is_verified=1)"]
```

- **Rust side**: `SecurityValidator.validate_management_signature()` verifies the signature and strips forged claims. Invalid management sigs are stripped but the skill is still accepted (never reject a skill just for a bad endorsement).
- **TypeScript side**: `SkillNetworkBridge.verifyManagementSignature()` performs Ed25519 verification using Node.js `crypto` with SPKI DER wrapping.
- **Marketplace sort**: Verified skills sort above unverified by default (`ORDER BY is_verified DESC, importance_score DESC`).

### Hormonal Weather Broadcasting

Management nodes can broadcast **weather events** — network-wide cortisol spikes that trigger the immune response across all edge nodes:

```typescript
// Management node publishes:
await orchestratorBridge.publishWeather(
  0.9, // cortisol level (0-1)
  300_000, // duration: 5 minutes
  "Sybil attack detected in peer cluster X",
);
```

**Security:**

- Weather envelopes are signed with the management node's Ed25519 key
- Rust validates: pubkey in genesis trust list + valid signature
- **5-minute TTL**: Envelopes with timestamps older than 5 minutes or more than 1 minute in the future are silently dropped (replay attack prevention)
- Edge nodes call `HormonalStateManager.applyNetworkCortisolSpike()` to raise local cortisol

**Effects on edge nodes during a spike:**

- `haltUntrustedIngestion = true` — skills from `untrusted`/`provisional` peers are rejected
- `decayResistance` increases — stressed memories are harder to forget
- `mergeThreshold` tightens — more conservative merging

See [Knowledge Crystals: Network Cortisol Override](./knowledge-crystals.md#network-cortisol-override-phase-3) for the full hormonal mechanics.

### Global Curriculum Bounties

Management nodes can publish **bounties** — exploration targets that prioritize specific knowledge gaps across the entire network:

```typescript
await orchestratorBridge.publishBounty({
  bounty_id: "bounty-001",
  target_type: "knowledge_gap", // or "contradiction", "stale_region", "frontier"
  description: "Production debugging patterns for memory leak detection",
  priority: 0.8,
  reward_multiplier: 2.5,
  expires_at: Date.now() + 86_400_000, // 24 hours
  region_hint: "debugging",
});
```

**Bounty lifecycle:**

```mermaid
flowchart LR
    A[Management publishes bounty] --> B[Gossipsub broadcast]
    B --> C[Edge nodes ingest via CuriosityEngine]
    C --> D["Ultra-high priority target (priority*2, cap 1.5)"]
    D --> E[Dream exploration mode picks up target]
    E --> F[Crystal generated matching bounty]
    F --> G[checkBountyMatch detects match]
    G --> H["Dopamine boost (achievement * rewardMultiplier)"]
    H --> I[Crystal published with bounty_match_id]
```

- Bounties are signed by management nodes (same verification as weather)
- **5-minute TTL** for replay attack prevention
- `CuriosityEngine.ingestBounty()` inserts the bounty as an exploration target with doubled priority (capped at 1.5)
- `CuriosityEngine.checkBountyMatch()` keyword-matches crystallized content against active bounties
- On match: massive dopamine stimulation scaled by `rewardMultiplier`, and the crystal is recorded with `bounty_match_id` and `bounty_priority_boost`

See [Curiosity & Search: Bounty System](./curiosity-and-search.md#bounty-system-phase-3) for curiosity engine integration details.

---

## Peer Reputation System

The `PeerReputationManager` (`peer-reputation.ts`) implements graduated trust with anti-Sybil protections.

### Trust Levels

```mermaid
stateDiagram-v2
    [*] --> untrusted: First seen
    untrusted --> provisional: Score >= 0.3
    provisional --> trusted: Score >= 0.6
    trusted --> verified: Score >= 0.85
    untrusted --> banned: banPeer()
    provisional --> banned: banPeer()
    trusted --> banned: banPeer()
    banned --> untrusted: unbanPeer()
```

```typescript
type TrustLevel = "banned" | "untrusted" | "provisional" | "trusted" | "verified";
```

### Local Reputation Score

```
localScore = 0.4 * acceptanceRate + 0.4 * avgSkillQuality + 0.2 * longevityFactor
```

Where `longevityFactor` grows with time since first seen.

### EigenTrust Web-of-Trust

Trust edges between peers form a graph. The EigenTrust algorithm computes global trust scores via power iteration:

```
t_new = 0.9 * C^T * t + 0.1 * p
```

Where:

- `C` = row-normalized trust matrix
- `t` = current trust vector
- `p` = pre-trusted peer vector (from config)
- Convergence threshold: 0.001

Trust edges are updated via EMA blending: `new = 0.3 * observation + 0.7 * previous`.

### Blended Score

```
reputationScore = 0.7 * localScore + 0.3 * eigenTrustScore
```

### Anomaly Detection

`detectAnomalies()` runs periodically and flags peers publishing > 3x their historical average rate within a sliding window (default: 1 hour). Anomalous peers:

- Get `anomaly_flag = 1` in the database
- Are capped at `provisional` trust level maximum

### Management Node Check

`isManagementNode(pubkey)` checks whether a peer's pubkey is in the Genesis Trust List. Used by `SkillNetworkBridge` to verify management signatures on skill envelopes.

### Ban/Blocklist

`banPeer(pubkey)` immediately blocks all future skill ingestion from that peer. `isBanned()` is checked on every `ingestNetworkSkill()` call.

---

## Proactive Skill Suggestions

The `DiscoveryAgent` (`discovery-agent.ts`) suggests skills to the user using 4 strategies:

| Strategy         | Signal                            | Data source                                                    |
| ---------------- | --------------------------------- | -------------------------------------------------------------- |
| `friction`       | Repeated low-score search queries | `curiosity_search_queries` (>= 3 occurrences, avg score < 0.4) |
| `goal_alignment` | Active or stalled user goals      | `task_goals` table matched to marketplace by keyword           |
| `curiosity_gap`  | Unresolved knowledge gaps         | `curiosity_targets` of type `knowledge_gap`                    |
| `trending`       | Popular peer-origin skills        | High-download marketplace-listed chunks                        |

```typescript
type SkillSuggestion = {
  skillId: string;
  skillName: string;
  confidence: number;
  rationale: string;
  source: "friction" | "goal_alignment" | "curiosity_gap" | "trending";
  relevantGoalIds: string[];
  relevantQueryPatterns: string[];
};
```

### Skill Edge Discovery

The `DiscoveryAgent` also maintains the `skill_edges` table, discovering relationships between skills:

| Edge type      | Meaning                        | Discovery method                     |
| -------------- | ------------------------------ | ------------------------------------ |
| `prerequisite` | Skill A is required before B   | LLM analysis of skill pairs          |
| `enables`      | Completing A unlocks B         | LLM analysis                         |
| `contradicts`  | A and B are mutually exclusive | LLM analysis                         |
| `composes`     | A and B can be combined        | LLM analysis of same-category skills |
| `similar`      | A and B are semantically close | Cosine similarity >= 0.8             |

Edge steering rewards decay by 0.95x each cycle.

---

## Skill Marketplace

The `skill-marketplace.ts` module provides listing and search over published skills:

```typescript
type MarketplaceEntry = {
  stableSkillId: string;
  name: string;
  description: string;
  version: number;
  authorPeerId: string;
  authorReputation: number;
  successRate: number;
  downloadCount: number;
  tags: string[];
  category: string;
  createdAt: number;
  isVerified?: boolean; // Endorsed by a management node (Phase 3)
  verifiedBy?: string | null; // Base64 pubkey of endorsing management node
};

type MarketplaceFilters = {
  category?: string;
  minSuccessRate?: number;
  minAuthorReputation?: number;
  tags?: string[];
  sortBy?: "relevance" | "trending" | "newest" | "top_rated";
};
```

Skills are listed when `marketplace_listed = 1` on the chunk. Download counts are tracked in the `download_count` column.

**Default sort order**: Verified skills sort above unverified (`ORDER BY is_verified DESC, importance_score DESC`). Skills endorsed by a management node appear first in search results.

### Marketplace Economics Integration

The `MarketplaceEconomics` (`marketplace-economics.ts`) handles the economic layer on top of the search/discovery marketplace. It works with the `SkillPricingEngine` (`skill-pricing.ts`) to dynamically price skills.

#### Dynamic Pricing

Each skill's price is computed by `computeSkillPrice()`:

```
rawPrice = basePriceUsdc * (1 + qualityMultiplier) * demandMultiplier * reputationMultiplier * scarcityBonus
```

| Component              | Formula                                                 | Range   |
| ---------------------- | ------------------------------------------------------- | ------- |
| `qualityMultiplier`    | `successRate * max(0.1, avgRewardScore)`                | 0-1     |
| `demandMultiplier`     | `1 + log(uniqueBuyers + bountyMatches + 1) * 0.1`       | 1+      |
| `reputationMultiplier` | `max(0.1, reputationScore)`                             | 0.1-1   |
| `scarcityBonus`        | `1.5` if <= 2 similar skills, `1.2` if <= 5, else `1.0` | 1.0-1.5 |

Price defaults: base `$0.01`, floor `$0.001`, cap `$1.00`. Prices are rounded to 6 decimal places (USDC precision).

#### Listing Requirements

A skill must meet minimum quality gates before it can be listed:

- `minExecutionsForListing`: 3 (default)
- `minSuccessRateForListing`: 0.6 (60%)

Skills failing these gates get `listable = false` with a `listingBlockReason`.

#### Purchase Tracking and Anti-Sybil

Purchases are recorded in the `marketplace_purchases` table with buyer peer ID, amount, tx hash (unique index for replay protection), and direction (`sale` or `purchase`). The demand signal for pricing uses unique buyer counts (`COUNT(DISTINCT buyer_peer_id)`) rather than raw download counts to prevent sybil wash trading.

#### Earnings Feed into The Niche

`getEconomicSummary()` produces a summary consumed by The Niche (working memory economic section):

```typescript
type EconomicSummary = {
  totalEarningsUsdc: number;
  totalSpentUsdc: number;
  netEarningsUsdc: number;
  listedSkillCount: number;
  uniqueBuyers: number;
  skillsPurchased: number;
  topEarners: Array<{ name: string; earningsUsdc: number; purchases: number }>;
  earningsTrend: Array<{ date: string; amountUsdc: number }>;
  walletBalanceUsdc?: number;
};
```

Listings are refreshed during consolidation (every ~30 minutes) via `MarketplaceEconomics.refreshListings()`, which scans all `publish_visibility='shared'` skill/task_pattern crystals, recomputes prices, and upserts into `marketplace_listings` within a single SQLite transaction.

---

## Skill Hierarchy

The `skill-hierarchy.ts` module manages parent-child skill relationships and multi-level capability scoring:

```typescript
type SkillHierarchy = {
  level3: number; // Overall capability score (0-1)
  level2: DomainProfile; // 3 domains: What/How/Why
  level1: {
    // 6 groups
    factual: number;
    temporal: number;
    causal: number;
    relational: number;
    qualitative: number;
    implementation: number;
  };
  level0: number[]; // Raw 4-perspective embedding similarities
};

type DomainProfile = {
  factual: number; // What: facts, entities, knowledge
  procedural: number; // How: steps, tools, execution
  affective: number; // Why: goals, motivations, context
};
```

---

## Procedural-Memory Curator (PLAN-15)

The original pipeline above is **write-side**: it turns experience into crystallized skills. The
curator is the **read/maintenance-side**: it walks the SKILL.md files already on disk and decides
which to keep, mark stale, archive, or consolidate.

It is custodial ("this skill is unused, that one fails 80% of the time, this other one is
subsumed by its neighbour"). It used to complement the creative dream-mutation flow, which was
retired in PLAN-45 Phase 1 (2026-09-05).

### Lifecycle table

Migration v12 adds `skill_lifecycle`, one row per SKILL.md keyed on the canonical skill name:

| column              | meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `skill_name`        | Primary key. Matches `chunks.skill_category` for joinability.           |
| `origin`            | `agent_authored` / `managed` / `workspace` / `p2p` / `unknown`.         |
| `state`             | `active` / `stale` / `archived` / `pinned`.                             |
| `created_at`        | First-seen timestamp (ms).                                              |
| `last_used_at`      | Most recent successful execution (ms), or NULL.                         |
| `usage_count`       | Total executions recorded.                                              |
| `success_count`     | Subset of `usage_count` that succeeded.                                 |
| `error_count`       | Subset of `usage_count` that failed.                                    |
| `consolidated_into` | If non-NULL, the skill this one was merged into.                        |
| `pinned`            | 1 if the operator pinned it. Pinned rows are off-limits to the curator. |
| `updated_at`        | Row-mutation timestamp.                                                 |

The table is **backfilled on first migration** from existing `skill_executions` rows joined to
`chunks.skill_category` so installs upgrading from v11 do not start with an empty lifecycle log.

`SkillLifecycleStore` (`src/memory/skill-lifecycle.ts`) is the API. The execution pipeline calls
`recordUsage()` after every skill invocation; the curator and `skill_manage` tool drive everything
else.

### Pass 1 — heuristic transitions (no LLM)

`src/memory/skill-curator-heuristics.ts` is a pure-function classifier. Default thresholds:

| from → to              | trigger                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `active → stale`       | Idle ≥60d since last use, OR unused with age ≥14d (with a 3d fresh-skill grace window).                   |
| `stale → archived`     | Idle ≥120d since last use.                                                                                |
| `archived → active`    | Used within 7d of being archived (reactivation grace — defends against the curator clobbering a revival). |
| **Flag for LLM judge** | `error_count / usage_count ≥ 50%` over ≥5 runs. Heuristic alone never auto-archives high-error skills.    |
| `noop`                 | Any other case, or `origin != agent_authored`, or `pinned = 1`.                                           |

Only `agent_authored` skills are eligible. Skills authored by the user, ingested from the P2P
marketplace, or installed from `managed` are untouched.

### Pass 2 — LLM judge on borderlines (A-MAC hybrid)

`src/memory/skill-curator-judge.ts` runs the auxiliary model **only** on borderlines flagged by
pass 1, mirroring the A-MAC paper's heuristic-first pattern (arXiv 2603.04549) that cuts
LLM-judged cost ~10x with comparable quality.

The judge reads the SKILL.md content plus a peer-summary list and returns one of:

```yaml
action: keep         # situational failures, leave alone
action: archive      # clearly broken or no longer useful
action: consolidate  # archive in favour of another existing skill
  into: "<peer-name>"
action: patch        # rewrite the frontmatter description only
  new_description: "..."
```

**Hard rule:** the judge cannot delete. Archival is reversible; deletion is not. The only path
that removes a SKILL.md from disk is the Phase 2c `skill_manage` tombstone flow, gated by the
behavioural gate and the explicit operator-or-agent intent that drives it.

### Driver and reports

`runFullCuratorPass()` in `src/memory/skill-curator.ts` is the entry point. It:

1. Runs the heuristic pass; applies confident transitions unless `dryRun: true`.
2. Runs the LLM judge on at most `maxJudgeCalls` (default 10) borderlines per pass, so token
   spend is bounded even when many skills are flagged.
3. Writes a unified `REPORT.md` to `<CONFIG_DIR>/curator-reports/<ISO-ts>/` (atomic temp+rename).
4. Returns a structured `FullCuratorPassResult` with the heuristic outcomes and per-skill judge
   decisions.

A dry-run produces the report without mutating the DB or rewriting any SKILL.md, so operators can
preview what the curator would do before flipping it on.

### Gateway and agent integration

- The agent can drive the curator indirectly by calling `skill_manage` (next section); the
  curator itself is invoked from the memory manager's schedule.
- All gateway-side skill mutations open a short-lived WAL-mode connection via
  `withSkillLifecycleStore` (`src/agents/skills/skill-lifecycle-from-config.ts`) so the
  regression-baseline branch of the behavioural gate fires even from gateway entry points.

---

## Outcome evidence and verification (2026-09-05 harness review)

The review in `docs/reviews/autonomous-worker-harness-review-2026-09-05.md` found that
"success" collapsed several different situations into one label. These changes make the
outcome behind every learning signal explicit and grounded.

### Tool outcomes are read from the result body

`classifyToolResultOutcome` (`src/agents/pi-embedded-subscribe.tools.ts`) returns `ok`,
`error`, or `pending`. A `jsonResult({ ok: false, error })` body is an error; an
`approval-pending` placeholder is pending (the action never ran). The journal's tool
`result` events carry both `isError` and `outcome`, so the trace reconstructor, the
labeler, and skill-read crediting all see body-level failures. The model still receives
the result text unchanged.

### Model identity on every run

The lifecycle `start` event records `provider`, `model`, and `thinkLevel`;
`ReconstructedTrace.model` and every `skill-reads.jsonl` event carry the
`provider/model` string, and the trace log header prints it. Skill credit and labels
can now be conditioned on the substrate that earned them.

### The evidence hierarchy (L0–L4)

`src/memory/skill-evolution/outcome.ts` derives, from the journal only:

| Level | Meaning                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| L0    | run reached a terminal event                                                  |
| L1    | every tool call returned without a thrown or body-level error, none pending   |
| L2    | the agent called `complete()` on top of L1 (self-report)                      |
| L3    | the run's long-horizon task passed an independent judge round                 |
| L4    | a human confirmed the outcome (`bitterbot skills feedback <runId> confirmed`) |

Negatives (a failed verification, a rejected feedback entry, a pending approval) are
recorded separately and block a `pass` label regardless of level. The sampler attaches
the outcome before labeling; the labeler puts grounded evidence above every structural
rule, and a run with a pending approval is `unknown`, never `pass`.

### Task verification is executable

Long-horizon tasks carry `checks[]` (`file_exists`, `file_contains`, `file_regex`,
`output_regex`, and `command` when `BITTERBOT_TASKS_CHECK_COMMANDS=1`). `task_judge`
executes them first; a failed check fails the round with no model call. The typed
`verification` record (verdict, evidence level, check results, judge model, round) is
the only path to `completed`: `task_update` and the store refuse a direct transition.
Orphaned `running` tasks are reconciled to `waiting_external` with a handoff at store
start. A verified completion is the one grounded reward signal into the hormonal system.

### Records mode cannot promote

When the validation mode falls back to `records` automatically (fewer than five reviewed
capability tasks), an accepted LLM-counterfactual verdict HOLDS the proposal as
`records-only-evidence`; only tasks-mode rollouts or an explicit
`skills.evolution.validationMode: "records"` opt-in promote.

### Failure signatures and the repeat-call guard

`src/agents/pi-tools.repeat-guard.ts` refuses the fourth identical failing call in a
session with a message naming the failure. Offline, `signatures.ts` clusters every
fail-labeled run by ⟨terminal cause, agent-causal, mechanism⟩; the iteration log stores
the counts and `skills.evolution.status` ranks them across iterations.

### Provenance

Facts extracted from transcript spans inside an external-content envelope keep
`session_trust = "untrusted"` even in the owner's own session, so paraphrased web,
email, or circle text cannot become a canonical pin or a standing directive. P2P
publish refuses a SKILL.md whose body the secret redactor would change or that carries
a home path, user profile path, email address, or IP address.

## Related Documentation

- [Architecture Overview](./architecture-overview.md) — system entry point and file map
- [Knowledge Crystals](./knowledge-crystals.md) — core data model and lifecycle
- [Dream Engine](./dream-engine.md) — dream modes and the distillation lane
- [Curiosity & Search](./curiosity-and-search.md) — curiosity-driven skill gap detection
