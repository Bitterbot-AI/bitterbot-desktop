# Self-Harness Self-Evolution Loop: Bitterbot Integration Feasibility Study

**Author:** AI Architect (Claude, Opus 4.8) · **Date:** 2026-06-16 · **Status:** Feasibility study / RFC — **superseded for execution by [PLAN-25](docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md)**

> **Update (2026-06-16):** This study originally treated the pi runner as an off-limits third-party dependency and therefore deferred APEX L3 (loop/topology). That constraint was lifted: the pi-embedded-runner is a sliced-and-diced point-in-time clone we own outright. The adopted plan (**PLAN-25**) consequently treats the runner's own control surfaces as editable via a versioned `HarnessPolicy`, bringing a _data-parameterized_ slice of L3 into scope (loop toggles as policy, not source rewrites). The §6 recommendation to "scope to skills/interceptors only" is relaxed accordingly; the §5 security posture (data-not-code, Docker-bounded replay, forbidden-surface exclusion) carries over unchanged. Phase 0 slice 1 (compaction surface) has landed.

---

## 0. Reader's note: corrected premises

This study was commissioned with a brief that assumed a specific Bitterbot architecture (LangGraph orchestration, a Rust harness layer, a Wasm/WASI execution sandbox, and a local "frozen" model acting as proposer). **I verified each assumption against the codebase, and most do not hold.** Rather than write a fictional report on a stack that does not exist, I have re-grounded the entire study in what Bitterbot actually is. The headline finding is _more_ favorable than the brief implies: Bitterbot already ships ~70% of a Self-Harness loop under different names.

| Brief assumed                    | Reality in `/mnt/d/Bitterbot/bitterbot-desktop`                                                                                                                    | Evidence                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| LangGraph orchestration          | **No LangGraph.** Orchestration is TypeScript via `@mariozechner/pi-agent-core` + `pi-coding-agent` (v0.52.12).                                                    | `src/agents/pi-embedded-runner/run/attempt.ts`, `package.json`          |
| Rust harness layer               | **No Rust in the agent loop.** Rust exists only as a P2P/libp2p relay daemon in `orchestrator/`, unrelated to tool-calling.                                        | `orchestrator/` (Tokio/libp2p)                                          |
| Wasm/WASI sandbox                | **No WASI/wasmtime/wasmer.** `.wasm` files are vendored deps only (shiki, brotli, pdfjs). Code isolation is **Docker** + static scanners.                          | `src/agents/sandbox/docker.ts`, `src/security/skill-scanner.ts`         |
| Local "frozen" model as proposer | **Remote multi-provider** via `pi-ai` (Anthropic primary; OpenAI, Bedrock, Ollama-server, etc.). "Frozen" in the codebase refers to _skill crystals_, not weights. | `src/agents/pi-embedded-runner/model.ts`, `src/agents/system-prompt.ts` |

The "frozen model" framing is, however, _conceptually_ correct and worth keeping: in Self-Harness the model weights never change — only the non-parametric harness around them does. Bitterbot satisfies this trivially because the model is a remote API; we cannot touch its weights even if we wanted to. The proposer role is just "the same model, prompted to edit configuration."

Both cited papers are **real and were retrieved and read** for this study (not summarized from memory — both postdate my training cutoff):

- Zhang et al., _Self-Harness: Harnesses That Improve Themselves_, [arXiv:2606.09498](https://arxiv.org/abs/2606.09498) (Shanghai AI Lab, 8 Jun 2026).
- Chen, Lai, Hu, _APEX: Adaptive Principle EXtraction — A Three-Layer Self-Evolution Framework for Production AI Agents_, [arXiv:2606.15363](https://arxiv.org/abs/2606.15363) (13 Jun 2026).

---

## 1. Phase 1 — Literature review

### 1.1 Self-Harness (arXiv:2606.09498)

**Thesis.** An LLM agent improves its own _harness_ — the non-parametric scaffolding around frozen weights — with no human engineer and no stronger external model. The harness is explicitly defined as **"instructions, the available tools, memory and state-management mechanisms,"** declared as a **configuration definition file, not model weights.** This is the single most important sentence in the paper for us, because it draws the editable-surface boundary precisely where Bitterbot's skills/prompts/tool-specs already live.

**The 3-stage loop:**

1. **Weakness Mining.** Run the agent on a _held-in_ split, collect execution traces with verifier outcomes. Failures are clustered by a **verifier-grounded failure signature** = ⟨terminal verifier-level cause, causal status of agent behavior, abstract reusable mechanism⟩. Two failures group together _only_ if all three agree. Deterministic clustering (exact-match), which deliberately avoids LLM-fuzzy grouping that conflates symptoms with mechanisms.

2. **Harness Proposal.** A proposer emits **K candidate edits in parallel**. Each must (a) target one specific failure cluster, (b) modify **only the necessary surfaces** (minimality), (c) stay distinct from sibling proposals, and (d) carry an **audit record** naming the targeted mechanism and its regression risk. Editable surfaces: system prompts, instruction fields, tool specs, verification guidance, runtime control policies.

3. **Proposal Validation.** Re-evaluate each candidate on **both** held-in and held-out splits. **Acceptance rule:** `Δ_in ≥ 0 ∧ Δ_ho ≥ 0 ∧ max(Δ_in, Δ_ho) > 0`. A change is promoted only if it improves at least one split while degrading neither. This conservative two-split gate is the paper's anti-overfitting mechanism.

**Reported results (Terminal-Bench-2.0):** MiniMax M2.5 40.5→61.9%, GLM-5 42.9→57.1%, Qwen3.5-35B-A3B 23.8→38.1%.

### 1.2 APEX (arXiv:2606.15363)

APEX generalizes Self-Harness from one axis to three **co-evolving layers**:

- **L1 — Harness optimization:** prompt patching by failure mode (this _is_ Self-Harness).
- **L2 — Behavioral principles:** distills reusable principles from **successful** traces ("success-trace distillation") — the "Adaptive Principle Extraction" mechanism.
- **L3 — Workflow topology:** restructures the agent's computational graph via "structural fitness-based selection."

APEX's explicit critique of Self-Harness: it "optimises only one dimension — the prompt harness — leaving behavioural principles and workflow topology unchanged." APEX reports 0.300→0.570 health score (+90%) on a production "Joe" agent managing 15 nodes / 114 traces, at ~4 LLM calls (~270s) overhead.

**Why this ordering matters for us:** L1 and L2 map cleanly onto existing Bitterbot subsystems (skills + dream "research"/"mutation" modes). **L3 (topology rewrite) is the dangerous one** and is exactly the part the brief most wants ("rewrite its own loop control / orchestration"). I recommend treating L3 as out-of-scope for v1 (see §6 risk register).

---

## 2. Phase 2 — Internal codebase mapping

### 2.1 The harness (the editable surface)

The pi-framework owns the _mechanical_ loop (LLM call → parse tool calls → execute → feed back). Bitterbot does **not** hand-roll this, which means the loop-control machinery is **library code, not our editable surface.** What _is_ ours and editable maps almost 1:1 onto Self-Harness's definition:

| Self-Harness surface         | Bitterbot artifact                                                           | File                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Instructions / system prompt | System prompt assembly                                                       | `src/agents/system-prompt.ts`                                                  |
| Instructions (modular)       | **Skills** = `SKILL.md` (YAML frontmatter + body), live/staged/archived dirs | `src/agents/skills/*`, `src/agents/tools/skill-manage-tool.ts`                 |
| Tools available              | Tool registry + adapter                                                      | `src/agents/pi-tools.ts`, `src/agents/pi-tool-definition-adapter.ts`           |
| Runtime control policies     | **Interceptors** (block/modify/require_prereq/inject)                        | `src/agents/skills/interceptor*.ts`, `src/agents/pi-tools.before-tool-call.ts` |
| Memory / state mgmt          | Compaction + memory manager                                                  | `src/agents/compaction.ts`, `src/memory/manager.ts`                            |

**Conclusion:** the safest, highest-leverage editable surface is **skills + interceptors**, _not_ the pi loop. This is fortunate — it means self-evolution edits versioned `SKILL.md`/interceptor config, never the binary or the orchestration core. The brief's fear ("model rewriting its own loop control") is avoidable: we expose configuration, not control flow.

### 2.2 The "frozen model" / proposer

Model access is remote and provider-agnostic (`resolveModel()` in `src/agents/pi-embedded-runner/model.ts`; discovery in `pi-model-discovery.ts`; Anthropic payload interception in `anthropic-payload-log.ts`). The proposer is just _a prompted invocation of the same model_ against trace evidence — no new infra needed. Weights are inherently frozen (we don't host them).

### 2.3 Execution sandbox (reality: Docker + scanners, not Wasm)

Three real isolation layers exist:

1. **Docker** for arbitrary shell/code (`src/agents/sandbox/docker.ts`, `context.ts`) with rw/ro mounts and shared/per-agent scope.
2. **Static skill scanners** before load: `src/security/skill-scanner.ts` (dangerous-exec, `eval`/`new Function`, crypto-mining, exfiltration, env-harvesting) and `skill-injection-scanner.ts` (prompt-injection patterns).
3. **Bash sanitization**: env-var blocklist + command allowlist (`bash-tools.exec-runtime.ts`, `bash-tools.command-sanitize.ts`).

Plugins/skills load via `jiti` in-process (`src/plugins/loader.ts`) — **no VM/Wasm isolation at the JS level.** This is the real security gap for self-evolution (see §4).

### 2.4 Offline evaluation / weakness-mining substrate (already exists)

This is where Bitterbot is unexpectedly far ahead. The data and idle-compute substrate Self-Harness needs is **already collected**:

- **Dream engine** — idle-time state machine with a `research` mode (empirical prompt optimization from execution traces), `mutation` mode (LLM skill variation + Pareto select), and **`interceptor_harvest` mode (PLAN-20) that already mines `intervention_records` for competence gaps and proposes new interceptors.** `src/memory/dream-engine.ts`.
- **Intervention records** (append-only, v14): per tool call — original vs final action, outcome_tag backfill (`downstream-failure`, `user-overrode-block`, …), latencies, signatures. `src/agents/skills/intervention-store.ts`.
- **Skill execution tracker** — per skill: success, reward_score, error_type, exec time, tool_calls_count, user_feedback; `getSkillMetrics()` yields empirical success_rate. `src/memory/skill-execution-tracker.ts`, wired via `execution-tracking-hook.ts`.
- **Dream telemetry** — closed-loop cycle metrics. `src/memory/dream-schema.ts`.
- **Skill gate** — staging gatekeeper with **schema gate + injection gate + a behavioral regression gate** that already rejects ">50% diff on a skill with >0.8 success rate and >5 runs" unless explicitly overridden. `src/agents/skills/skill-gate.ts`. **This is Self-Harness's validation acceptance criterion in embryonic form.**
- **Curator** — heuristic-first + LLM-judge lifecycle manager run each dream cycle. `src/memory/skill-curator*.ts`.
- **Cron engine** — background job scheduler, hormonally modulated concurrency. `src/cron/engine.ts`, `src/tasks/biology.ts`.

---

## 3. Phase 3.1 — Feasibility & mapping

**Verdict: FEASIBLE, and substantially de-risked, if scoped to L1+L2 over skills/interceptors.** The mapping is direct enough that this is more an _integration and formalization_ project than a greenfield build.

```
Self-Harness stage      →  Bitterbot component (today)                     →  Gap to close
─────────────────────────────────────────────────────────────────────────────────────────
Weakness Mining         →  intervention_records + skill_executions         →  add verifier-grounded
                           + dream "research" mode                            failure-signature clustering
Harness Proposal        →  skill_manage tool (create/edit/patch) +         →  add K-parallel proposer with
                           dream "mutation"/"interceptor_harvest"             minimality + audit records
Proposal Validation     →  skill-gate (schema+injection+regression)        →  add 2-split (held-in/held-out)
                           + skill_promote                                    benchmark replay + Δ acceptance
Idle compute            →  dream engine + cron engine                       →  none (reuse)
Frozen model / proposer →  pi-ai remote model                              →  none (reuse)
APEX L2 (principles)    →  dream "compression"/"research" (success traces) →  formalize as epistemic directives
APEX L3 (topology)      →  (none — pi owns the loop)                       →  OUT OF SCOPE v1
```

**Editable surfaces, ranked by safety:**

1. ✅ **Skills (`SKILL.md` body/frontmatter)** — versioned, gated, archived, rollback-able. _Start here._
2. ✅ **Interceptors (config)** — declarative block/modify/inject; already auto-disable after 3 throws.
3. ⚠️ **System-prompt assembly** — global blast radius; gate hard, canary only.
4. ⛔ **Tool definitions / pi loop / compaction** — library-owned or core; do **not** expose to autonomous edits in v1.

---

## 4. Phase 3.2 — The self-optimization loop inside the desktop client

The loop runs as a **new dream mode (`harness_evolve`)** so it inherits idle-gating, hormonal modulation, and the existing telemetry plumbing rather than introducing a parallel scheduler.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  DREAM CYCLE (idle, gated by computeDreamReadiness + hormonal state)          │
│                                                                              │
│  ── Stage 1: WEAKNESS MINING ──────────────────────────────────────────     │
│  read intervention_records + skill_executions since last cycle               │
│    → build failure-signature ⟨verifier_cause, agent_causal_status, mechanism⟩│
│    → deterministic exact-match cluster                                        │
│    → rank clusters by frequency × recency × |reward deficit|                  │
│                                                                              │
│  ── Stage 2: HARNESS PROPOSAL ─────────────────────────────────────────      │
│  for top-N clusters: prompt model for K minimal candidate edits              │
│    → each edit = skill_manage{create|edit|patch} or interceptor spec         │
│    → each carries audit record {targeted_mechanism, surfaces_touched,        │
│        regression_risk, expected_Δ}                                          │
│    → write to staged/ (NEVER live)                                            │
│                                                                              │
│  ── Stage 3: PROPOSAL VALIDATION ──────────────────────────────────────      │
│  for each staged candidate (in Docker, on idle compute):                     │
│    (a) skill-gate: schema + injection + diff-regression  (existing)          │
│    (b) trace-replay regression: replay held-in failure cluster + held-out    │
│        control set; compute Δ_in, Δ_ho via verifier                          │
│    (c) accept iff  Δ_in ≥ 0 ∧ Δ_ho ≥ 0 ∧ max > 0   (Self-Harness rule)       │
│    → on accept: skill_promote (atomic rename, archive prev, lifecycle++)     │
│    → on reject: keep in archived/ with audit + Δ for future mining           │
│    → emit dream_telemetry rows (DQS, Δ_in, Δ_ho, accept/reject)              │
└────────────────────────────────────────────────────────────────────────────┘
```

**Logging failed traces during active use:** already happens. `execution-tracking-hook.ts` fires after every tool call; `before-tool-call` records interventions. The only addition is a **failure-signature stamper**: when `outcome_tag` is backfilled to a failure, compute and persist the 3-tuple signature on the record so Stage 1 is a cheap indexed read, not a re-derivation.

**Running regression in the background without UX impact:** piggyback on the dream engine's existing idle gate (`computeDreamReadiness`) and the cron engine's hormonal concurrency policy (`computeTaskConcurrency`) — validation replays run as isolated Docker jobs at the same priority tier as other dream work, abortable the instant the user becomes active. Cap candidates per cycle (e.g. K≤4, N≤3) so wall-clock and token cost stay bounded (APEX shows ~4 LLM calls is enough to be useful).

**The eval set problem (the real bottleneck).** Self-Harness assumes a held-in/held-out task split with an automatic verifier. Bitterbot has no general task verifier for free-form desktop use. Options, in order of pragmatism:

1. **Replay-with-proxy-verifier (recommended v1):** the "held-in" set is the mined failure cluster; the "verifier" is the same outcome signal we already record (`outcome_tag` ∈ failure/success, reward*score, user-override). "Held-out" is a rolling sample of \_recently successful* traces — the control that a change must not break. Δ is measured as change in proxy outcome on replay.
2. **Domain benchmarks where verifiers exist:** the `benchmarks/` tree (longmemeval, arc-agi-3) already has scored runners. Use these as a _hard_ held-out gate for any change touching memory/recall skills.
3. **LLM-judge verifier** for traces with no programmatic check — reuse the curator judge (`skill-curator-judge.ts`).

---

## 5. Phase 3.3 — Security & Wasm sandboxing protocol

**Correction first:** there is no Wasm/WASI boundary to lean on. The brief's premise that we'd "use Wasm to catch infinite loops/memory leaks before they corrupt the agent" does not match the codebase. We have **three** real defenses, and I propose a layered protocol on top of them. (Adopting a true Wasm/WASI sandbox is a possible _future_ hardening, costed in §6, but it is not required for v1 and should not block the project.)

The non-negotiable invariant: **a self-generated proposal is data until it passes the gate; it is never loaded as live code mid-validation.**

**Layered validation protocol (each stage can only reject, never auto-promote):**

```
Proposal (staged/, inert text)
  │
  ├─ L0 STATIC   skill-scanner + injection-scanner  (existing)
  │              reject on: eval/new Function, child_process exec, exfil, env-harvest,
  │              injected directives. CRITICAL = hard block.
  │
  ├─ L1 SCHEMA   skill-gate schema gate (existing) — frontmatter parses, required fields.
  │
  ├─ L2 DIFF     skill-gate regression gate (existing) — block silent-gutting (>50% diff
  │              on high-success skill) unless acceptHighRiskDiff (NEVER set autonomously).
  │
  ├─ L3 DYNAMIC  trace-replay INSIDE DOCKER with hard caps:
  │              - wall-clock timeout per replay (SIGKILL)
  │              - max tool calls per replay (loop-bomb guard)
  │              - memory cgroup limit on the container (OOM-kill guard)
  │              - network egress denied by default during replay
  │              - read-only mount of workspace; scratch is ephemeral
  │              → this is where an infinite-loop / memory-leak proposal dies:
  │                the CONTAINER is killed, the host agent is untouched.
  │
  └─ L4 ACCEPT   Δ_in ≥ 0 ∧ Δ_ho ≥ 0 ∧ max > 0  →  skill_promote (atomic, archived rollback)
```

The thing the brief wanted Wasm for — **bounding a runaway loop/leak from a corrupted proposal** — is delivered by **Docker resource limits (timeout + cgroup memory + tool-call cap)** in L3. Docker is a coarser but real isolation boundary already wired into the codebase. The container, not the desktop agent, absorbs the blast.

**Additional hard rules:**

- `acceptHighRiskDiff` and any "force-live" path are **forbidden to the autonomous proposer** (enforce by not passing the capability into the dream-mode context).
- Every promotion is **signed + journaled** (intervention-store already does ed25519 signing) and **reversible** (archived/ + `rollbackStaged`).
- **Canary before fleet:** a promoted change is live on the local node only. P2P skill propagation (the libp2p relay) must require a _separate_ human or quorum gate — never auto-gossip a self-generated skill. (Cross-reference the wild-west capability-gating note: P2P skill capability enforcement is currently OFF, so this canary boundary is doing real work.)
- **Kill switch:** a single config flag disables `harness_evolve` mode; the curator can quarantine any skill whose post-promotion success rate drops below baseline (reuse the existing lifecycle `archived` transition).

---

## 6. Phase 3.4 — Proof of concept: the Proposal-Validation node

**Language note:** the PoC is **TypeScript**, not Rust/LangGraph, because that is what the harness is written in (`src/agents/skills/`). A Rust/LangGraph PoC would be unrunnable in this codebase. The node is designed to drop in beside the existing `skill-gate.ts` and reuse `replayTrace` semantics from the trace store.

```typescript
// src/agents/skills/harness-validate.ts  (PoC — Proposal Validation node)
// Implements the Self-Harness acceptance rule on top of the existing skill-gate.
import { runSkillGate } from "./skill-gate"; // existing: schema+injection+diff
import { promoteStaged } from "./skill-promote"; // existing: atomic promote+archive
import type { InterventionStore } from "./intervention-store";
import type { SkillExecutionTracker } from "../../memory/skill-execution-tracker";
import { runInDocker } from "../sandbox/docker"; // existing Docker exec

export interface FailureSignature {
  // Stage-1 output, persisted on the record
  verifierCause: string; // what the verifier/outcome ultimately rejected
  agentCausalStatus: string; // how agent behavior contributed
  mechanism: string; // reusable behavioral mechanism
}

export interface HarnessProposal {
  skillName: string;
  staged: true; // invariant: lives in staged/, never live
  audit: { targetedMechanism: string; surfacesTouched: string[]; regressionRisk: string };
  cluster: FailureSignature;
}

interface SplitResult {
  pass: number;
  total: number;
}
const rate = (s: SplitResult) => (s.total === 0 ? 0 : s.pass / s.total);

// Hard caps so a corrupted proposal cannot hang or leak the host (replaces the
// brief's Wasm requirement with real Docker resource bounds).
const REPLAY_LIMITS = {
  wallClockMs: 60_000, // SIGKILL after 60s per trace
  maxToolCalls: 40, // loop-bomb guard
  memoryMb: 512, // cgroup OOM-kill guard
  network: "none" as const, // egress denied during validation
};

/** Replay a set of traces against a staged proposal; proxy-verifier scores outcomes. */
async function replaySplit(
  proposal: HarnessProposal,
  traceIds: string[],
  store: InterventionStore,
): Promise<SplitResult> {
  let pass = 0;
  for (const id of traceIds) {
    const trace = store.getTrace(id);
    // The staged skill is mounted READ-ONLY into an ephemeral container; the agent
    // replays the trace's tool sequence. If it loops/leaks, Docker kills the container,
    // not the desktop agent. A throw/timeout counts as a fail, never a host crash.
    const r = await runInDocker(
      { stagedSkill: proposal.skillName, replay: trace },
      REPLAY_LIMITS,
    ).catch(() => ({ verifierOutcome: "fail" as const }));
    if (r.verifierOutcome === "pass") pass++;
  }
  return { pass, total: traceIds.length };
}

/**
 * Proposal Validation node.
 * heldIn  = trace ids from the mined failure cluster (what we want to FIX)
 * heldOut = rolling sample of recently-successful traces (what we must NOT BREAK)
 */
export async function validateProposal(
  proposal: HarnessProposal,
  heldIn: string[],
  heldOut: string[],
  store: InterventionStore,
  tracker: SkillExecutionTracker,
): Promise<{ accepted: boolean; reason: string; deltaIn: number; deltaHo: number }> {
  // ---- Gate L0–L2 (static + schema + diff). Reject = stop. Never auto-override. ----
  const gate = await runSkillGate(proposal.skillName, { acceptHighRiskDiff: false });
  if (gate.outcome === "fail") {
    return {
      accepted: false,
      reason: `gate:${gate.issues[0]?.code ?? "fail"}`,
      deltaIn: 0,
      deltaHo: 0,
    };
  }

  // ---- Baseline: current live behavior on both splits ----
  const baseIn = await replaySplit(
    { ...proposal, skillName: `${proposal.skillName}@live` },
    heldIn,
    store,
  );
  const baseHo = await replaySplit(
    { ...proposal, skillName: `${proposal.skillName}@live` },
    heldOut,
    store,
  );

  // ---- Candidate: staged behavior on both splits (L3 dynamic, sandboxed) ----
  const candIn = await replaySplit(proposal, heldIn, store);
  const candHo = await replaySplit(proposal, heldOut, store);

  const deltaIn = rate(candIn) - rate(baseIn);
  const deltaHo = rate(candHo) - rate(baseHo);

  // ---- L4: Self-Harness acceptance rule (arXiv:2606.09498) ----
  const accepted = deltaIn >= 0 && deltaHo >= 0 && Math.max(deltaIn, deltaHo) > 0;

  if (accepted) {
    await promoteStaged({ tracker }, { name: proposal.skillName }); // atomic + archived rollback
    return { accepted: true, reason: "delta-rule-pass", deltaIn, deltaHo };
  }
  // Rejected proposals are kept (archived) with their Δ as fresh weakness-mining signal.
  return {
    accepted: false,
    reason: deltaIn < 0 || deltaHo < 0 ? "regression" : "no-improvement",
    deltaIn,
    deltaHo,
  };
}
```

**What this PoC deliberately reuses vs. adds:**

- _Reuses:_ `runSkillGate`, `promoteStaged`, `InterventionStore`, `SkillExecutionTracker`, `runInDocker` — all exist today.
- _Adds:_ the `FailureSignature` stamp (Stage 1), the K-parallel proposer (Stage 2, not shown — a prompted `skill_manage` call per cluster), the two-split `replaySplit` + Δ acceptance rule, and `REPLAY_LIMITS` as the resource-bound substitute for the (nonexistent) Wasm sandbox.

---

## 7. Recommendation & phased roadmap

**Recommendation: proceed, scoped to APEX L1+L2 over skills/interceptors; defer L3 topology rewrite indefinitely.** The loop-control rewrite the brief is most excited about is also the part with no safe editable surface (pi owns the loop) and the worst blast radius. Skip it. The win is in skills + interceptors + prompts, where versioning, gating, and rollback already exist.

| Phase                                    | Scope                                                        | Reuses                             | New work                            | Risk         |
| ---------------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ----------------------------------- | ------------ |
| **P1** Weakness-signature stamping       | Persist `FailureSignature` on intervention records; index it | intervention-store, execution hook | signature computer + backfill       | Low          |
| **P2** Validation node                   | `harness-validate.ts` (the PoC) + Docker replay limits       | skill-gate, promote, docker        | replaySplit, Δ rule, proxy verifier | Med          |
| **P3** `harness_evolve` dream mode       | Wire Stages 1–3 as a gated dream mode                        | dream-engine, curator, cron        | mode + K-proposer + telemetry       | Med          |
| **P4** APEX L2 principles                | Success-trace distillation → epistemic directives            | dream research/compression modes   | principle extractor + store         | Med          |
| **P5** (optional) True Wasm/WASI sandbox | Replace Docker bound with `wasmtime` for skill JS            | —                                  | new isolation layer                 | High / large |

**Hard prerequisites before P3 ships:** a working proxy verifier (P1 outcome signal is the cheapest), the kill-switch flag, and the canary rule that self-generated skills **never** auto-propagate over P2P.

**Honest caveats:**

- The whole approach lives or dies on **verifier quality**. With only proxy outcomes, Δ measurements are noisy; expect false accepts. Mitigate with small K, conservative thresholds (consider requiring `max(Δ) > ε` not just `> 0`), and curator quarantine on post-promotion regression.
- The papers' results are on _benchmarks with clean verifiers_ (Terminal-Bench, a 15-node ops agent). Free-form desktop use is messier; do not expect +20pp. Treat the first target as "no regressions + measurable gains on the `benchmarks/` suite," which _does_ have real verifiers.
- I have **not** prototyped or run any of this; the PoC compiles against real module names but the replay/verifier semantics are designed, not tested. Treat §6 as a design artifact pending a spike.

---

## Sources

- [Self-Harness: Harnesses That Improve Themselves — arXiv:2606.09498](https://arxiv.org/abs/2606.09498) ([HTML](https://arxiv.org/html/2606.09498v1))
- [APEX: Adaptive Principle EXtraction — arXiv:2606.15363](https://arxiv.org/abs/2606.15363)
- Codebase: `/mnt/d/Bitterbot/bitterbot-desktop` (modules cited inline by path).
