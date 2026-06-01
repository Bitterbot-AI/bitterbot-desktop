# PLAN-22: Affective Goal Drive (AGD) - Hormone-Gated Complexity Triage and Auto-Initiated Goal Workflows

**Goal:** Make goal-orientation a _biological drive_ rather than a planner mode. Appraise prompt complexity at the front door of the agent loop, set the escalation threshold and decomposition depth from live cortisol/dopamine/GCCRF state, and turn every unfinished goal into Zeigarnik tension that proactive recall and the dream engine are compelled to resolve.
**Date:** 2026-05-31
**Status:** Draft. Awaiting review.

---

## Summary

PLAN-16/17 shipped the entire long-horizon Task spine (store, event journal, handoff records, self-scheduling wakeup, A-MAC Judge, hormonal concurrency gate, completion notifier) and wired two auto-initiation paths (curiosity-spawn and dream-cycle bias). What is still missing is the one seam PLAN-17 explicitly punted: a pre-turn hook that looks at an inbound user prompt, decides whether it warrants a goal workflow, and creates the Task automatically. AGD adds that hook plus a pure complexity-appraisal module, binds both the escalation threshold and the decomposition depth to live hormonal/GCCRF state (the structural moat), and closes the two-way UX gap with a `task_resume_inline` tool.

**What already exists (reuse, do not rebuild):** `TaskStore` CRUD + status enum + done-criteria-as-oracle (`src/tasks/store.ts`, `src/tasks/types.ts`); `EventJournal` task-tagged streams (`src/infra/event-journal.ts`); the Task Judge as both decomposition planner and completion auditor (`src/tasks/judge.ts`, `src/tasks/judge-provider.ts`); the hormonal accessor + `active-task-tracker` concurrency gate (`computeTaskConcurrency` in `src/tasks/biology.ts`); the handoff nudge (`src/tasks/handoff-nudge.ts`); the completion notifier (`src/tasks/completion-notifier.ts`); the cron isolated-agent wakeup executor (`src/cron/isolated-agent.ts`); the curiosity and dream call sites (`src/memory/curiosity-engine.ts`, `src/memory/dream-engine.ts`).

**What is new:** a prerequisite Phase 0 refactor (P0.1: extract the gateway dispatch envelope into `dispatchAgentRun` with a fail-closed `applyPreTurnDecision` seam; P0.2: extract a shared `buildResumeMessage` + session/auth-carry helper) so the hook and resume tool consume primitives instead of editing the 691-line handler inline or re-implementing cross-wakeup binding; `src/tasks/complexity.ts` (pure appraisal + hormonal modulation); `src/tasks/auto-initiate.ts` (the single mutating caller); the pre-turn hook registered through that seam; a Zeigarnik-tension adapter family (E.4) in `src/tasks/biology.ts`; the `task_resume_inline` tool in `src/agents/tools/task-tool.ts`; env flags `BITTERBOT_TASKS_COMPLEXITY_GATE` and `BITTERBOT_TASKS_AUTO_INITIATE`.

---

## Context

PLAN-17 left this gap explicitly (its own Diagnosis): "No gateway loop interceptor/hook for task-auto-initiation - prompts flow through the `agent` method, then `agentCommand()`, then the embedded runner, with no pre-turn complexity gate. Task-spawn only fires explicitly or via curiosity-engine impulse." Today a user can type "refactor the auth module across all three packages, add tests, and open a PR" and the agent will attempt the whole thing inside a single turn with no durable plan, no oracle, and no checkpoint - and if context overflows mid-way, the work dies (the handoff nudge only fires for runs already tagged with a `taskId`).

The runner-up approaches converged on a small set of corrections that this plan adopts:

- **Verified seam.** The architecture brief's cited line numbers were stale. The real entry is the `agent` handler in `src/gateway/server-methods/agent.ts` (the `agentHandlers` object). `agentCommand()` is invoked once, near the end of the handler (the `void agentCommand({...}, defaultRuntime, context.deps)` call), _after_ `requestedSessionKey`/`resolvedSessionKey` resolution and the `/new`/`/reset` short-circuit. The hook attaches there - not at any "line 381/phantom" location.
- **FrugalGPT cascade.** A synchronous sub-millisecond heuristic scorer runs first; the temp=0 Judge LLM is consulted only for prompts in an ambiguous gray band. The common trivial and obviously-large cases never pay for an LLM router round-trip.
- **Mechanical oracles preferred.** "No oracle, no serious goal" (GoalBuddy) is ported onto the existing human-readable `doneCriteria` contract, but the gate prefers a mechanical/observable oracle (test passes, file exists, tool returns, schema validates) and only falls back to the Judge LLM when no observable check is derivable.
- **No schema churn.** The decomposition DAG serializes into the existing `task.plan` (`PlanStep[]`) plus additive `metadata` fields. No new SQLite tables.

SOTA scan grounding the design:

- **Complexity routing** is a live research area (FrugalGPT cascades, RouteLLM). The differentiator here is that the routing threshold is a function of internal affective state, which off-the-shelf routers do not have.
- **ADaPT** (As-Needed Decomposition and Planning) supplies the demand-driven AND/OR recursion: attempt the largest safe slice, decompose only on failure, cap recursion depth.
- **Zeigarnik effect** (unfinished tasks occupy memory and create resumption pressure) is the neuroscience anchor for tension-driven dream bias and proactive recall.
- **Reflexion** supplies the failure-reflection-to-memory loop for cross-session strategy improvement.

---

## The Complexity Gate

### Where it hooks (verified)

In `src/gateway/server-methods/agent.ts`, inside the `agent` handler, after `resolvedSessionKey` is finalized (the `if (requestedSessionKey) { ... }` block that writes `nextEntry` and sets `resolvedSessionKey = canonicalSessionKey`) and after the `/new`/`/reset` short-circuit, but _before_ the `void agentCommand({...})` dispatch. The hook is a single awaited call:

```ts
// new, after sessionKey resolution, before agentCommand dispatch
const goalDecision = await maybeInitiateGoal({
  message, // post-attachment, post-timestamp user text
  sessionKey: resolvedSessionKey,
  agentId,
  runId,
  source: "user",
});
// goalDecision is a discriminated union; agentCommand still runs either way,
// but when a task was created the first slice + an ack are threaded in via
// extraSystemPrompt (see Goal Workflow > Intent).
```

`maybeInitiateGoal` lives in the new `src/tasks/auto-initiate.ts` and is the **only** mutating caller. The scorer itself (`src/tasks/complexity.ts`) is pure and side-effect-free, mirroring the `src/tasks/biology.ts` convention (query-only; the caller decides whether to act). The whole hook is wrapped so that any throw degrades to inline (the user's turn must never be blocked by appraisal failure).

### Two-stage cascade

**Stage 1 - synchronous heuristic scorer (always on, in `complexity.ts`).**
`appraiseComplexity(prompt, ctx): ComplexityVerdict` computes a raw score in `[0,1]` from cheap features:

- token/character length (long prompts skew complex);
- count of imperative/action verbs and multi-clause structure;
- enumeration and sequencing markers ("and then", "after that", numbered lists, "first/second");
- estimated required-tool footprint (does it imply file edits, multi-file scope, web research, builds, shell);
- presence of an implicit oracle (testable/observable success language: "passing tests", "PR", "deploys", "returns X");
- project-lexicon hits (file paths, package names, repo-specific nouns);
- optional embedding-similarity to a small bucket of known-hard past goals pulled from SAGE/episodic memory (PLAN-18). This signal is best-effort: if the memory index is unavailable the term contributes zero.

Output: `ComplexityVerdict { score, signals: Signal[], suggestedDepth, route: 'inline' | 'plan' | 'decompose' }`. `signals[]` is human-readable (`{ name, value, weight }`) so every decision is inspectable.

**Stage 2 - gray-band LLM self-assessment (rare).** Two thresholds `T_low`/`T_high` partition the score. Below `T_low` route is forced `inline`; above `T_high` route is `plan` or `decompose`. Only the gray band `[T_low, T_high]` (default `0.35`-`0.65`) escalates to a single temp=0 Judge-LLM classification, reusing the existing `getJudgeLlmCall()` seam (`src/tasks/judge.ts:191`) with a small `max_tokens`. No new provider, no streaming, no planner round-trip. The common trivial and obviously-large cases never call the LLM.

### Biological modulation (the moat)

`modulateComplexityThreshold(verdict, hormonalState, gccrfState): RoutingDecision` consumes the **same** hormonal getter that `computeTaskConcurrency` uses, via the already-wired accessor (`registerHormonalStateGetter` at `src/tasks/active-task-tracker.ts:37`, fed by `startHormonalAccessor` at boot). Direction is kept consistent with `computeTaskConcurrency` so the two never fight:

- **Effective threshold:** `T_high_eff = T_high_base − dopamineTerm − gccrfCuriosityTerm + cortisolTerm`. High dopamine/GCCRF curiosity **lowers** the escalation bar (explore, decompose eagerly); high cortisol **raises** it (narrow scope, prefer inline or a single bounded slice).
- **Decomposition depth cap:** `suggestedDepth` is multiplied up by dopamine/GCCRF and clamped down by cortisol - the ADaPT recursion cap is literally an effort-allocation knob set by affect.
- **Fan-out:** concurrency reuses `computeTaskConcurrency` unchanged, so cortisol already shrinks active scope globally.
- **Low arousal/energy** biases toward inline to conserve.

Modulation operates **only inside** the deterministic `[T_low, T_high]` band. Hard floors and ceilings sit outside the modulated band: a micro-prompt floor guarantees that trivially short prompts can never escalate regardless of hormones, and a hard ceiling guarantees an obviously multi-step prompt is never suppressed below `plan` even under maximal cortisol. This keeps routing auditable and testable: the band moves, the rails do not.

### Avoiding false triggers on simple prompts

1. Hard micro-prompt floor (length + zero action-verbs + zero tool-footprint → forced `inline`, never appraised further).
2. Stage 1 is the default exit for the vast majority of prompts; the LLM is consulted only in the gray band.
3. The modulated threshold can only move within `[T_low, T_high]`; the floor/ceiling rails are hormone-independent.
4. Capacity backstop: if `acquireTaskSlot` is at capacity or unavailable, a would-be task-tier prompt degrades to inline (plus a deferred curiosity note), so the gate never blocks or drops the user's request.
5. Default-off env (`BITTERBOT_TASKS_AUTO_INITIATE`) until phase-suffixed tests land; `BITTERBOT_TASKS_COMPLEXITY_GATE` controls the appraisal independently for staged rollout.

---

## The Goal Workflow (Intent → Oracle → Surface → Loop → Proof)

Mapped onto the existing status enum (`pending → planning → running → waiting_external → judging → {completed, failed, stopped}`) with no new lifecycle states.

**Intent.** `maybeInitiateGoal` creates a Task via `TaskStore.create` with `source: "user"`, the user prompt as `goal`, and the modulated `ComplexityVerdict` (including the pinned hormonal/GCCRF snapshot) stored in `metadata`. A one-line user ack ("Starting a goal run for this - I will work it as a tracked task.") is threaded into the run via `extraSystemPrompt` so the turn remains abortable and the user is never silently switched into a background mode.

**Oracle.** Creation **requires** a non-empty `doneCriteria` (the existing human-readable acceptance contract the Judge already reads as its sole pass/fail input). The gate derives it in priority order: (1) a mechanical/observable oracle if one is inferable (test command, artifact path, tool-return shape, schema); (2) failing that, the Judge LLM drafts a falsifiable oracle, surfaced to the user; (3) the in-turn agent may refine it via `task_update` before the first wakeup. Vacuous or unfalsifiable oracles are rejected at creation. This directly closes GoalBuddy's own weak-oracle failure mode.

**Surface.** `task.plan` (ordered `PlanStep[]`) is the single board. The decomposition DAG serializes into `task.plan` plus additive `metadata.deps` / `metadata.group` fields - no parallel persistence layer, no schema change, and the existing `store.update` immutability rule (a `PlanStep` cannot leave `completed`, enforced at `store.ts`) is respected. The `EventJournal` task-id-tagged stream is the durable, re-readable working-memory artifact (the `state.yaml` analog) that survives cron wakeups.

**Loop.** ADaPT demand-driven decomposition: the executor attempts the largest safe useful slice (bounded, explicit, verified, reversible). On failure, the Judge decomposes into AND/OR sub-steps; recursion depth is capped by the hormone-set `suggestedDepth`. Each completed slice writes a receipt as a task-id event (reusable for confidence calibration and reconsolidation). An idempotency/rollback precondition is recorded in the EventJournal before a step is eligible for retry, guarding against double-effects on replan. Long slices trigger the existing handoff nudge (`maybeNudgeTaskHandoff`, fired in `src/agents/pi-embedded-subscribe.handlers.tools.ts`) and `task_schedule_wakeup` for background continuation on the cron isolated-agent path - no new runner is introduced.

**Proof.** Completion is gated by `runTaskJudge` auditing receipts against the oracle (`judging → completed` only when the oracle is satisfied, not when the plan is merely empty). `runTaskJudge` is reused twice: as a per-step verifier and as the final auditor. On `fail`/`needs_more`, a Reflexion-style reflection is written to SAGE/episodic memory so decomposition strategy improves across sessions, and the task re-opens with `source: "judge"` per the existing convention.

**Promotion back to chat.** `task_resume_inline` (new) is the inverse of `task_schedule_wakeup`: it loads the task and latest handoff, marks it `running` with `currentRunId` bound to the current run, and enqueues the same resume prompt the cron wakeup would have used into the _current_ session. This closes the two-way UX gap (Phase 4a, which PLAN-17 deferred). Background→foreground completion notices already ride the wired `completion-notifier`.

---

## Biology Binding

This is structural, not cosmetic:

1. **Escalation threshold is a function of live state** - the same prompt routes to a quick inline answer under stress and to a decomposed multi-slice goal under curiosity.
2. **Decomposition depth = ADaPT recursion cap** set by dopamine/GCCRF (raise) vs cortisol (clamp) - an effort-allocation primitive off-the-shelf routers lack.
3. **Fan-out reuses `computeTaskConcurrency`** so cortisol literally narrows active scope; the gate and the concurrency tracker read the identical getter and never contradict.
4. **Zeigarnik tension (new biology.ts E.4).** `computeZeigarnikTension(pendingTasks, hormonalState)` derives a tension scalar from count, age, and stall of unfinished `source:"user"` goals, weighted by hormonal state. This feeds the **existing** dream pre-weighting path (`scanPendingTasksForDream` → `computeDreamTaskAdjustments`, applied in `src/memory/dream-engine.ts`) so open loops bias Simulation/Replay dream modes, and feeds proactive recall so the system surfaces and resumes open loops unprompted. `maybeResumeFromTension()` returns a resumption candidate; the caller (dream engine / proactive recall) decides to act, keeping E.4 pure like E.1-E.3.
5. **Curiosity-spawn is a sibling initiation path.** `maybeSpawnTaskFromCuriosity` (`src/memory/curiosity-engine.ts`) and `maybeInitiateGoal` both write into the same Task lifecycle; no second pipeline.
6. **Consolidation.** Completed goal DAGs are dream-harvested into reusable plan templates (the PLAN-20 interceptor / case-based-HTN seam), giving a spacing/consolidation analog.

All tension-driven resumption reuses the existing 5-minute handoff-nudge throttle pattern and decays tension on user dismissal, so the drive never becomes a nagging loop.

---

## Phased Implementation

> **Sequencing constraint (review correction).** Phase 3 (the hook) and Phase 5 (the resume tool) must not be wired into the gateway as-is; each needs a primitive extracted first so it cannot break the existing run path. Verified against HEAD: `agentCommand` (`src/commands/agent.ts:205`) is already a widely shared entrypoint (~9 call sites across `agent-via-gateway.ts`, `openai-http.ts`, `boot.ts`, `server-node-events.ts`, `openresponses-http.ts`, and the gateway handler), so it is not the gap. The gap is the gateway _dispatch envelope_ - runId generation, the `context.dedupe` ack (`agent.ts:519`/`524`), and the two-phase `respond` (`agent.ts:524` then `agent.ts:578`) - which is inlined in the 691-line handler and partly duplicated in `server-node-events.ts`. Critically the handler acks `{status:"accepted"}` at line 524 _before_ the `void agentCommand(...)` fire-and-forget at line 528: a hook before the ack delays it, and a hook between the ack and the dispatch runs outside any error boundary where a throw silently kills the run. Phase 0 builds both prerequisites; Phases 3 and 5 then consume them.

### Phase 0 - Prerequisite primitives (refactor, zero behavior change)

**Scope.** Two extractions, no new behavior, fully covered by the existing gateway/wakeup tests.

- **P0.1 `dispatchAgentRun()` + `applyPreTurnDecision` seam (prereq for Phase 3).** Extract the dispatch envelope (runId, `context.dedupe` ack, two-phase `respond`, session canonicalization, outbound-target resolution) out of `agent.ts` into one reusable function; collapse the `server-node-events.ts` duplication onto it. Add a typed, fail-closed `applyPreTurnDecision(payload) -> payload` interceptor invoked _after_ the ack, wrapped so any throw or timeout logs and returns the unmodified payload. The hook can then only augment `message`/`extraSystemPrompt`/`runContext`; it can never delay the ack or kill the run. This makes "cannot break the gateway" structural rather than convention.
- **P0.2 shared `buildResumeMessage` + session/auth-carry helper (prereq for Phase 5).** Extract the resume-prompt builder and the session-key/auth carry currently inside `task_schedule_wakeup` so both the existing wakeup path and the new `task_resume_inline` tool share one implementation, instead of the tool re-implementing cross-wakeup session binding.

**Files touched:** `src/gateway/server-methods/agent.ts`, `src/gateway/server-node-events.ts`, `src/agents/tools/task-tool.ts` (extract only).
**Files added:** `src/gateway/server-methods/dispatch-agent-run.ts` (+ test), `src/tasks/resume-message.ts` (+ test).
**Tests:** existing gateway agent tests pass byte-identically against `dispatchAgentRun`; the no-op `applyPreTurnDecision` is transparent; a throwing/timing-out decision falls through to the unmodified payload; `buildResumeMessage` parity between wakeup and inline callers.
**Migration:** none.

### Phase 1 - Pure complexity appraisal (`complexity.ts`)

**Scope.** Stage-1 heuristic scorer + the modulation function, both pure. Discriminated `RoutingDecision` with `reasons[]`. No hook, no mutation, no LLM call yet (gray band returns `needs_llm: true` for the caller to resolve later).
**Files added:** `src/tasks/complexity.ts`, `src/tasks/complexity.test.ts`.
**Files touched:** none.
**Tests:** feature scoring on a corpus of trivial/medium/large prompts; floor/ceiling rails; modulation moves the band in the right direction for high-cortisol vs high-dopamine snapshots; modulation never crosses the rails.
**Migration:** none.

### Phase 2 - Auto-initiate caller + gray-band LLM (`auto-initiate.ts`)

**Scope.** `maybeInitiateGoal` (the single mutating caller): runs Stage 1, resolves the gray band via `getJudgeLlmCall()` (temp=0, bounded tokens), reads the hormonal/GCCRF getters, derives/validates the oracle (mechanical-first, Judge-fallback, reject vacuous), creates the Task with the pinned snapshot in `metadata`, writes the creation event to the EventJournal, and returns a discriminated `{ mode: 'inline' } | { mode: 'task', taskId, ack, firstSlice }`. Capacity backstop via `acquireTaskSlot`.
**Files added:** `src/tasks/auto-initiate.ts`, `src/tasks/auto-initiate.test.ts`.
**Files touched:** none yet (hook lands in Phase 3).
**Tests:** trivial → inline; large → task with valid oracle; gray band consults the (mocked) Judge once; vacuous oracle rejected; at-capacity degrades to inline + deferred note; every decision recorded in `metadata` + journal.
**Migration:** none (uses existing `metadata` JSON column).

### Phase 3 - Pre-turn hook in the agent loop

**Scope.** Register `maybeInitiateGoal` as the `applyPreTurnDecision` implementation from P0.1 (runs after the client ack, inside the fail-closed wrapper), not as a raw inline call in the handler. Thread the ack + first slice into `extraSystemPrompt` via the payload augmentation the seam returns. Gate behind `BITTERBOT_TASKS_AUTO_INITIATE` (default off) and `BITTERBOT_TASKS_COMPLEXITY_GATE` (default on for appraisal-only telemetry). Fail-open is now structural (the seam swallows throws/timeouts), not a hand-written try/catch.
**Files touched:** `src/tasks/auto-initiate.ts` (register the seam); the handler itself is unchanged beyond Phase 0.
**Files added:** `src/gateway/server-methods/agent.auto-initiate.test.ts`.
**Tests:** hook fires only when env on; inline prompts pass through unchanged (byte-identical `agentCommand` args); thrown appraisal degrades to inline; ack threaded for task-tier; `/new`/`/reset` path is never appraised.
**Migration:** none.

### Phase 4 - Zeigarnik tension adapters (biology.ts E.4)

**Scope.** Add `computeZeigarnikTension` and `maybeResumeFromTension` as pure adapters. Wire the tension term into the existing dream pre-weighting (`computeDreamTaskAdjustments` consumer in `dream-engine.ts`) and into proactive recall, both throttled by the existing 5-minute pattern and with decay-on-dismissal. Gate behind `BITTERBOT_DREAM_TASK_BIAS` (existing) extended to cover tension.
**Files touched:** `src/tasks/biology.ts`, `src/memory/dream-engine.ts` (consumer only), proactive-recall call site.
**Files added:** `src/tasks/biology.phase4.test.ts` (note the spelled-out `phase4` per the repo's E.4 test-naming convention).
**Tests:** tension scales with count/age/stall and hormonal state; zero pending → zero adjustment; resumption respects throttle and decays on dismissal.
**Migration:** none.

### Phase 5 - `task_resume_inline` tool (two-way UX)

**Scope.** New agent tool in `src/agents/tools/task-tool.ts`: load task + latest handoff, mark `running` with `currentRunId` bound to the current run, enqueue the resume prompt into the current session using the shared `buildResumeMessage` + session/auth-carry helper from P0.2 (not a re-implementation). This is the riskiest item because of session-key/auth binding across wakeups, which is exactly why P0.2 extracts that binding into one tested helper first. Register in `src/agents/bitterbot-tools.ts`.
**Files touched:** `src/agents/tools/task-tool.ts`, `src/agents/bitterbot-tools.ts`.
**Files added:** `src/agents/tools/task-tool.phase5.test.ts`.
**Tests:** resume binds the correct session/run; refuses on terminal tasks; idempotent re-call does not double-enqueue; auth/session-key carried across the wakeup boundary.
**Migration:** none.

---

## Risks and Mitigations

- **Front-door latency/cost on every prompt.** Stage-1 heuristic first + hard micro-prompt floor; only the gray band hits one temp=0 LLM call. Telemetry on gray-band hit rate; tune `T_low`/`T_high` if the band is too wide.
- **Non-deterministic, hard-to-debug routing from hormonal modulation.** Pin the hormonal/GCCRF snapshot and the full `signals[]`/`reasons[]` into `ComplexityVerdict` metadata and the EventJournal; keep deterministic floor/ceiling rails around the modulated band so tests assert on the rails, not the band.
- **Weak/unfalsifiable oracle silently defeats the proof loop.** Require `doneCriteria` at creation; prefer mechanical oracles; have the Judge reject vacuous ones; allow in-turn refinement before the first wakeup.
- **Goal sprawl under chronic high curiosity (AutoGPT failure mode).** Recursion-depth + cost/time budgets per goal; reuse `computeTaskConcurrency` as a global throttle; curiosity-spawn already dedupes by topic with a 7-day lookback.
- **Tension-driven dreams/recall becoming nagging or looping.** Reuse the 5-minute handoff-nudge throttle; decay tension on user dismissal.
- **`task_resume_inline` session/auth binding across wakeups is genuinely new plumbing.** Scoped as its own phase with dedicated auth-carry tests.
- **Stale line numbers in source briefs.** All seams in this plan were re-validated against HEAD: the hook attaches in the `agent` handler before the `agentCommand` dispatch; `registerHormonalStateGetter` is at `active-task-tracker.ts:37`; `getJudgeLlmCall` at `judge.ts:191`. Re-validate again at implementation time.

## Non-Goals

- No new runtime, scheduler, or persistence layer; execution rides the existing cron isolated-agent + status enum + EventJournal + handoffs.
- No new SQLite tables or migration; the DAG lives in `task.plan` + additive `metadata`.
- No auto-spawning of parallel sub-agents; parallel plans only _report_ disjoint read/write scopes (human-gated fan-out).
- No self-consistency Judge voting in this plan (deferred, consistent with PLAN-17 Phase 1).
- No wallet/bounty involvement; P2P payout remains Victor-only and untouched.
- No model-fallback-chain edits (that is PLAN-17 Phase 5 territory).

---

## What the user gets when this ships

Type a one-liner like "audit the access-control normalization, write a regression test, and confirm it passes" and the agent recognizes the complexity, states it is opening a tracked goal, derives a falsifiable oracle (the test passes), works the largest safe slice, hands off and self-schedules if context runs tight, and reports back when the oracle is satisfied - and if the user later says "what about that audit?", the open loop is already surfaced because it was tension the system was driven to resolve. Under stress (high cortisol) the same one-liner gets a fast, narrow answer instead; under curiosity (high dopamine/GCCRF) it decomposes more eagerly. The triage is the biology, not a toggle.

---

Relevant files (all absolute):

- New: `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/complexity.ts`, `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/auto-initiate.ts`
- Edit: `/mnt/d/Bitterbot/bitterbot-desktop/src/gateway/server-methods/agent.ts` (hook before the `agentCommand` dispatch), `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/biology.ts` (E.4), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/dream-engine.ts` (tension consumer), `/mnt/d/Bitterbot/bitterbot-desktop/src/agents/tools/task-tool.ts` + `/mnt/d/Bitterbot/bitterbot-desktop/src/agents/bitterbot-tools.ts` (`task_resume_inline`)
- Reuse seams: `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/store.ts`, `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/types.ts`, `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/judge.ts` (`getJudgeLlmCall` at :191), `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/active-task-tracker.ts` (`registerHormonalStateGetter` at :37, `acquireTaskSlot`), `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/handoff-nudge.ts`, `/mnt/d/Bitterbot/bitterbot-desktop/src/tasks/completion-notifier.ts`, `/mnt/d/Bitterbot/bitterbot-desktop/src/cron/isolated-agent.ts`, `/mnt/d/Bitterbot/bitterbot-desktop/src/infra/event-journal.ts`

Suggested filename for this plan: `/mnt/d/Bitterbot/bitterbot-desktop/research/plans/PLAN-22-AFFECTIVE-GOAL-DRIVE.md`

---

## Addendum: Review Hardening (must-fix before implementation)

An adversarial fit-check against the live architecture flagged four hardening
requirements. None are architectural blockers; all must be folded into the
relevant phases before code lands.

### 1. Hard latency budget on the hot path

The pre-turn appraisal sits on every user turn. Stage 1 (heuristic) is sub-ms,
but the gray-band Judge consultation must run under a strict timeout
(target 800ms) and, on timeout, degrade to inline (treat as below-threshold).
The whole hook is wrapped so any throw or timeout never blocks the turn.

### 2. Immediate user-facing opt-out at auto-initiation

When a turn is converted into a goal workflow, the acknowledgement must offer an
obvious, immediate escape hatch ("reply 'just answer' to skip the plan"), not
only the `BITTERBOT_TASKS_AUTO_INITIATE` env flag. Auto-initiation must never be
silent.

### 3. Deterministic override for reproducibility

Hormone-gated thresholds make behavior state-dependent and bug reports hard to
reproduce. Provide a deterministic override (fixed threshold via env/flag for
tests and support repro) and always log the appraised score, the active
hormonal modifiers, and the final decision so any initiation is explainable.

### 4. False-positive regression test (highest-risk)

A long-but-simple prompt (a pasted error log, a large code block, a quoted
document) must NOT trigger a goal workflow. This is the top regression risk and
needs an explicit end-to-end test, plus gate precision/recall telemetry so the
threshold can be tuned post-launch.

### Duplication to resolve during design

- Oracle derivation partly reinvents the Judge's existing job. judge.ts already owns done-criteria evaluation as 'the sole pass/fail contract' (buildTaskJudgePrompt/parseTaskJudgeResponse/runTaskJudge). The plan's Stage-2 'Judge LLM drafts a falsifiable oracle' and 'Judge rejects vacuous oracles' adds a NEW judge call mode (oracle-authoring + oracle-validation) that judge.ts does not currently expose. This is not reuse of getJudgeLlmCall as claimed; it is a second prompt/contract bolted onto the judge seam. Either extend judge.ts deliberately (with its own phase + tests) or stop describing it as a free reuse.
- The 'mechanical/observable oracle' inference (test command, artifact path, tool-return shape, schema) is brand-new capability with no home in src/tasks. doneCriteria is explicitly a human-readable string contract per the conventions (types.ts), not a structured machine-checkable oracle. The plan smuggles a structured-oracle type into a string field and calls it 'no schema churn' - that is a real new abstraction, not reuse.
- Zeigarnik tension (E.4) partly duplicates scanPendingTasksForDream/computeDreamTaskAdjustments (E.2), which ALREADY pre-weights dream modes from pending tasks (Simulation +20%, Replay +10% per dream-engine.ts:608-641). computeZeigarnikTension(pendingTasks, hormonalState) reads the same store-of-pending-tasks for the same dream consumer. The plan should state whether E.4 REPLACES the E.2 adjustment math or stacks on top of it; as written, two functions feed the same dream weighting with overlapping inputs and undefined composition.
- Length/action-verb/enumeration heuristic scoring overlaps conceptually with what curiosity-engine already does to decide novelty/alignment before spawning a task (novelty 0.6 / alignment 0.4 gates). Two different scalar-scoring front ends now both decide 'is this worth a task'. The plan asserts they are 'siblings into the same lifecycle' but does not address dedup BETWEEN them: a curiosity-spawned task and a complexity-gated task for the same user intent can both fire.
- embedding-similarity to 'known-hard past goals pulled from SAGE/episodic memory' reinvents a retrieval the SAGE/proactive-recall layer (PLAN-18) already performs. Pulling a 'small bucket of known-hard past goals' is an undefined new query path; the plan hand-waves it as best-effort but specifies no actual SAGE API it calls.

### Integration friction to confirm

- Front-door hook placement fights the existing entry contract. agentCommand is dispatched with `void agentCommand(...)` (line 528) - fire-and-forget, NOT awaited. The plan inserts `await maybeInitiateGoal(...)` immediately before it. That makes the previously non-blocking front door block on appraisal (and, in the gray band, on a temp=0 Judge LLM round-trip) for EVERY qualifying prompt. The try/catch-degrades-to-inline mitigation does not remove the latency for the success path; it only handles throws. This is a real regression to interactive turn latency that the 'sub-millisecond Stage 1' framing obscures because the gray band is explicitly an LLM call on the hot path.
- extraSystemPrompt threading conflicts with the actual call shape. agent.ts passes `extraSystemPrompt: request.extraSystemPrompt` (line 558) - it forwards the CALLER-supplied value verbatim. To inject the ack + first slice the hook must override/merge request.extraSystemPrompt, which silently discards or concatenates a client-provided prompt. The plan says 'threaded in via extraSystemPrompt' without specifying merge semantics; this will collide with any client that already sets it.
- The agentId variable is re-derived and shadowed inside the sessionKey block (const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey) at line 428 shadows the outer agentId). The hook's `agentId` argument is ambiguous about which scope it reads. A hook placed 'before agentCommand dispatch' sits after this shadowing; the plan's pseudo-code passes a bare `agentId` and `runId` without acknowledging the shadow or where runId is bound.
- Biology purity convention vs. the hook doing mutation+LLM+journal. The repo convention is strict: biology.ts adapters are pure, query-only, callers decide to act. The plan honors this for complexity.ts but auto-initiate.ts becomes a heavy side-effecting orchestrator (LLM call, oracle validation, TaskStore.create, EventJournal write, acquireTaskSlot) living in src/tasks/ alongside the pure adapters. That is a new category of module in src/tasks (a mutating orchestrator) - it belongs architecturally closer to the gateway/command layer or needs explicit justification, otherwise it muddies the 'src/tasks = pure adapters + store + judge' separation.
- task_resume_inline 'enqueue the resume prompt into the current session' has no demonstrated enqueue primitive. completion-notifier enqueues system events to task.agentSessionKey (background->foreground). Resume-inline needs to inject into the CURRENTLY RUNNING foreground run - a different direction with no existing seam. The plan calls it 'the inverse of task_schedule_wakeup' but schedule_wakeup writes a cron payload; there is no in-session injection API. This is the single biggest unproven plumbing item and the plan correctly flags it as risky but understates that the mechanism does not exist at all, not merely that auth-binding is hard.
- binding currentRunId 'to the current run' from inside a tool call: the tool executes mid-run inside the embedded runner; marking the task running with currentRunId = the in-flight run, then enqueuing a resume prompt into the same session, risks re-entrancy / a run resuming itself. No guard described against the resume prompt re-triggering the complexity gate (which would create a task FROM a task-resume prompt). Loop risk between the front-door gate and resume-inline is unaddressed.
- Capacity backstop uses acquireTaskSlot at the front door, but acquireTaskSlot's lifecycle is currently owned by cron/isolated-agent (acquire before wakeup, release-finally). Acquiring a slot synchronously in the gateway agent handler introduces a SECOND acquirer with a different release path. If maybeInitiateGoal acquires a slot to test capacity, when/where is it released? A check-without-acquire (peek) is needed, not acquireTaskSlot, or you leak slots on the inline-degrade path.
