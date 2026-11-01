# Working Memory — RLM State Vector & Scratch Buffer

The Working Memory system evolves MEMORY.md from a static file into a **Recursive Language Model (RLM) state vector** — a living document maintained by the dream engine that captures who the user is, what's happening now, and where to find deep memories. Between dream cycles, the agent writes urgent notes to a **scratch buffer** (Write-Ahead Log) so nothing is lost.

**Key source files:** `working-memory-prompt.ts`, `seed-crystal-migration.ts`, `working-memory-tool.ts`, `manager.ts` (rewriteWorkingMemory)

---

## Architecture

```
Session active:
  Agent → working_memory_note tool → memory/scratch.md (append)
  Bootstrap loader → reads MEMORY.md + scratch.md → system prompt

Dream cycle fires:
  Dream engine reads: Old MEMORY.md + scratch.md + new crystals + dream insights
  Dream engine writes: New MEMORY.md (RLM state update)
  Dream engine clears: scratch.md (consumed into state)
  Scratch content also persists as indexed crystals (lossless backup)
```

The key insight: MEMORY.md is not a summary — it's a **state vector**. Each dream cycle performs a state update:

```
New_State = f(Old_State + Scratch_Delta + New_Crystals + Dream_Insights)
```

This means the agent's working memory is:

- **Persistent** — survives across sessions
- **Self-updating** — the dream engine maintains it automatically
- **Lossless** — fading topics become Crystal Pointers, not deletions
- **Emotionally-grounded** — hormonal state weights what gets preserved

---

## Working Memory Schema

MEMORY.md follows a structured schema with 5 mandatory sections, kept under ~2K tokens:

```markdown
# Working Memory State

_Last dream: {timestamp} | Mood: {hormonal_description}_

## The Bond (Oxytocin-Weighted)

Enduring user traits, communication style, trust level, shared history.
Current emotional baseline.

## Active Context (Dopamine/Cortisol-Weighted)

Last 1-3 sessions, unresolved tasks, current goals.
Recent frictions (cortisol-tagged): explicit things to avoid.
Breakthroughs (dopamine-tagged): recent wins.

## Crystal Pointers (Deep Memory Awareness)

_Use memory_search if user asks about these topics:_

- Past: P2P bridge CORS debugging → search: `CORS P2P EigenTrust`
- Past: Workspace migration → search: `workspace migration WSL`

## Curiosity Gaps

Unresolved questions, knowledge gaps, things the agent wants to explore.

## Emerging Skills

_Patterns detected from repeated tasks. Pre-crystallization:_

- TypeScript refactoring → Confidence: 85% | Occurrences: 7
- SQLite schema design → Confidence: 72% | Occurrences: 4
```

### Section Weighting

The synthesis prompt carries a hormonal attention line for two sections (`buildHormonalAttentionBlock`); the others are driven by their own input blocks:

| Section          | Primary Hormone     | When Updated Aggressively                                                 |
| ---------------- | ------------------- | ------------------------------------------------------------------------- |
| The Bond         | Oxytocin            | High oxytocin → social bonding moments detected                           |
| Active Context   | Dopamine + Cortisol | High dopamine → breakthroughs; High cortisol → frictions                  |
| The Phenotype    | (anchors, Genome)   | Emotional History input block, Phenotype Guardrails, Starting Temperament |
| The Niche        | (network input)     | P2P Network Identity input block: peers, reputation, skills, economics    |
| Crystal Pointers | (decay-driven)      | Topics fading from Active Context → compressed to pointers                |
| Curiosity Gaps   | (curiosity engine)  | Updated from CuriosityEngine exploration targets                          |
| Emerging Skills  | (access patterns)   | Updated from repeated task patterns in crystal access counts              |

### The 7-Section Schema

The working memory state (MEMORY.md) contains 7 required sections:

1. **The Phenotype** — Agent's evolving self-concept (who am I becoming?)
2. **The Bond** — Theory of mind for the user (who is the user, how do we relate?)
3. **The Niche** — Ecosystem identity (P2P skills, reputation, economic performance)
4. **Active Context** — Recent sessions, goals, frictions, breakthroughs
5. **Crystal Pointers** — Compressed search directives for fading topics
6. **Curiosity Gaps** — Knowledge gaps and exploration targets
7. **Emerging Skills** — Pre-crystallization task patterns

### Catastrophic Collapse Guard

The `validateWorkingMemory()` function includes four collapse guards:

- **Mass drop:** Rejects synthesis if new state is <50% the length of a mature (>=2000 char) previous state
- **Eviction runaway:** Rejects if >20 crystal pointers (`MAX_CRYSTAL_POINTERS`; LLM over-evicting active topics)
- **Empty synthesis:** Rejects if all section headers present but <50 chars of substance
- **Bond drift:** Rejects if the new Bond retains <30% of the previous Bond's terms (warning between 30% and 50%); see [User Knowledge](./user-knowledge.md) for the ratio

An eviction-runaway result gets one bounded repair attempt (`synthesizeValidatedWorkingMemory`): the model is asked to merge the pointer list down, the repaired state is re-validated against the same previous state, and only then does the caller fall back to the heuristic builder.

### Snapshots, Provenance, and Rollback

Every rewrite of MEMORY.md is **evidence-backed and reversible** (`working-memory-snapshots.ts`):

- **Snapshot before overwrite:** the previous state is saved to `memory/memory-snapshots/MEMORY-<timestamp>.md` (last 10 kept) before the new state is written.
- **Output cap matches the prompt (token-efficiency pass 2026-09-19):** the synthesis prompt asks for up to ~4,500 output tokens across 7 sections, but the synthesis lane inherited the 2,048-token default of `buildLlmCallFn`, so every call ended at `stop_reason=length`, failed section validation and fell back to the heuristic builder (100% of synthesis spend wasted). The lane now uses `memory.dream.synthesisMaxTokens` (default 6144).
- **Heuristic builder is idempotent:** the fallback used to carry each section over WITH its italic sub-header and then prepend its own, so every heuristic rewrite added one more `*Who am I becoming?*` line (the live MEMORY.md reached 21 copies, injected into every prompt). `stripSectionSubheaders` now removes every sub-header line from a carried section; running the builder on its own output produces byte-identical section bodies, and an already-polluted file is repaired on the next rewrite.
- **Provenance record:** each rewrite appends a JSONL record to `memory/memory-snapshots/provenance.jsonl` — trigger (dream cycle id, `first-breath-*`, or `event-<reason>`), synthesis model, whether the heuristic fallback fired, the validation outcome (collapsed/valid/warnings/bond drift), and before/after lengths. Provenance survives snapshot pruning.
- **Rollback:** `manager.restoreWorkingMemory(fileName?)` restores a snapshot (latest by default). The bad state is snapshotted first, so a restore is itself reversible. `manager.listWorkingMemorySnapshots()` and `manager.getWorkingMemoryProvenance()` expose the history.

### Event-Triggered Synthesis

Besides the dream tick, a synthesis fires at moments of **context pressure** via `manager.flushWorkingMemory(reason)`:

- **After compaction** — context was just discarded; unsynthesized scratch notes are folded into MEMORY.md immediately.
- **On session end** — when a session key is replaced by a new session.

The flush is a no-op when the scratch WAL has no pending notes, and is debounced (10 min) so hook storms can't thrash MEMORY.md. Callers: the compaction handlers (`embedded-subscribe.handlers.compaction.ts`, `embedded-runner/compact.ts`) with reason `compaction`, and the gateway `sessions` RPC and the auto-reply session manager with reason `session-end`.

### Canonical Ledger and Owner Sections

Two further inputs shape every rewrite (`working-memory-canonical.ts`, PLAN-55):

- **Ledger keys in the prompt.** The rewrite receives the active canonical facts (`key = value`) and the recent supersedes and owner retires (`key: old -> new`), with the instruction that the ledger wins and an old value is never restated as current. Without this the rewrite kept repeating whatever MEMORY.md said before a correction.
- **Owner sections.** Text the owner wraps in `<!-- owner -->` ... `<!-- /owner -->` (an optional label after the colon, `<!-- owner:label -->`) is preserved verbatim: the prompt says so and `preserveOwnerSections()` enforces it on the output, restoring a block the model dropped or altered to the section it came from and removing owner markers the model invented. Only the owner writes these markers; the MEMORY.md read right before the rewrite is the source of truth.

### Economic Data in The Niche

The Niche section receives economic data from the MarketplaceEconomics system:

- Total earnings and spending in USDC
- Listed skill count and unique buyer count
- Top earning skills and 7-day earnings trend
- This data is injected into the synthesis prompt as an input block

---

## Crystal Pointers

When a topic decays in relevance, instead of deleting it, the RLM converts it to a **pointer** — a one-line search directive:

```
Before (burns tokens):
  "We spent 3 hours debugging a CORS error on the P2P bridge.
   Tried disabling headers, switching to WebSocket, checking nginx config.
   Fixed by tweaking EigenTrust peer scoring thresholds."

After (Crystal Pointer):
  Past: P2P bridge CORS debugging → search: `CORS P2P EigenTrust`
```

The agent reads the pointer in its prompt. If the user asks about it, the agent fires `memory_search` with those keywords, pulling lossless crystals back into working context.

**Result:** Infinite memory, finite tokens.

---

## Scratch Buffer (Write-Ahead Log)

### The Problem

The agent is a stateless LLM. If it learns something important mid-session (a name, a deadline, a preference) but the next full dream cycle may be hours away (full cycles run at most every 8 hours) and the session might end, that information is lost. This creates trust-destroying amnesia.

### The Solution

Two-file architecture:

| File                | Writer                                                         | Reader                          | Purpose                          |
| ------------------- | -------------------------------------------------------------- | ------------------------------- | -------------------------------- |
| `memory/scratch.md` | Agent (via `working_memory_note` tool) + Hormonal auto-scratch | Bootstrap loader + Dream engine | Write-ahead log for urgent notes |
| `MEMORY.md`         | Dream engine only                                              | Bootstrap loader + Agent        | Committed state vector           |

The agent appends timestamped notes to `scratch.md` during sessions:

```markdown
# Scratch Buffer (Working Memory WAL)

- [2026-03-12T14:30:00Z] (importance: 0.8) User's name is Douglas, prefers tabs over spaces
- [2026-03-12T14:45:00Z] (importance: 0.7) Project deadline is March 20th for the API migration
- [2026-03-12T15:10:00Z] (importance: 0.9) User explicitly asked to never use semicolons in JS
```

On session start, the bootstrap loader injects BOTH files into the system prompt:

- MEMORY.md as committed state
- scratch.md as "Unsynthesized Notes (pending dream consolidation)"

When the next dream cycle fires, scratch notes are:

1. Incorporated into the RLM state update of MEMORY.md
2. Indexed as crystals (lossless backup)
3. Cleared from scratch.md

### Belt AND Suspenders: Auto-Scratch from Hormonal Spikes

Even if the agent forgets to call `working_memory_note`, the hormonal system provides backup. During each consolidation cycle (every 30 min), if a hormone has risen by 0.15 or more since the last check (`hormonalTriggerDelta`), an automatic scratch note is generated (deduplicated against the previous automatic note):

```markdown
- [2026-03-12T15:30:00Z] (importance: 0.8) [AUTO] Hormonal event: dopamine spike
  (achievement/breakthrough detected). User seems energized after solving the build issue.
```

This ensures high-valence moments are captured even when the agent doesn't explicitly note them.

---

## Seed Crystal Migration

When the working memory system is first activated on an existing workspace, the user's hand-written MEMORY.md content must survive. The seed migration:

1. Checks if migration has already run (flag in `meta` table)
2. Reads existing MEMORY.md
3. Creates a backup at `MEMORY.md.seed-backup`
4. Chunks the content (400 tokens, 80 overlap)
5. Inserts chunks as crystals with `importance_score: 0.75`, `lifecycle: "consolidated"`
6. Marks migration complete

Crystals are inserted as `consolidated` (not `frozen`) so the natural lifecycle handles them — the dream engine will promote truly enduring content and let stale content decay gracefully.

### Transition UX

The first dream cycle after migration is **conservative**: it appends a `## Dream-Generated` section below the existing MEMORY.md content rather than rewriting the whole file. Subsequent cycles gradually take over as the working memory schema fills in naturally.

```markdown
# My existing MEMORY.md content

...user's original content...

---

<!-- Dream-generated working memory follows. Subsequent dream cycles will
     gradually integrate the above content. -->

# Working Memory State

_Last dream: 2026-03-12T16:00:00Z | Mood: motivated, socially engaged_

## The Bond (Oxytocin-Weighted)

...
```

---

## Tools

### working_memory_note

The agent's primary interface for persisting observations:

```typescript
// Schema
{
  note: string,          // The observation to persist
  importance?: number,   // 0-1, default 0.7
  type?: "experience" | "directive" | "world_fact" | "mental_model"  // epistemic type
}
```

**What it does:**

1. Appends a timestamped entry to `memory/scratch.md`
2. Creates an immediate crystal for searchability (so memory_search can find it before the next dream cycle); `type` sets the crystal's semantic type and epistemic layer (experience → episode, directive → preference, world_fact → fact, mental_model → insight)
3. Routes a `directive` note into the `user_preferences` table as well (`upsertFromDirective`, confidence = importance)
4. Returns confirmation with timestamp and crystal status

**When to use it** (from system prompt guidance):

- User shares something important about themselves
- Key decisions made that should survive across sessions
- User preferences or corrections
- Significant emotional moments
- Deadlines, names, or specific facts
- User explicitly asks to remember something

### memory_search

Existing tool — now enhanced by Crystal Pointers. When MEMORY.md contains a pointer like:

```
Past: P2P bridge CORS debugging → search: `CORS P2P EigenTrust`
```

The agent uses `memory_search` with those keywords to pull full crystal content back into context.

---

## Adaptive Bootstrap Sizing

MEMORY.md token budget scales based on model context window to work across different deployments:

| Context Window | MEMORY.md Budget (chars) | ~Tokens |
| -------------- | ------------------------ | ------- |
| 200K+          | 8,000                    | ~2,000  |
| 128K           | 6,000                    | ~1,500  |
| 64K            | 4,000                    | ~1,000  |
| 32K            | 3,200                    | ~800    |

If MEMORY.md exceeds its budget, it's truncated with a constant note, `(truncated, use memory tools)`, so the injected text never carries a changing character count into the cached prompt prefix.

---

## Configuration

The working memory system activates automatically when the memory system and dream engine are enabled. No additional configuration is needed.

Relevant existing config keys:

```json5
{
  memory: {
    dream: {
      enabled: true, // Must be true for RLM state updates
      intervalMinutes: 120, // Dream tick frequency
      minHoursBetween: 8, // Full cycles at most this often
      minChunksForDream: 5, // Lowered from 20 — activates in first session
      hormonalTriggerDelta: 0.15, // Rise that fires auto-scratch and mini-dreams
      synthesisMaxTokens: 6144, // Output cap for the synthesis call
    },
  },
  agents: {
    defaults: {
      memorySearch: {
        sources: ["memory", "sessions"], // Sessions indexed by default
        experimental: {
          sessionMemory: true, // Runtime default is true (the type comment still says false)
        },
      },
    },
  },
}
```

Session indexing is configured under `agents.defaults.memorySearch`, not under `memory`; there is no `memory.search` key.

---

## Data Flow Diagram

```mermaid
flowchart TD
    User([User Message]) --> Agent
    Agent -->|"working_memory_note"| Scratch["memory/scratch.md<br/>(Write-Ahead Log)"]
    Agent -->|"memory_search"| Crystals[(Knowledge Crystals)]

    subgraph Bootstrap ["Session Start"]
        MEMORY["MEMORY.md<br/>(Committed State)"] --> Prompt[System Prompt]
        Scratch --> Prompt
    end

    subgraph Dream ["Dream Cycle (full cycle at most every 8 h)"]
        MEMORY --> RLM["RLM State Update<br/>f(Old + Scratch + Crystals + Insights)"]
        Scratch --> RLM
        Crystals --> RLM
        Insights["Dream Insights"] --> RLM
        Hormones["Hormonal Weights"] --> RLM
        Curiosity["Curiosity Targets"] --> RLM
        Skills["Emerging Skills"] --> RLM
        RLM -->|"Write"| MEMORY_NEW["New MEMORY.md"]
        RLM -->|"Index + Clear"| Scratch_Clear["scratch.md (cleared)"]
    end

    subgraph Consolidation ["Consolidation (every 30min)"]
        HormCheck{"Hormone rose by 0.15+?"} -->|Yes| AutoScratch["Auto-scratch note"]
        AutoScratch --> Scratch
    end
```

---

## Credits

| Concept                                                            | Origin      |
| ------------------------------------------------------------------ | ----------- |
| Crystal Pointers (semantic eviction → search directives)           | Gemini      |
| Scratch Buffer WAL (write-ahead log for inter-session persistence) | BitterBot   |
| Emerging Skills section in working memory schema                   | BitterBot   |
| Hormone-weighted attention mechanism in synthesis prompt           | Gemini      |
| RLM state update equation (New = f(Old + Delta))                   | Gemini      |
| Three-tier architecture + phased rollout                           | Claude Code |
| Auto-scratch from hormonal spikes (belt AND suspenders)            | BitterBot   |
| Conservative first-cycle transition UX                             | BitterBot   |
| Vision and requirements                                            | Vic         |
