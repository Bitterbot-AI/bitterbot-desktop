# PLAN-25: Self-Optimizing Harness (Runner-Level Self-Evolution)

**Goal:** PLAN-21 made skill _content_ self-optimizing. PLAN-25 makes the _harness itself_ self-optimizing. We extract the runner's hardcoded control surfaces — system-prompt assembly, tool exposure and per-tool specs, the tool-loop control policy, compaction/state-management parameters, and model+reasoning routing — into a single typed, versioned `HarnessPolicy` object that the embedded runner reads at session start. The agent then mines its own execution traces for _harness-level_ failure mechanisms, proposes minimal policy edits to fix them, and validates each edit by replaying a held-out set of real traces through the **existing PLAN-21 validation spine** (`experiment-sandbox` + `skill-execution-selection` held-out set + paired-bootstrap acceptance + faithfulness gate + longitudinal slow update). Accepted edits are promoted atomically with versioned rollback; the autonomous proposer is structurally forbidden from touching safety surfaces. This is the Self-Harness ([arXiv:2606.09498](https://arxiv.org/abs/2606.09498)) contribution — "harness = instructions + tools + memory/state management, not weights" — generalized onto our own runner, with APEX ([arXiv:2606.15363](https://arxiv.org/abs/2606.15363)) L1 (prompt/tool patching) and a _data-parameterized_ slice of L3 (loop topology) in scope.

**Date:** 2026-06-16 (drafted) / 2026-06-16 (Phases 0-6 LANDED)
**Status:** **LANDED, on by default.** The full self-evolving loop runs as the `harness_evolve` dream mode and is wired end-to-end. Kill switch: `agents.defaults.harnessEvolve.enabled` (default `true`).

### What landed (2026-06-16)

| Phase | Component                                                                                                                                           | Module                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0     | `HarnessPolicy` (compaction + prompt.fragments + tools.descriptionOverrides) + parse/merge/diff/serialize                                           | `agents/pi-embedded-runner/harness-policy.ts`                       |
| 0     | Versioned store (live/staging/archive vN, atomic promote, rollback, history) + mtime-cached active loader                                           | `agents/pi-embedded-runner/harness-policy-store.ts`                 |
| 0     | Runner wiring: compaction + prompt fragments + tool overrides read the active policy at session start (behavior-neutral until a policy is promoted) | `extensions.ts`, `run/attempt.ts`                                   |
| 1     | Weakness mining: exact-match failure-signature clusters from `intervention_records` + `skill_executions`                                            | `dream-modes/harness-evolve.weakness.ts`                            |
| 2     | Validation gate: global held-out set + reused `bootstrapPairedCI` (ci95Low>0) + minimality + faithfulness                                           | `dream-modes/harness-evolve.gate.ts`, `harness-evolve.selection.ts` |
| 3     | Proposer (K minimal candidates) + orchestrator (mine→propose→validate→promote, one per cycle)                                                       | `dream-modes/harness-evolve.propose.ts`, `harness-evolve.ts`        |
| 4     | Promote/rollback/canary (local only) + kill switch config flag                                                                                      | store + `config/*agent-defaults*`                                   |
| 5     | Faithfulness (protected fragments) + forbidden-surface exclusion (structural, via whitelist parse)                                                  | gate + `harness-policy.ts`                                          |
| 6     | Longitudinal slow update + auto-quarantine (rollback regressions)                                                                                   | `dream-modes/harness-evolve.slow-update.ts`                         |

Registered as dream mode `harness_evolve` (`dream-types.ts`, `dream-engine.ts`), wired in `manager.ts`. **40 new unit tests** (incl. end-to-end promote/inert/reject); full touched-area regression 452/452; tsc 0 errors; oxlint/oxfmt clean.

**Safety posture:** the judge is the SAME `ExperimentSandbox` the skill gate uses. Nothing promotes without `ci95Low>0` on held-out traces. Forbidden surfaces (bash allowlist, sandbox mode, safety interceptors, `acceptHighRiskDiff`, P2P) are not fields of `HarnessPolicy`. Promotions are local-only (never gossiped), reversible, and auto-rolled-back if they regress. The loop is **inert until there is enough held-out trace data** (`MIN_PAIRED_FOR_BOOTSTRAP`), so on-by-default is safe on fresh installs.

**Deferred (intentionally out of the autonomous loop):** model/reasoning routing and loop-topology toggles (Phase 0 slices 3+5 in the original sketch) — `params.model` is resolved upstream and loop control lives in pi-coding-agent; these remain config-driven. Compaction stays config-driven (numeric params are ill-suited to LLM-judge validation). Phase 7 (source-level topology rewrite) remains human-gated. The loop evolves the two text surfaces — prompt fragments and tool descriptions — which are the Self-Harness "instructions + tool specs" that the held-out judge can actually validate.

---

## Context

The pi-embedded-runner is no longer a third-party dependency we treat as read-only. It is a point-in-time clone that has already been sliced and modified into **our** runner (`src/agents/pi-embedded-runner/`). That changes the editable surface: in the PLAN-1..24 era the loop mechanics, compaction policy, and tool wiring were "library-owned, do not touch." They are now ours to expose and evolve. PLAN-25 is the plan that takes advantage of that.

Two SOTA threads define the target:

- **Self-Harness** ([arXiv:2606.09498](https://arxiv.org/abs/2606.09498), Shanghai AI Lab, 8 Jun 2026) defines the harness as the **non-parametric scaffolding** — "instructions, the available tools, memory and state-management mechanisms" — declared as a _configuration definition file, not model weights_. Its 3-stage loop: **Weakness Mining** (cluster failed traces by a verifier-grounded failure signature ⟨terminal cause, agent causal status, reusable mechanism⟩), **Harness Proposal** (K parallel minimal edits, each tied to one cluster, each carrying an audit record), **Proposal Validation** (re-evaluate on held-in + held-out, accept iff `Δ_in ≥ 0 ∧ Δ_ho ≥ 0 ∧ max > 0`). Reported: 40.5→61.9% (MiniMax M2.5), 42.9→57.1% (GLM-5), 23.8→38.1% (Qwen3.5-35B-A3B) on Terminal-Bench-2.0.
- **APEX** ([arXiv:2606.15363](https://arxiv.org/abs/2606.15363), 13 Jun 2026) generalizes to three co-evolving layers: L1 harness/prompt patching, L2 behavioral-principle distillation from _successful_ traces, L3 workflow-topology restructuring. It reports 0.300→0.570 (+90%) on a 15-node production agent at ~4 LLM calls overhead, and explicitly critiques single-axis Self-Harness for "leaving behavioural principles and workflow topology unchanged."

### What's already in the codebase

PLAN-25 is an extension of an existing spine, not a greenfield build. The hard parts — a reproducible held-out evaluation set, statistical acceptance, faithfulness gating, and longitudinal regression analysis — already exist because PLAN-21 built them for _skills_. PLAN-25 reuses them verbatim for the _harness_.

| Self-Harness / APEX need                                       | We already have                                                                                                                   | Path                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Held-out evaluation split (reproducible)                       | Deterministic-hash selection set over real `skill_executions`                                                                     | `src/memory/skill-execution-selection.ts`                                          |
| Validation gate (faithfulness + performance)                   | `ExperimentSandbox.evaluate()` with faithfulness gate + paired-bootstrap `ci95Low > 0`                                            | `src/memory/experiment-sandbox.ts`                                                 |
| Acceptance rule                                                | Paired-bootstrap CI (stronger than Self-Harness's `Δ > 0`)                                                                        | `src/memory/experiment-sandbox.ts`                                                 |
| Longitudinal slow update (regression classes, bio-conditioned) | Epoch-wise re-eval of prior versions                                                                                              | `src/memory/dream-slow-update.ts`                                                  |
| Weakness-mining substrate                                      | Append-only `intervention_records` (orig vs final action, outcome_tag, hormonal+GCCRF state, Ed25519-signed) + `skill_executions` | `src/agents/skills/intervention-store.ts`, `src/memory/skill-execution-tracker.ts` |
| Idle compute + scheduling                                      | Dream engine (gated modes) + cron engine, hormonally modulated                                                                    | `src/memory/dream-engine.ts`, `src/cron/engine.ts`                                 |
| Proposer (frozen model)                                        | Remote multi-provider via pi-ai; weights inherently frozen                                                                        | `src/agents/pi-embedded-runner/model.ts`                                           |
| Versioned archive + rollback                                   | `skills-archive/v<N>/` monotonic counter, atomic promote                                                                          | `src/agents/skills/skill-storage.ts`, `skill-promote.ts`                           |
| Pre-apply static security                                      | skill-scanner + injection-scanner                                                                                                 | `src/security/skill-scanner.ts`, `skill-injection-scanner.ts`                      |
| Sandboxed execution for replay                                 | Docker exec with rw/ro mounts, scope control                                                                                      | `src/agents/sandbox/docker.ts`                                                     |
| A config tree the runner already reads                         | `cfg.agents.defaults.*` (e.g. `.compaction.mode`, `.maxHistoryShare`) consumed at session build                                   | `src/agents/pi-embedded-runner/extensions.ts:71-95`                                |
| Single session-assembly choke point                            | `createAgentSession({...tools, systemPrompt, ...})` + system-prompt override + model resolve                                      | `attempt.ts:477-593`, `model.ts:43`                                                |

**What is genuinely new in PLAN-25 (and not in PLAN-21):** PLAN-21 optimizes the _body of a `SKILL.md`_. It never touches the runner. The runner's compaction thresholds, loop-stop policy, which tools are exposed and how they are described, the model fallback chain, and reasoning-effort routing are **frozen constants and ad-hoc config reads today** — invisible to the self-improvement loop. PLAN-25 makes them first-class evolvable surfaces while routing every edit through PLAN-21's already-trusted gate.

---

## Diagnosis: the harness is frozen while the skills evolve

Concrete losses, all attributable to runner surfaces that no feedback loop can currently reach:

1. **Compaction policy is one-size-fits-all.** `cfg.agents.defaults.compaction` (`extensions.ts:83-95`) is a static config blob. When compaction drops a fact the agent needed two turns later, nothing records "compaction caused this failure" and nothing adjusts `maxHistoryShare` or the preserve-recent count for the offending task shape.
2. **Tool specs are hand-written and never corrected.** Tool descriptions (`pi-tools.ts`, adapter at `pi-tool-definition-adapter.ts`) are authored once. When the model systematically picks `memory_search` where `knowledge_graph_search` was correct (the exact PLAN-20 failure mode), the _fix_ is a tool-description or routing edit — but there is no loop that proposes one.
3. **Loop control is hardcoded.** Max-iterations, retry-on-tool-error, and stop conditions live in `attempt.ts`. A task that reliably dies at the iteration cap, or one that wastes turns retrying a deterministically-failing tool, produces no signal that feeds back into the loop policy.
4. **Model + reasoning routing is static.** `resolveModel` + fallback chain (`model.ts:43-93`) and reasoning-effort selection are fixed. Refusals, truncations, and overspend on trivial tasks are recorded as failures but never attributed to a _routing_ fix.
5. **System-prompt assembly is monolithic.** `buildSystemPromptReport` / `createSystemPromptOverride` (`attempt.ts:477-499`) produce one prompt. There is no per-fragment provenance, so a regression cannot be traced to a prompt block and no block can be A/B-evolved.
6. **The harness surfaces have no archive and no rollback.** Skills have `skills-archive/v<N>/`. The harness has git history and nothing else; there is no in-product, agent-legible version of "the runner config that was live last Tuesday" to roll back to or to slow-update against.
7. **Weakness mining stops at the skill boundary.** `intervention_records` capture tool-call outcomes richly, but failure signatures are not computed at the _harness_ granularity (compaction-caused / tool-spec / loop-control / model-routing), so a proposer cannot know _which surface_ to edit.

Each is the same shape of loss PLAN-20/21 closed for skills: a well-defined corrective edit exists, but lives in nobody's loop. PLAN-25 closes them with one mechanism.

---

## What this unlocks

1. **The runner becomes a single evolvable artifact.** Every control surface that matters is read from one typed `HarnessPolicy`, versioned and rollback-able exactly like a skill.
2. **Harness-level weakness mining.** Failures are attributed to a _surface_ (compaction / tool-spec / loop / model / prompt-fragment), so proposals are targeted, not scattershot.
3. **Reuse, not reinvention, of the validation spine.** Policy edits are gated by the same held-out paired-bootstrap test and faithfulness gate that already gate skill edits — so PLAN-25 inherits PLAN-21's reproducibility and statistical rigor for free.
4. **APEX L1 + parameterized-L3 coverage.** Prompt/tool patching (L1) and _data-parameterized_ loop topology (L3 as policy toggles: reflection step on/off, retry policy, fan-out) without ever letting the autonomous loop rewrite control-flow source.
5. **A safety boundary the autonomous loop physically cannot cross.** Safety-critical surfaces (bash allowlist width, safety interceptors, sandbox mode, `acceptHighRiskDiff`) are excluded from the policy schema the proposer can edit; they remain human-only config.
6. **Publishable result distinct from PLAN-21.** "Frozen-weight agent self-optimizes its own runner harness, validated by paired-bootstrap on held-out real traces, conditioned on hormonal/GCCRF state" — a runner-level result no cited framework demonstrates (Self-Harness edits a config file by hand-rolled accept rule; APEX is a single production agent without held-out statistics).

---

## The keystone: `HarnessPolicy` as typed, versioned data

The entire plan rests on one refactor: convert the runner's scattered constants and ad-hoc config reads into a single typed object the runner consumes at session start. Defaults reproduce _exactly_ today's behavior, so Phase 0 ships behavior-neutral.

```typescript
// src/agents/pi-embedded-runner/harness-policy.ts  (Phase 0)
export interface HarnessPolicy {
  version: number; // monotonic, mirrors skills-archive convention
  provenance: "default" | "human" | "evolved";
  // --- APEX L1 surfaces ---
  prompt: {
    fragments: { id: string; text: string; order: number; evolvable: boolean }[];
  };
  tools: {
    exposed: string[]; // which tools are offered this session/context
    descriptionOverrides: Record<string, string>; // per-tool spec edits (Self-Harness "tool specs")
    routingHints: { whenShape: string; preferTool: string }[];
  };
  // --- memory / state management (Self-Harness "state-management mechanisms") ---
  compaction: {
    mode: "default" | "safeguard";
    maxHistoryShare: number;
    preserveRecentCount: number;
    triggerTokenRatio: number;
  };
  // --- model + reasoning routing ---
  model: {
    primary: string;
    fallbackChain: string[];
    reasoningEffortByShape: { whenShape: string; effort: "low" | "medium" | "high" }[];
  };
  // --- data-parameterized topology (APEX L3, as toggles only) ---
  loop: {
    maxIterations: number;
    retryOnToolError: boolean;
    reflectionStep: boolean; // optional self-check pass
  };
  // --- complements PLAN-20 ---
  interceptors: { enabled: Record<string, boolean>; priorityOverrides: Record<string, number> };
}

// Surfaces the autonomous proposer may NEVER touch live in a SEPARATE, human-only
// config object — they are not fields of HarnessPolicy, so a policy diff cannot reach them:
//   bash allowlist width, sandbox.mode, safety interceptors, acceptHighRiskDiff, P2P propagation.
```

The runner reads it at the existing choke point (`attempt.ts:477-593`): `prompt.fragments` feed `buildSystemPromptReport`; `tools.exposed`/`descriptionOverrides` feed the tool adapter before `createAgentSession`; `compaction` replaces the `cfg.agents.defaults.compaction` read; `model` feeds `resolveModel`; `loop` governs the iteration/stop logic. **One injection point, one object.**

---

## Phases

Every phase ships wired + active-by-default + tested + documented in the same commit (standing rule). "Active by default" with behavior-neutral defaults means the machinery is live but changes nothing until a policy actually evolves.

### Phase 0 — Extract `HarnessPolicy` (keystone, behavior-neutral)

The policy data model plus the compaction surface land together as the keystone. Each _remaining_ surface is wired in its own snapshot-tested slice, because the runner's hot path (`attempt.ts`) resolves them in ways that make a one-shot "behavior-neutral" claim untrustworthy without integration-level snapshots (see per-slice notes). This sequencing is deliberate: a subtle prompt-byte or loop-termination change in `attempt.ts` regresses every agent turn for every user, so these do not get batched into one push.

- **Slice 1 — compaction surface (LANDED).** `harness-policy.ts` (`HarnessPolicy` type, `defaultHarnessPolicy()`, `resolveHarnessPolicy(cfg)`); `extensions.ts` reads compaction through the policy. 5 unit tests, tsc clean. Behavior-neutral: `resolveHarnessPolicy(undefined).compaction === defaultHarnessPolicy().compaction`.
- **Slice 2 — tools surface (next).** Add `tools.exposed` + `descriptionOverrides`; wire via a pure `applyToolPolicy(tools, policy)` with identity default. _Risk note:_ `attempt.ts:335` builds `tools` but `createAgentSession` (`:588`) consumes `builtInTools`/`customTools` — trace which set is authoritative before wiring; snapshot the resulting tool list pre/post.
- **Slice 3 — model + reasoning routing.** Add `model.primary` / `fallbackChain` / `reasoningEffortByShape`. _Risk note:_ `params.model` is resolved **upstream** of `attempt.ts`; this slice touches the caller + `model.ts:43`, not just `attempt.ts`. Reasoning-effort routing is a new concept (none today) and must default to current `thinkingDefault` behavior.
- **Slice 4 — prompt fragments.** Refactor `buildSystemPromptReport` / `createSystemPromptOverride` (`attempt.ts:477-499`) to per-fragment provenance. _Risk note:_ must produce a **byte-identical** system prompt under default policy (cache-key sensitive); gate on a snapshot test of `systemPromptText`.
- **Slice 5 — loop topology toggles.** Add `loop.maxIterations` / `retryOnToolError` / `reflectionStep`. _Risk note:_ loop control lives **inside pi-coding-agent's `session.prompt`**, not in our file; this slice requires exposing those knobs at the library boundary (our clone) and is the closest to APEX L3. Defaults must reproduce current unbounded/library behavior exactly.
- **Policy archive** `harness-policy-archive/v<N>/policy.json` mirroring `skill-storage.ts` (lands with Phase 4 versioning; not needed for the behavior-neutral slices).
- **Exit (whole phase):** all five surfaces resolved from one `HarnessPolicy`; each slice's snapshot test proves defaults == prior behavior; full suite green.

### Phase 1 — Harness-level failure signatures (Weakness Mining)

- Add a signature stamper that, when an `intervention_record`/`skill_execution` is tagged a failure, classifies the _surface_: `compaction-caused | tool-spec | tool-routing | loop-control | model-routing | prompt-fragment`, persisted as the Self-Harness 3-tuple ⟨terminal cause, agent causal status, mechanism⟩.
- Deterministic exact-match clustering (no LLM fuzz), ranked by frequency × recency × reward deficit.
- Reuses `intervention-store.ts` (no new table; add columns/index).

### Phase 2 — Policy replay in the validation gate (reuse PLAN-21 spine)

- Extend `experiment-sandbox.ts` to accept a _policy diff_ candidate and evaluate it by replaying the `skill-execution-selection` held-out set under the candidate policy inside Docker (`REPLAY_LIMITS`: wall-clock SIGKILL, tool-call cap, cgroup memory, egress denied).
- Acceptance = existing paired-bootstrap `ci95Low > 0` on held-out, plus held-in improvement (Self-Harness `Δ_in ≥ 0 ∧ Δ_ho ≥ 0 ∧ max > 0` as the floor, bootstrap CI as the ceiling).
- **No new statistics code** — call the existing gate with a policy-typed candidate.

### Phase 3 — `harness_evolve` dream mode (Harness Proposal)

- New dream mode: for top-N failure clusters, prompt the (frozen) model for K minimal candidate policy diffs, each targeting one cluster, each with an audit record (`targetedMechanism`, `surfacesTouched`, `regressionRisk`, `expectedΔ`). Staged only.
- Inherits dream-engine idle gating + hormonal mode modulation; K and N capped (default K≤4, N≤3) for bounded token/wall-clock cost (APEX shows ~4 LLM calls suffices).
- Rejected diffs (with Δ + reason) fed back into the next proposer prompt (reuse PLAN-21's rejection-log-as-teacher pattern).

### Phase 4 — Versioning, promote, rollback, canary, kill switch

- Atomic policy promote (archive prev → write vN+1) reusing `skill-promote.ts` semantics; `rollbackPolicy(v)`.
- **Canary:** an evolved policy is local-node only. It **never** auto-propagates over the libp2p relay (cross-ref: P2P skill capability gating is currently wild-west / off — this boundary does real work).
- Single config flag disables `harness_evolve`. Curator auto-quarantines (rolls back) any promoted policy whose post-promotion success rate falls below baseline.

### Phase 5 — Harness-faithfulness gate + forbidden-capability enforcement

- A harness-faithfulness check before the performance gate: a policy diff is rejected if it removes a tool a passing trace depended on, disables a safety interceptor, or widens an excluded surface. (Mirrors PLAN-21/SkillReducer Gate 1.)
- Structural enforcement: forbidden surfaces are _not in the schema_ the proposer sees; defense-in-depth assertion rejects any diff that names them.

### Phase 6 — Longitudinal slow update over policy versions (bio-conditioned)

- Extend `dream-slow-update.ts` to re-run the held-out set against the current policy and the last K archived policy versions every epoch; classify per-trace outcomes into improvement / regression / persistent-failure / stable-success; cluster regressions by hormonal/GCCRF state captured on the original trajectory. Yields findings like "compaction policy v7 regresses under high cortisol."

### Phase 7 — (Stretch, gated) source-level topology evolution (true APEX L3)

- For structural changes the policy toggles cannot express (e.g. a genuinely new loop graph in `attempt.ts`), allow the proposer to emit a _source patch_ — but only into a **git worktree** (`isolation: worktree`), validated by the **full CI suite + held-out replay**, and **human-approved before merge**. Never autonomous-to-live. Explicitly out of scope for the autonomous v1; documented here so the boundary is intentional, not accidental.

---

## Security protocol

The invariant: **a self-generated policy diff is inert data until it passes the gate; it is never loaded live mid-validation.** Layered, each stage reject-only:

```
Policy diff (staged JSON)
  ├─ L0 STATIC    skill-scanner + injection-scanner over any text fields (prompt fragments, tool descriptions)
  ├─ L1 SCHEMA    policy validates against HarnessPolicy schema; forbidden surfaces absent
  ├─ L2 FAITHFUL  harness-faithfulness gate (no required tool/interceptor removed)        [Phase 5]
  ├─ L3 DYNAMIC   Docker replay of held-out set, REPLAY_LIMITS bound runaway/leak          [Phase 2]
  └─ L4 ACCEPT    paired-bootstrap ci95Low > 0  →  atomic promote, signed + journaled       [Phase 4]
```

Docker resource limits (timeout + cgroup memory + tool-call cap + egress-deny) are the real substitute for a Wasm sandbox we do not have: a corrupted policy that loops or leaks kills the _container_, not the desktop agent. Forbidden surfaces (bash allowlist, sandbox mode, safety interceptors, `acceptHighRiskDiff`, P2P propagation) are excluded at the schema level and re-asserted at apply time. Every promotion is Ed25519-signed (reuse intervention-store signing) and reversible.

---

## Risk register

| Risk                                     | Likelihood | Mitigation                                                                                                        |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Proxy verifier noise → false accepts     | High       | Paired-bootstrap CI (not point Δ); small K; curator post-promotion quarantine; canary local-only                  |
| Phase 0 refactor changes behavior subtly | Med        | Behavior-neutral defaults + byte-identical snapshot tests as Phase 0 exit gate                                    |
| Replay cost balloons                     | Med        | K≤4/N≤3 caps; idle-gated; abortable on user activity; bounded held-out set                                        |
| Proposer edits a safety surface          | Low        | Forbidden surfaces not in schema + apply-time assertion; defense in depth                                         |
| Local optimum / monoculture              | Med        | Pareto pool selection (reuse PLAN-21); rejected-edit feedback; periodic human review of archive                   |
| Overlap/confusion with PLAN-21           | —          | Strict surface split: PLAN-21 owns `SKILL.md` bodies, PLAN-25 owns runner policy; shared gate, disjoint artifacts |

---

## Out of scope (v1)

- Autonomous source-level rewrite of `attempt.ts` / control flow (Phase 7 is human-gated only).
- Auto-propagation of evolved policies over P2P (canary local-only).
- Editing safety surfaces (bash allowlist, sandbox mode, safety interceptors).
- Touching model weights (impossible — remote frozen model; this is the point).

---

## Sources

- Self-Harness — [arXiv:2606.09498](https://arxiv.org/abs/2606.09498) ([HTML](https://arxiv.org/html/2606.09498v1))
- APEX — [arXiv:2606.15363](https://arxiv.org/abs/2606.15363)
- Prior internal: PLAN-20 (executable interceptors), PLAN-21 (bio-conditioned validation gate + slow update) — the validation spine PLAN-25 reuses.
- Companion analysis: `self_harness_integration_study.md` (repo root).
