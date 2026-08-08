# Prime Agent (RLM) vs Bitterbot Harness: Deep Research Report

**Date:** 2026-08-08
**Subject:** https://github.com/PrimeIntellect-ai/prime-agent (released 2026-08-05/06)
**Method:** 5-angle web sweep, 22 sources fetched, 110 claims extracted, top 25 adversarially verified (3-vote refutation panel): 24 confirmed, 1 refuted.
**Our goals assessed against it:**
(a) agent autonomously _identifies_ that a task is long-horizon and executes it to completion;
(b) recursive self-learning: the agent improves its own harness/policies from experience.

---

## 1. What the RLM paradigm actually is

The lineage hypothesis is confirmed: Prime Agent builds directly on **"Recursive Language Models" (arXiv:2512.24601)** by Alex L. Zhang, Tim Kraska, and Omar Khattab (MIT CSAIL). Prime Intellect's own blog credits Zhang explicitly.

An RLM is an **inference paradigm, not a model architecture**: the long prompt is treated as part of an external environment. The root LM never ingests the full input. Instead the context is stored as a Python variable in a REPL, and the model programmatically examines, decomposes, and recursively calls sub-LMs over snippets of it as if they were functions (depth limited to 1 in the paper's experiments).

Headline paper results (author-reported, see caveats):

- RLMs processed inputs up to ~two orders of magnitude beyond the model's context window (an 8B/128k model over ~10M tokens).
- **RLM-Qwen3-8B** beats base Qwen3-8B by **28.3% on average** and approaches vanilla GPT-5 on three long-context tasks. Important: this was achieved via **SFT/distillation on 1,000 filtered trajectories**, not RL.

Sources: arxiv.org/abs/2512.24601, alexzhang13.github.io/blog/2025/rlm/, primeintellect.ai/blog/rlm

## 2. Prime Agent architecture

- **A persistent IPython kernel is the model's ONLY built-in tool.** File ops, shell, tool use, subagents, and context management all happen as Python code the model composes ("prompt-as-a-variable", "programmatic tool/sub-agent calling"). A TypeScript host owns providers, session persistence, child lifecycles, scheduling, and safety policy. The kernel is "a durable control environment, not a security sandbox."
- **Recursion is fire-and-forget child spawning.** `await rlm("sub-task", name=...)` spawns a FULL child agent session (own model, kernel, session tree, history) and returns immediately with a handle (`rlm_child_id`, `session_dir`, `model`). It never waits for or returns the child's answer (blocking would deadlock the serial kernel). Results come back only via explicit `agent_message.send(..., receiver_role="parent")` or files the parent reads. Parallel decomposition is ordinary `asyncio.gather`. A parent-scoped child registry (`rlm.list_subagents()`) survives compaction, kernel restart, and parent restoration.
- **"Recursive" means programmatic sub-LM calls over context variables**, not a recursively trained model.

Sources: prime-agent README, packages/coding-agent/docs/rlm.md and rlm-runtime.md, primeintellect.ai/blog/prime-agent

## 3. Long-horizon execution: opt-in, not detected

This is the finding that matters most for our goal (a). Prime Agent's durability comes from an **explicit, user-opt-in feature set**:

- automatic context compaction (summarize + fresh branch at a token threshold) with **Python kernel state surviving compaction** (variables, imports, functions, parsed results, task handles);
- persistent goals via `/goal`; heartbeats (`/heartbeat`, `rlm_heartbeat`); schedules (`prime-agent schedule`); daemon-backed sessions that outlive the terminal; retained subagents;
- a bounded `/autonomous` mode: default budgets of **3 continuations, 12 turns, 80k tokens, 30 min wall-clock**, with user-defined quality gates.

**Nothing in prime-agent decides on its own that a task needs decomposition or persistence.** The identification problem is entirely unsolved there. Our PLAN-16/17 multi-signal handoff nudge (partial autonomous identification of long-horizon work) remains genuinely differentiated.

## 4. Self-improvement: the Continual Harness

Prime Agent's "self-improving" claim is **inference-time harness learning, not RL weight updates** (cites arXiv:2605.09998, Karten/Zhang et al.):

- Supplemental prompts, memories, skill descriptions, and reusable subagent specs are durable, session-local-by-default state the agent can CRUD-edit.
- The `/refine` command reads the agent's own trajectory and applies **the smallest evidence-backed edit**. Each refinement **records its trigger and the outcome it produced**; snapshots support **rollback**; the immutable base system prompt is never rewritten.
- No training loop ships in the repo. Prime Intellect: "currently no model has been trained around Prime Agent." The RL rollout harness lives in a separate, training-only repo (**rlm-harness**: "only use this to train on agentic task using verifiers"), which plugs into prime-rl/verifiers/Environments Hub.

Structurally this is the same family as our PLAN-25 `harness_evolve` (dream-mode evolution of prompt fragments + tool descriptions through the PLAN-21 gate). The differences: theirs runs **per-trajectory** with explicit **trigger/outcome provenance and snapshot/rollback**; ours runs **offline in dreams** without either.

## 5. Comparison vs our harness

| Dimension                             | Prime Agent                                                                                                                                                | Bitterbot (this repo)                                                                                                                                 | Edge                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Long-horizon **identification**       | None. All continuity features are user-invoked commands or configured schedules                                                                            | PLAN-16/17: multi-signal handoff nudge partially detects long-horizon work autonomously                                                               | **Us**                                                                                         |
| Long-horizon **execution durability** | Strong: kernel state outside the prompt survives compaction; daemon sessions; child registry survives restarts; bounded autonomous mode with quality gates | PLAN-16/17 spine: event journal, task store, handoffs, schedule_wakeup, Judge; but no state-outside-prompt pattern, no compaction-surviving workspace | **Them**                                                                                       |
| Context management                    | Prompt-as-a-variable in a persistent REPL; root model sees metadata, not the full context                                                                  | Conventional context window + biological memory system (recall layers, KG, bitemporal)                                                                | Different bets; theirs is the novel mechanism                                                  |
| Sub-agent decomposition               | Fire-and-forget full child sessions, async message/file results, durable registry                                                                          | Task handoffs on the PLAN-16 spine; sandbox/worktree agents                                                                                           | **Them** (on durability of the child graph)                                                    |
| Self-improvement                      | Continual Harness `/refine`: per-trajectory, evidence-backed CRUD, trigger/outcome provenance, snapshot/rollback, immutable base prompt                    | PLAN-25 harness_evolve: dream-mode (offline), PLAN-21 gate, kill switch; no provenance or rollback records                                            | **Them** on provenance/reversibility; **us** on having an offline consolidation channel at all |
| RL weight updates                     | None shipped (separate training-only rlm-harness; no model trained around Prime Agent yet)                                                                 | None                                                                                                                                                  | Tie (both aspirational)                                                                        |
| Field track record                    | Released 2026-08-05/06; zero independent replication                                                                                                       | Years of shipped, tested subsystems                                                                                                                   | **Us**                                                                                         |

## 6. Ranked borrowable ideas

1. **Trigger/outcome provenance + snapshot/rollback on every harness mutation** (retrofit to PLAN-25/PLAN-34). Effort: LOW. Risk: LOW. Highest value: makes harness_evolve evidence-backed and reversible, and is the prerequisite that de-risks everything below.
2. **A per-trajectory `/refine`-style pass at task completion**, feeding the same store as dream-mode evolution. Effort: LOW-MEDIUM. Risk: MEDIUM (prompt drift / harness bloat), mitigated by #1.
3. **State-outside-the-prompt**: persist a per-task workspace (variables, artifacts, handles) that survives compaction and session handoffs, attached to the PLAN-16 task store. Effort: MEDIUM. Our stack is TypeScript, not a Python kernel, so the borrow is the _pattern_ (durable task-scoped state + compaction that preserves it), not IPython itself.
4. **Fire-and-forget child agents with a durable child registry** and message-based result return, mapped onto PLAN-16 handoffs. Effort: MEDIUM-HIGH. Risk: MEDIUM (lifecycle/orphan management). Any design must not assume a synchronous return value.
5. **Budget-bounded autonomous mode with user-defined quality gates** as the _execution_ half of goal (a), paired with our existing handoff nudge as the _detection_ half. Effort: MEDIUM. Risk managed by budgets (their defaults: 3 continuations / 12 turns / 80k tokens / 30 min).
6. **Verifier-driven RL (rlm-harness style)**: the only path either side has toward true weight-level self-learning. The RLM-Qwen3-8B result shows trajectory post-training works (via SFT), but this is infrastructure we do not have. Effort: HIGH. Risk: HIGH. **Defer.**

## 7. Caveats (from the adversarial pass)

1. **Recursion depth is unsettled.** The claim "Prime Agent is limited to depth 1" was REFUTED (1-2 vote): the repo contains `rlm-max-depth.ts` suggesting configurable depth. But the paper's experiments and the RLM blog do state depth 1 as the current practical regime (sub-LMs cannot call further sub-LMs; depth 2 reportedly breaks current models). "Recursive" beyond one level is partly aspirational.
2. **All performance numbers are vendor- or author-reported.** The 95.5% ARC-AGI-3 figure is a Prime Intellect claim with no independent replication (deliberately excluded from findings). The ~100x-context and +28.3% results are author benchmarks; independent analysis notes run-to-run variance and ~3x cost for best-of-3 reliability.
3. **RLM-Qwen3-8B was trained via SFT/distillation, not RL.** It supports "post-training works," not "prime-rl-style RL works."
4. **Extreme time-sensitivity.** Released 2-3 days before this research; APIs, docs, and defaults will move fast; zero field track record.
5. **"Long tasks keep moving" is gated, not unbounded** (autonomous mode budgets above).
6. **Section 5-6 rankings are analyst synthesis** grounded in local plan docs + memory, not third-party verified.
7. **`rlm()` results are asynchronous only**; never design around a synchronous return.

## 8. Open questions

- What does `rlm-max-depth.ts` actually permit; is multi-level recursion functional and coherent in practice?
- Does `/refine` measurably improve outcomes or degrade over long horizons (prompt drift, harness bloat)? No published eval of the Continual Harness exists yet. Directly informs how aggressively we wire borrowable #2 into PLAN-25.
- Will Prime Intellect close the loop by RL-training a model around Prime Agent (prime-rl + rlm-harness + verifiers), and would such a checkpoint be open and usable as a drop-in for RLM-style harnesses?
- Can the durability story be independently replicated, e.g. by running prime-agent ourselves on a bounded task suite, before committing to the medium/high-effort borrows (#3, #4)?

## 9. Second pass: prime-agent vs our two existing RLM implementations

Added 2026-08-08 after a code-level review of the two places we already implemented a version of RLM. Verdict up front: **no transplant**. Their release independently validates both of our bets (we implemented the same Zhang paper, and our state-vector idea parallels their kernel persistence), and everything worth taking is an incremental upgrade to what we have.

### 9.1 What we actually built

**Area 1: Deep Recall** (`src/agents/rlm/*`, `src/agents/tools/deep-recall-tool.ts`). A faithful implementation of the paper's regime, scoped as a read-only recall tool: root model (the agent's configured model) writes JS code blocks in a REPL loop; code runs in a locked-down Node VM sandbox over the conversation/crystal context loaded as a variable; `llm_query` / `llm_query_parallel` fan out to a cheap sub-model; `FINAL()` terminates; CostTracker enforces iterations/budget/sub-call caps; 1h query cache; failed queries register curiosity blind spots. Depth is effectively 1: sub-calls are plain completions.

**Area 2: Working Memory state vector** (`working-memory-prompt.ts`, `manager.ts` rewriteWorkingMemory). MEMORY.md as a persistent state vector updated by the dream engine every ~2h: `New_State = f(Old_State + Scratch_Delta + New_Crystals + Dream_Insights)`, hormone-weighted sections, crystal pointers for lossless eviction, scratch.md as a write-ahead log between cycles, collapse guards on synthesis. This uses "RLM" in the recurrent-state sense rather than the paper's inference paradigm, but it is exactly the state-outside-the-prompt idea.

### 9.2 How their work improves ours (ranked upgrades)

1. **Live environment instead of a snapshot** (Deep Recall). `buildDeepRecallContext` snapshots up to ~500k tokens into a static string before the loop starts; the sandbox then has only text utilities over that string. Prime-agent's kernel operates over live handles. Fix: inject async DB-backed `search()` / `loadTranscript()` / `listSessions()` into the VM context (the sandbox already awaits async calls). This removes the snapshot ceiling, gives true unbounded recall, and closes a docs-vs-code gap (see 9.5). Effort: MEDIUM. Highest value of this list.
2. **Snapshot/rollback + trigger/outcome provenance on MEMORY.md rewrites** (Working Memory). We have collapse guards, but no per-rewrite snapshot of the previous state and no record of which inputs drove a rewrite (only the migration-time seed backup, plus scratch indexed as crystals). This is borrowable #1 from section 6 applied to Area 2 specifically. Effort: LOW.
3. **Event-triggered state synthesis** (Working Memory). Our state update waits for the 2h dream tick; prime-agent preserves state at the moment of context pressure (compaction). Wire compaction/session-end events to trigger a working-memory synthesis (or at minimum a scratch flush). The auto-scratch hormonal backstop already covers part of this. Effort: LOW.
4. **Real depth-1 recursion** (Deep Recall). `executor.ts` lines 114-153: the two depth branches are identical, so recursion is dead code and sub-calls are single 2000-token completions. The paper's actual mechanism gives the sub-call its own mini-REPL over a slice of the context. Effort: LOW-MEDIUM, and worth doing before raising maxDepth.
5. **Persistent kernel per session/task** (Deep Recall). Our sandbox is built and disposed per query; only the answer cache survives. Prime-agent's kernel state survives across turns, compaction, and restarts. Increment: keep one sandbox (context handles + persistentStore) alive per session, and persist the store into PLAN-16 task state on handoff. Effort: MEDIUM.
6. **Machine-readable task workspace alongside the prose state vector** (Working Memory + PLAN-16). MEMORY.md is global prose; prime-agent keeps variables/artifacts/handles as durable machine state. Borrowable #3 from section 6, now grounded: per-task JSON workspace on the task store, surviving handoffs and compaction; MEMORY.md stays the global identity/relationship state. Effort: MEDIUM.

Not applicable to Area 1: fire-and-forget child agents. `deep_recall` is a synchronous recall tool; async children with message-based results only make sense if we extend RLM beyond recall onto the PLAN-16 handoff spine (borrowable #4).

### 9.3 What ours does better (keep, do not regress)

- **Security posture.** Their kernel is explicitly "a durable control environment, not a security sandbox." Our VM sandbox denies fs/network/process by design because we ship a desktop app running untrusted-adjacent skill code. A transplant would import their trust model onto our threat model.
- **Cost governance.** Our CostTracker (USD budget, sub-call caps, iteration caps, budget warnings fed back to the model) is more explicit than anything surfaced in their docs.
- **Self-correction hooks.** Blind-spot registration into the curiosity engine (failed recall becomes a targeted dream exploration) is a closed loop they do not have; hormonal weighting of state synthesis likewise.
- **The recall shortcut.** Quick hybrid search with client-side score filtering avoids spinning the REPL at all for easy queries; their architecture pays kernel overhead always.

### 9.4 Transplant verdict

A transplant means inverting the whole agent: persistent IPython kernel as the model's only tool, chat loop replaced by code composition, TS host relegated to lifecycle management. That would discard or force re-integration of the interceptor system, hormonal modulation, the recall-layer stack, and the PLAN-16/17 identification signals (which they don't have an equivalent of), while adopting a 3-day-old unproven trust model. Their own separation of concerns supports the incremental path: the RLM ideas that matter to us (live environment, persistent state, provenance, event-triggered preservation) are all adoptable inside our harness. Adopt the six upgrades above in roughly that order; re-evaluate the full-inversion question only if we later build acting (not just recalling) RLM children on the task spine and the conventional loop becomes the bottleneck.

### 9.5 Defects and drift found during this pass

- `docs/memory/deep-recall.md` documents sandbox APIs `search()`, `loadTranscript()`, `listSessions()` that do not exist in `sandbox.ts` (the sandbox has only text utilities over the snapshot). Either the docs anticipate upgrade #1 or they describe an earlier design; today they are wrong.
- Same doc says "up to 5 REPL iterations"; `DEFAULT_RLM_CONFIG.maxIterations` is 15.
- Same doc's model-routing table says the cheap sub-LLM writes the REPL code; in code the root/agent model writes code (matching the paper) and the cheap model only answers sub-queries.
- `executor.ts:114-153`: maxDepth branch is dead code (both branches make identical plain LLM calls).

## Sources

Primary: prime-agent repo + README + docs/rlm.md + docs/rlm-runtime.md; rlm-harness repo; prime-rl repo; verifiers repo; Prime Intellect blog (prime-agent, rlm); Prime Intellect docs (environments); arXiv 2512.24601 (abs/pdf/html v3); Zhang's RLM blog; alexzhang13/rlm repo; HuggingFace paper page; PrimeIntellect launch post on X.
Secondary: VentureBeat (MIT recursive framework), MarkTechPost (2 articles), ZenML LLMOps database, llmrumors.com.
Local: docs/plans/ PLAN-16, PLAN-17, PLAN-25, PLAN-34.
