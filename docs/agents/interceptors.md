# Pre-Action Interceptors (PLAN-20)

Executable skill interceptors turn passive markdown skills into deterministic behavioral guardrails. When the agent proposes a tool call, registered interceptors inspect the action, read the agent's current state (hormonal, GCCRF, channel, recent turns), and may modify, inject context into, require a prerequisite for, or block the call before it executes.

This is the most important change to the skill system since PLAN-15. Where SICA gave us a staging gate for skill _mutations_, PLAN-20 gives us deterministic enforcement of skill _behavior_ at runtime.

## Why this exists

Bitterbot ships dozens of SKILL.md files. Each one is a piece of prose telling the agent how to behave. The LLM may or may not follow that prose on any given turn. Concrete daily losses we observed:

- Citation rate on factual claims is ~40% despite the explicit `cite-sources` skill being loaded
- Group-channel etiquette degrades under high engagement; the agent over-talks
- Memory-tool selection drifts; relationship-shaped questions hit vector search and miss
- Calibrated confidence (matching tone to actual epistemic state) is best-effort

Each of these is the same shape: skill says "do X under Y condition" → LLM mostly remembers → fails sometimes. PLAN-20 fixes "mostly" with deterministic dispatch driven by a typed activation predicate.

The conceptual lineage is the HASP paper ([arXiv:2605.17734](https://arxiv.org/abs/2605.17734), May 2026), which reports ~25-30% task-completion lifts from doing exactly this. Bitterbot's contribution is binding the activation predicate to the agent's neuromodulatory + epistemic state, which no other framework can do.

## Architecture

```
                         ┌─────────────────────────────┐
                         │  Built-in interceptors      │
                         │  src/agents/skills/         │
                         │   builtin-interceptors/     │
                         └──────────────┬──────────────┘
                                        │ register at autoboot
                                        ▼
   Agent proposes a tool call ──► runBeforeToolCallHook ──► tool executes
                                        │
                                        ▼
                              ┌───────────────────────┐
                              │   InterceptorRunner   │
                              │  - priority sort      │
                              │  - latency budget     │
                              │  - per-episode caps   │
                              │  - 3-strikes disable  │
                              └──────────┬────────────┘
                                         │
                ┌────────────────────────┼─────────────────────────┐
                │                        │                         │
       shouldActivate(ctx)      intervene(ctx, action)       persist + emit
                │                        │                         │
                ▼                        ▼                         ▼
        StepContext built from   modify / inject /        InterventionRecord
        session-context-tracker  require_prereq / block   (Ed25519-signed)
        + hormonal + GCCRF       / noop                   → sqlite v14
```

### Files

| Module                               | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `interceptor.ts`                     | `PreActionInterceptor` interface + intervention types |
| `interceptor-registry.ts`            | In-memory registry keyed by id, priority-ordered      |
| `interceptor-runner.ts`              | Driver invoked from `runBeforeToolCallHook`           |
| `interceptor-context.ts`             | Late-bound provider table for hormonal/GCCRF/etc.     |
| `interceptor-bootstrap.ts`           | Wires providers + signer + store                      |
| `interceptor-autoboot.ts`            | Self-initialising bootstrap on first call             |
| `session-context-tracker.ts`         | Per-session ring of turns + tool history              |
| `state-snapshots.ts`                 | Builds `HormonalSnapshot` and `GCCRFSnapshot`         |
| `intervention-record.ts`             | Record type + Ed25519 signer hook                     |
| `intervention-store.ts`              | SQLite-backed append-only store                       |
| `outcome-backfill.ts`                | Heuristic outcome-signal patcher (1-3 turns later)    |
| `builtin-interceptors/*.ts`          | The 4 reference interceptors that ship in-tree        |
| `dream-modes/interceptor-harvest.ts` | Dream-cycle mode that proposes new interceptors       |

### Built-in interceptors

| Skill / id                           | Activates on                                                                                             | Effect                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `recall-before-claim:default`        | `send_message`-shape tool with a factual-assertion draft + no memory tool fired this turn                | `require_prereq` of `memory_search` for the assertion's subject |
| `route-by-query-shape:relationship`  | `memory_search` with a relationship-shaped query (`who / talked / met / worked`)                         | `require_prereq` of `deep_recall` with the extracted entity     |
| `protocol-quiet-in-groups:default`   | Group channel (`discord` / `telegram` / `slack` / ...) + no @mention + recently spoke                    | `block` — silent suppression of the outbound message            |
| `calibrate-claim-confidence:default` | Confident absolute (`definitely / always / 100%`) in draft + low `gccrf.empowerment` + falling certainty | `modify` — hedges absolutes to probabilistic language           |

## Intervention types

Five values for the `Intervention.type` field:

- **`noop`** — interceptor inspected but had nothing to say. No record persisted.
- **`modify`** — replace the action params (e.g. rewrite outbound text, change tool args).
- **`inject`** — add corrective context to the next turn without changing the tool call.
- **`require_prereq`** — direct the agent to call a different tool first, then re-evaluate. Surfaces to the agent as a structured `INTERCEPTOR:` directive (see "Agent self-awareness" below).
- **`block`** — refuse the action. Optionally include a `userVisibleMessage`.

A Bitterbot-specific addition over HASP is `require_prereq`: it lets a skill express "before doing X, do Y" without rewriting X's params.

## Agent self-awareness

The agent's system prompt (`src/agents/system-prompt.ts`) explains the interceptor layer directly. When the agent receives a tool error starting with `INTERCEPTOR:`, it reads the structured directive — tool name, args, reason — and follows it without commentary. When a `modify` intervention rewrites params silently, the agent observes the rewrite but does not reverse it.

Operators see all firings live in the **Active Guards** tab (sidebar > Agent group) and can call `guards.status` over the gateway WebSocket RPC.

## StepContext shape

```ts
interface StepContext {
  sessionKey: string;
  agentId: string;
  channel: ChannelKind; // discord | telegram | ... | internal
  turnNumber: number;
  hormonal: HormonalSnapshot; // dopamine/cortisol/oxytocin + 8-dim response
  gccrf: GCCRFSnapshot; // η, Δη, Iα, E·μ, S, certaintyDelta
  recentTurns: ReadonlyArray<{ role; preview }>; // PII-redacted, ≤80 chars
  toolHistory: ReadonlyArray<{ tool; success; tsDelta }>;
  draftReply?: string; // auto-extracted from message-shape params
  activeTask?: { id; lastJournalReadAt };
}
```

State is sampled once per agent step and shared across all interceptors evaluating that step.

## Intervention records

Every non-NOOP firing produces a structured `InterventionRecord` persisted into the `intervention_records` table (SQLite migration v14):

```sql
CREATE TABLE intervention_records (
  id                      TEXT PRIMARY KEY,
  ts                      INTEGER,
  session_key             TEXT,
  skill                   TEXT,
  interceptor_id          TEXT,
  channel                 TEXT,
  tool_name               TEXT,
  intervention_type       TEXT,
  action_original_json    TEXT,
  action_final_json       TEXT,
  intervention_json       TEXT,
  state_summary_json      TEXT,
  activation_latency_ms   REAL,
  intervention_latency_ms REAL,
  outcome_tag             TEXT,         -- patched 1-3 turns later
  outcome_evidence        TEXT,
  ed25519_sig             TEXT,
  pubkey_id               TEXT,
  record_json             TEXT          -- canonical signed form
);
```

Aggregation view `skill_interceptor_stats` rolls up per `(skill, interceptor_id)`: fire count, success count, failure count, user-confirmed-block count, user-overrode-block count, average latency, time bounds.

Records are Ed25519-signed at write time using the persistent device identity. The signed canonical form is portable: another node receiving this skill's outcome statistics can verify the seller's claims without trusting the seller.

## Outcome signal backfill

After an intervention fires, the system watches the user's next 1-3 turns and infers an outcome tag heuristically:

| User reaction                                     | Tag                                 |
| ------------------------------------------------- | ----------------------------------- |
| "thanks", "perfect", "exactly", "yes"             | `downstream-success`                |
| "wrong", "no", "try again", "huh"                 | `downstream-failure`                |
| "yes do it", "confirm", "proceed" (after a block) | `user-overrode-block`               |
| "cancel", "don't", "stop" (after a block)         | `user-confirmed-block`              |
| nothing distinct                                  | record remains `NULL` → `no-signal` |

This signal is what the harvest mode learns from. Without it, the agent can't tell which interceptors are pulling weight.

## Dream-cycle harvest

The Dream Engine's new `interceptor_harvest` mode (registered in `dream-types.ts` alongside the existing seven modes) runs once per 2-hour deep cycle:

1. Pull the last 7 days of `intervention_records` plus shadow records (tool calls with no interceptor + a negative outcome).
2. Cluster by `(tool, channel, hormonal-band, param-shape)`.
3. For each cluster with ≥3 records and ≥40% negative-outcome rate, propose a candidate interceptor.
4. If an LLM synthesizer is available, refine the proposal; otherwise emit a heuristic specification.
5. Persist as a `DreamInsight` of mode `interceptor_harvest`. The Active Guards UI can surface these for one-click SICA-staged promotion.

This closes the self-improvement loop: the agent's own observed competence gaps compile into new deterministic guards overnight.

## Marketplace tier

`SKILL.md` frontmatter now supports a `tier` field:

```yaml
---
name: recall-before-claim
description: ...
tier: executable # | advisory | data
bitterbot:
  interceptors:
    - id: recall-before-claim:default
      builtin: true
---
```

The marketplace can surface aggregated, signed activation/outcome statistics for executable-tier skills. Mesh-acquired interceptors are stored and displayed but **not instantiated** in the runtime until the capability sandbox lands (issue #21).

## Authoring a new local interceptor

Today, the recommended path is to add a TypeScript implementation under `src/agents/skills/builtin-interceptors/` and register it from `builtin-interceptors/index.ts`. The interceptor and its SKILL.md docs ship together. User-authored interceptor `.ts` files loaded from `skills/<name>/interceptor.ts` are reserved for the capability-sandbox milestone.

A minimal interceptor:

```ts
import type { PreActionInterceptor } from "../interceptor.js";

export const myGuard: PreActionInterceptor = {
  id: "my-skill:default",
  skill: "my-skill",
  priority: 50,
  maxFiresPerEpisode: 4,
  tools: ["send_message", "discord_send"],
  shouldActivate(ctx, action) {
    return ctx.hormonal.cortisol > 0.6;
  },
  intervene(ctx, action) {
    return {
      type: "inject",
      contextText: "Cortisol is high. Be brief.",
      reason: "stress-mode brevity",
    };
  },
};
```

## Operator surfaces

- **UI**: sidebar → Active Guards → registered list, live feed, persisted records
- **RPC**: `guards.status` returns `{ registered, stats, recent }`
- **WS event**: every firing emits `intervention.fired` with `{ id, ts, skill, interceptorId, toolName, intervention, latencyMs }`

## Limits and known gaps

- Mesh-acquired interceptors never execute (gated on #21)
- LLM-driven harvest synthesis only runs when a synthesizer is configured
- Block-type interventions surface as a generic tool error until a structured user-prompt UX is built
- Auto-harvested candidates need one-click "promote to staging" in the UI (currently they live as DreamInsights)

## Related

- [Author guide](interceptors-author-guide.md) — write a new interceptor end-to-end
- [Operator runbook](interceptors-runbook.md) — observe, disable, promote, troubleshoot
- [Troubleshooting](interceptors-troubleshooting.md) — quick FAQ
- PLAN-20 design document: `research/plans/PLAN-20-EXECUTABLE-SKILL-INTERCEPTORS.md`
- PLAN-15 (SICA staging gate): the promotion path for auto-harvested skills
- Issue #21 (capability sandbox): the gate on mesh-PF execution
- HASP paper: arXiv:2605.17734
