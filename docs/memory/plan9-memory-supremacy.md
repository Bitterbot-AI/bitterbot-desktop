# PLAN-9: Memory Enhancement — Neuroscience Mechanisms

This page is the reference for the nine neuroscience-inspired mechanisms PLAN-9 added to the memory system. All nine landed in July 2026 and are live today: reconsolidation, spacing effect, Zeigarnik persistence, prospective memory, synaptic tagging, active inference (epistemic directives), mood-congruent retrieval, somatic markers, and a general-purpose knowledge graph with temporal validity. The per-mechanism sections below describe current behaviour and were re-checked against the code on 2026-11-01; the competitive table at the end is kept as written at the time of the plan.

**Migration:** v9 in `src/memory/migrations.ts` (the `status` column on `epistemic_directives` came later, in v34)

---

## 1. Knowledge Graph (GAP-1 + GAP-2)

**File:** `src/memory/knowledge-graph.ts`  
**Class:** `KnowledgeGraphManager`

### What It Does

A general-purpose entity-relationship graph stored in SQLite. Entities (people, projects, concepts, tools) are extracted from session transcripts and connected via typed, temporally-valid relationships.

Previously, Bitterbot had only `skill_edges` for skill-to-skill relationships. The knowledge graph extends this to all entities mentioned in conversations.

### Schema

```sql
-- Entities: people, projects, concepts, tools, etc.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- person, project, concept, tool, organization, location, file, service, event
  properties TEXT DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  mention_count INTEGER DEFAULT 1,
  importance REAL DEFAULT 0.5,
  UNIQUE(name, entity_type)
);

-- Relationships with temporal validity (Zep-style)
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES entities(id),
  target_entity_id TEXT NOT NULL REFERENCES entities(id),
  relation_type TEXT NOT NULL,  -- works_on, manages, depends_on, uses, contradicts, etc.
  weight REAL DEFAULT 1.0,
  valid_from INTEGER,           -- When this fact became true
  valid_until INTEGER,          -- NULL = still current
  evidence_chunk_ids TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Temporal Reasoning (GAP-2)

The `valid_from` / `valid_until` fields enable temporal queries:

```typescript
// "Who was the project lead in January?"
const results = kg.queryAtTime("project-x", "project", "manages", januaryTimestamp);

// "Who leads it now?" (valid_until IS NULL)
const current = kg.traverseEntity(entityId, true /* currentOnly */);
```

When new information supersedes old (e.g., "Bob is now the lead, not Alice"), the old relationship gets `valid_until` set and a new one is created. Both versions remain queryable.

### Graph-Enhanced Retrieval

The knowledge graph acts as a 3rd retrieval modality alongside vector + BM25. `graphSearch()` implements the original design (extract entities from the query, traverse, rank evidence chunks by weight x importance). In the live search path the `graph` channel of `hybrid.ts` is fed by the PLAN-18 graph reader (`graph-reader.ts`) and RRF-fused with the vector and keyword lists; it is enabled whenever hybrid search is on and a knowledge graph exists.

### Dream Integration

During maintenance cycles:

- **Prune** relationships not reinforced with new evidence in 30+ days (low weight), `pruneStaleRelationships(staleDays = 30)`, step 13 of the cycle
- **Merge** happens at write time only: `upsertEntity()` merges properties into an existing entity with the same name and type, and `upsertRelationship()` merges evidence. There is no separate duplicate-entity sweep.
- **Detect contradictions** for epistemic directive generation (`EpistemicDirectiveEngine.detectContradictions()`, step 14)

### Key Methods

| Method                      | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `upsertEntity()`            | Create or merge an entity by name+type                          |
| `upsertRelationship()`      | Create or update a relationship, merging evidence               |
| `supersedeRelationship()`   | Close old relationship, optionally create new one               |
| `traverseEntity()`          | Get all relationships for an entity (both directions)           |
| `graphSearch()`             | Extract entities from query, traverse, return ranked results    |
| `queryAtTime()`             | Temporal query: who/what held a relationship at a specific time |
| `ingestExtraction()`        | Batch ingest entities + relationships from session extraction   |
| `pruneStaleRelationships()` | Close low-weight relationships not reinforced recently          |

---

## 2. Memory Reconsolidation (GAP-5)

**File:** `src/memory/reconsolidation.ts`  
**Class:** `ReconsolidationEngine`

### Scientific Basis

When a consolidated memory is recalled, it enters a temporary "labile" state (~30 minutes) where it can be updated, strengthened, or erased. After the window closes, the memory restabilizes — potentially stronger.

**Reference:** Nader, Schafe & LeDoux (2000). Fear memories require protein synthesis for reconsolidation. _Nature_, 406.

### How It Works

```
Chunk retrieved during search
  → markLabile(chunkId)           # labile_until = now + 30min
  → During labile window:
    → User confirms/uses info     → strengthen()    # +0.05 importance
    → User contradicts info       → flagContradiction()  # queued for dream review
    → No interaction              → (window expires)
  → After expiry:
    → restabilizeExpired()        # +0.02 importance (recalled = valuable)
```

### Integration Points

- **Search:** `trackSearchHits()` in `manager.ts` calls `markLabile()` for every retrieved chunk
- **Consolidation:** `restabilizeExpired()` runs during each consolidation interval
- **Contradiction:** Flagged chunks get `open_loop=1` and `open_loop_context` set for dream review

### Columns Added to `chunks`

| Column                  | Type    | Purpose                                           |
| ----------------------- | ------- | ------------------------------------------------- |
| `labile_until`          | INTEGER | Timestamp when labile window expires              |
| `reconsolidation_count` | INTEGER | How many times this chunk has been reconsolidated |

---

## 3. Mood-Congruent Retrieval (GAP-6)

**File:** `src/memory/mood-congruent-boost.ts`  
**Function:** `moodCongruentBonus()`

### Scientific Basis

Current emotional state biases which memories are recalled. Happy people recall happy memories; stressed people recall threats.

**Reference:** Bower, G.H. (1981). Mood and memory. _American Psychologist_, 36(2).

### How It Works

Applied in the search pipeline after RRF fusion, before final ranking:

| Hormone        | Threshold                                | Boost weight                          |
| -------------- | ---------------------------------------- | ------------------------------------- |
| Dopamine > 0.4 | Positive-valence memories                | `dopamineWeight * valence * dopamine` |
| Cortisol > 0.4 | Task/goal/directive/skill memories       | `cortisolWeight * cortisol`           |
| Oxytocin > 0.4 | Relationship/preference/episode memories | `oxytocinWeight * oxytocin`           |

Maximum bonus per result: 0.15 (prevents emotional spiraling).

### Bidirectional Loop

Combined with the existing limbic bridge (search results stimulate hormones), this creates a complete emotion-memory feedback loop:

```
Emotional state → retrieval bias (this module)
  → emotional memories surfaced
    → limbic bridge stimulates hormones (hormonal.ts)
      → emotional state changes
        → retrieval bias shifts...
```

The feedback is self-limiting: the `maxBonus` cap and the limbic bridge's mild spike magnitudes prevent runaway spirals.

---

## 4. Spacing Effect (GAP-7)

**File:** `src/memory/spacing-effect.ts`

### Scientific Basis

Spaced repetition produces stronger retention than massed repetition. Accessing a memory 5 times in one session should get less boost than accessing it once per week for 5 weeks.

**Reference:** Cepeda, N.J. et al. (2008). Spacing effects in learning. _Psychological Science_, 19(11).

### How It Works

```typescript
// On each access, record timestamp
recordAccess(db, chunkId);

// Spacing score computed from inter-access intervals:
// score = log(avg_interval_hours + 1) / log(max_interval + 1)
// Normalized [0, 1]. Higher = more spaced.

// Applied during consolidation:
// importance *= (1 + 0.3 * spacingScore)
// Spaced access gets up to 30% importance boost over massed access
```

### Columns Added to `chunks`

| Column              | Type              | Purpose                       |
| ------------------- | ----------------- | ----------------------------- |
| `access_timestamps` | TEXT (JSON array) | Last 20 access timestamps     |
| `spacing_score`     | REAL              | Computed spacing score [0, 1] |

### Integration Points

- **Search:** `trackSearchHits()` calls `recordAccess()` for every hit
- **Consolidation:** `scoreChunks()` applies `spacingImportanceMultiplier()` to importance

---

## 5. Zeigarnik Effect (GAP-8)

**File:** `src/memory/zeigarnik-effect.ts`

### Scientific Basis

Unfinished tasks are remembered better than completed ones. The human brain keeps "open loops" active until closure.

**Reference:** Zeigarnik, B. (1927). Das Behalten erledigter und unerledigter Handlungen.

### How It Works

**Detection:** `scanForOpenLoops()` runs over newly extracted fact chunks during session extraction. The patterns (`OPEN_LOOP_PATTERNS`):

- A deferral word ("todo", "need to", "have to", "should", "must") followed in the same text by "later", "tomorrow", "next", "soon" or "eventually"
- "working on", "started", "in progress", "wip"
- "not sure", "don't know", "unclear", "confused about", "need to figure out"
- An error word ("bug", "error", "issue", "broken", "failing", "crashed") followed by "still", "remains", "unresolved" or "unfixed"
- "will do", "gonna", "going to", "plan to"
- "remind me", "don't forget", "remember to"
- Unanswered questions (a line ending with `?`)

**Persistence:** Open loop chunks get:

- `open_loop = 1` flag
- `open_loop_context` with surrounding text
- **Decay resistance** — score never drops below `forgetThreshold * 2`

**Proactive Surfacing:** Up to two active open loops (`getActiveOpenLoops(db, 2)`) appear in proactive recall:

> "Unfinished: you were working on the Docker port conflict and hadn't resolved it"

**Resolution:** When resolution patterns are detected ("done", "fixed", "resolved"), the open loop flag is cleared and normal decay resumes.

### Columns Added to `chunks`

| Column              | Type    | Purpose                                  |
| ------------------- | ------- | ---------------------------------------- |
| `open_loop`         | INTEGER | 1 if this is an unfinished task/question |
| `open_loop_context` | TEXT    | Context snippet describing the open loop |

---

## 6. Prospective Memory (GAP-9)

**File:** `src/memory/prospective-memory.ts`  
**Class:** `ProspectiveMemoryEngine`

### Scientific Basis

"Remember to do X when Y happens." Event-triggered future memory that transforms the agent from reactive to proactive.

**Reference:** McDaniel, M.A. & Einstein, G.O. (2007). _Prospective memory_. Sage.

### How It Works

```
User: "Remind me to check the deploy when we discuss CI"
  → create({
      triggerCondition: "discuss CI",
      action: "Check the deploy status",
      triggerEmbedding: embed("discuss CI")
    })

Later, user mentions CI:
  → checkTriggers({ messageText: "let's review the CI pipeline..." })
  → Semantic match (cosine > 0.75) OR keyword match (60%+ words)
  → Memory triggered! Action injected into context.
```

`checkTriggers()` is called once per session from the session-start path (`src/agents/endocrine-state.ts`). Besides user requests, the dream engine writes prediction rows of its own (`source_session` prefixed `dream:`, 7-day TTL, at most 5 active, see `isDreamPredictionSource()`); those rows match semantically only and skip the keyword fallback.

### Schema

```sql
CREATE TABLE prospective_memories (
  id TEXT PRIMARY KEY,
  trigger_condition TEXT NOT NULL,
  trigger_embedding TEXT,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,       -- Default: 30 days TTL
  triggered_at INTEGER,     -- NULL until fired
  source_session TEXT,
  priority REAL DEFAULT 0.5
);
```

### Key Methods

| Method            | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `create()`        | Create a new prospective memory                                 |
| `checkTriggers()` | Match user message against active triggers (semantic + keyword) |
| `cleanExpired()`  | Delete expired un-triggered memories                            |

---

## 7. Synaptic Tagging & Capture (GAP-10)

**File:** `src/memory/synaptic-tagging.ts`  
**Function:** `captureNearbyWeakChunks()`

### Scientific Basis

When a strong memory event occurs, temporally-nearby weak memories get "captured" and consolidated alongside the strong one.

**Reference:** Frey, U. & Morris, R.G. (1997). Synaptic tagging and LTP. _Nature_, 385.

### How It Works

When a high-importance chunk is created (importance > 0.7):

1. Query chunks created within [-2h, +30min] of the strong chunk
2. For each weak chunk (importance < 0.4):
   - If cosine similarity to strong chunk > 0.5 → capture
   - Boost importance by 0.15
   - Set `captured_by` → strong chunk ID
   - Transfer 30% of the strong chunk's hormonal influence

### Column Added to `chunks`

| Column        | Type | Purpose                                       |
| ------------- | ---- | --------------------------------------------- |
| `captured_by` | TEXT | ID of the strong chunk that captured this one |

---

## 8. Active Inference / Epistemic Directives (GAP-11)

**File:** `src/memory/epistemic-directives.ts`  
**Class:** `EpistemicDirectiveEngine`

### Scientific Basis

Karl Friston's Free Energy Principle — organisms don't just passively measure surprise, they take action to minimize it. The agent actively asks the user to resolve contradictions and knowledge gaps.

**Reference:** Friston, K. (2010). The free-energy principle: a unified brain theory. _Nature Reviews Neuroscience_, 11(2).

### How It Works

During consolidation, the engine detects:

- **Contradictions** — Multiple active relationships of the same type between the same entities in the KG
- **Knowledge gaps** — High prediction error regions (from CuriosityEngine GCCRF)
- **Low confidence** — Entities with few evidence chunks
- **Stale facts** — Relationships not reinforced recently

For each detection, an epistemic directive is created:

> "I have conflicting info about whether the production DB is Postgres or MySQL. Can you clarify?"

Directives are injected into proactive recall and tracked until resolved; a user-answerable question stops being injected after `MAX_ASKS` (3) sessions (see Resolution below).

### Resolution (PLAN-34 Phase 1)

The loop closes through the session-extraction cycle (`src/memory/directive-resolution.ts`):

- **Fuel:** canonical-ledger conflicts (tier rejections, rapid same-key supersedes recorded by `pin()` into `canonical_conflicts`) sweep into `contradiction` questions — "Which is current for `<key>`?"
- **Injection accounting:** `attempts` increments only on real prompt injection, at most once per session key. User-answerable types (contradiction, knowledge_gap, low_confidence, stale_fact) stop injecting after `MAX_ASKS` (3) sessions; `graph_bridge` nudges are exempt (PLAN-18 preserved).
- **Answering:** the extractor receives the top 5 open questions (first-party sessions only), quotes the user's verbatim answer with line citations; the parser rejects unknown ids, paraphrases, and assistant-authored citations mechanically.
- **Two-tier resolution:** a qualifying answer (confidence >= 0.75) marks the question `answered` — it stops injecting immediately — and stores the answer as a `world_fact` crystal with evidence. Canonical-shaped answers route through the reconciler at extraction tier (>= 0.8 floor) as normal proposals subject to trust tiers, and are additionally **candidate-constrained**: the pinned value must exactly equal one of the two values the question adjudicated (the extractor's `selectedValue` mapping or the verbatim quote), so a mention, negation, deictic reply, or hallucinated string can never move the ledger. `resolved_at` is set only when the answer survives the NEXT extraction cycle uncontradicted; a contradicted answer flips terminal (`expired`) so a fresh conflict re-asks with a new question.
- **Expiry:** never-asked questions past 30 days are deleted; asked-but-unresolved ones flip to `status='expired'` (late answers still resolve them).
- **Funnel:** `memory_audit_log` rows (`directive_created` / `directive_injected` / `directive_answered` / `directive_resolved`) trace every step.

### Schema

```sql
CREATE TABLE epistemic_directives (
  id TEXT PRIMARY KEY,
  directive_type TEXT NOT NULL,  -- contradiction, knowledge_gap, low_confidence, stale_fact, graph_bridge
  question TEXT NOT NULL,
  context TEXT DEFAULT '',
  priority REAL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  source_entity_ids TEXT DEFAULT '[]',
  attempts INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'  -- v34: open | answered | expired
);
```

### Cross-Cutting Interactions

- **Zeigarnik:** Unresolved directives are inherently "open loops" — they nag until resolved
- **Prospective Memory:** High-priority directives could auto-generate prospective memories (not built)
- **Hormonal:** Resolving a directive does not fire a hormonal event today; `epistemic-directives.ts` and `directive-resolution.ts` write audit rows only. A dopamine spike on resolution was part of the plan and is not implemented.

---

## 9. Somatic Marker Fast-Pathing (GAP-12)

**File:** `src/memory/somatic-markers.ts`  
**Function:** `assessSomaticMarkers()`

### Scientific Basis

Damasio's somatic marker hypothesis — biological brains use emotional "gut feelings" to instantly rule out bad paths before expensive deliberation.

**Reference:** Damasio, A.R. (1994). _Descartes' Error_.

### How It Works

Before an expensive operation, query the aggregate emotional signature of chunks near the query. The only caller today is the `deep_recall` tool (`src/agents/tools/deep-recall-tool.ts`); the planned skill-execution hook was not built.

| Condition                                            | Verdict   | Effect                                                            |
| ---------------------------------------------------- | --------- | ----------------------------------------------------------------- |
| High cortisol (> 0.6) AND negative steering (< -0.3) | `caution` | Warning injected: "This region is associated with prior friction" |
| High dopamine (> 0.6) AND positive steering (> 0.5)  | `trusted` | Reduced validation overhead                                       |
| Otherwise                                            | `proceed` | Normal operation                                                  |

Uses existing `hormonal_cortisol`, `hormonal_dopamine`, and `steering_reward` columns — no new schema needed.

---

## Integration Map

### Maintenance Cycle (every 30 min)

The numbered steps follow the comments in `manager.ts`. Steps 12-15 were added by PLAN-9; the list has grown since and two of the original steps were retired:

```
 1. Hormonal decay
 2. Ebbinghaus consolidation + merge (with spacing & Zeigarnik modulation)
 2b. GC: purge expired/forgotten chunks past forgottenRetentionDays
 3. Curiosity engine (rebuild regions, detect gaps)
 3b-3d. Exploration targets as network queries; repeated and weak user queries become knowledge_gap targets
 4. Governance TTL enforcement
 5. Task memory stall detection
 6. Auto-scratch from hormonal spikes
 7. EigenTrust + anomaly detection
 7b-7d. Peer quality from execution outcomes; peer decay; quarantine TTL sweep
 8. (retired, PLAN-45 Phase 0) skill crystallization
 8b. Ground tool-level execution rows in their skills
 9. (removed) steering-reward decay now runs inside consolidation (Phase 5)
10. CuriosityEngine batch scoring (GCCRF pending chunks)
10b. Contributor standings from verified signals
11. Marketplace refresh
11b-11h. Sales notifications, revenue queue, bounty funding/settlement/payouts, deadlines, night shift, circles sweep
12. Reconsolidation: restabilize expired labile chunks     ← PLAN-9
13. Knowledge Graph: prune stale relationships              ← PLAN-9
14. Epistemic Directives: detect contradictions, expire old ← PLAN-9
15. Prospective Memory: clean expired                       ← PLAN-9
16. Dead-wire detector for retrieval layers
17. Canonical ledger decay
```

### Search Pipeline

```
Query → Embed
  → Vector search (cosine via sqlite-vec)
  → Keyword search (BM25 via FTS5)
  → RRF fusion (k=60)
  → Recency boost (cortisol-modulated)
  → Emotional retrieval boost (valence > 0.3)
  → Mood-Congruent Retrieval boost (hormonal state × semantic type)  ← NEW
  → Temporal scoring (query intent × epistemic half-lives)
  → Track hits:
    → access_count++
    → Spacing Effect: record access timestamp                         ← NEW
    → Reconsolidation: mark labile                                    ← NEW
  → Limbic Bridge: results affect hormones
```

### Session Start (once per session)

```
User sends first message
  → 1. Load latest handover brief
  → 2. Session Continuity Gate: cosine(message, brief.purpose)
       → Below 0.25: FRESH START — skip handover
       → Above 0.25: CONTINUATION — load brief with staleness annotation
  → 3. Entity snapshot available for anaphora resolution
  → 4. Prospective Memory: check trigger conditions
  → 5. Epistemic Directives: inject top-priority questions
```

### Proactive Recall (every turn)

```
User message arrives
  → 1. Identity preferences (always, no embedding)
  → 2. Vector-matched crystals (directive/world_fact/mental_model)
  → 3. Zeigarnik: surface active open loops                           ← NEW
  → 4. Prospective Memory: check trigger conditions                   ← NEW
  → 5. Epistemic Directives: inject top-priority questions            ← NEW
  → 6. Entity snapshot: surface referents on deictic markers           ← NEW
  → Format and inject into system prompt
```

---

## Competitive Position After PLAN-9

This table is kept as written in July 2026 and has not been re-verified against the other systems since. One Bitterbot cell has drifted: the dream engine now defines 13 modes (`DreamMode` in `dream-types.ts`), not 7.

| Capability                 | Bitterbot           | Mem0       | Zep                 | Hindsight | FadeMem |
| -------------------------- | ------------------- | ---------- | ------------------- | --------- | ------- |
| Knowledge Graph            | Yes (temporal)      | Yes        | Yes (best temporal) | Yes       | No      |
| Hormonal Modulation        | Yes                 | No         | No                  | No        | No      |
| Mood-Congruent Retrieval   | Yes                 | No         | No                  | No        | No      |
| Reconsolidation            | Yes (FIRST)         | No         | No                  | No        | No      |
| Spacing Effect             | Yes (FIRST)         | No         | No                  | No        | No      |
| Zeigarnik Persistence      | Yes (FIRST)         | No         | No                  | No        | No      |
| Prospective Memory         | Yes (FIRST)         | No         | No                  | No        | No      |
| Synaptic Tagging           | Yes (FIRST)         | No         | No                  | No        | No      |
| Active Inference           | Yes (FIRST)         | No         | No                  | No        | No      |
| Somatic Markers            | Yes (FIRST)         | No         | No                  | No        | No      |
| GCCRF Curiosity            | Yes                 | No         | No                  | No        | No      |
| Dream Consolidation        | Yes (7 modes then)  | ADD/UPDATE | Episode decomp      | Reflect   | Fusion  |
| Ebbinghaus Decay           | Yes                 | No         | No                  | No        | Yes     |
| Emotional Anchors          | Yes                 | No         | No                  | No        | No      |
| Session Continuity Gate    | Yes (entropy-gated) | No         | Yes (basic)         | No        | No      |
| Entity Anaphora Resolution | Yes (snapshot)      | No         | No                  | No        | No      |
| P2P Skill Marketplace      | Yes                 | No         | No                  | No        | No      |

---

## Related Documentation

- [Architecture Overview](./architecture-overview.md) — full system architecture and data flow
- [Knowledge Crystals](./knowledge-crystals.md) — core data model
- [Dream Engine](./dream-engine.md) — dream modes, FSHO selector
- [Emotional System](./emotional-system.md) — hormones, anchors, limbic bridge
- [Curiosity & Search](./curiosity-and-search.md) — unified curiosity engine and retrieval
- [How the Memory Works](./how-the-memory-works.md) — plain-language guide to the complete system
- [User Knowledge](./user-knowledge.md) — session extraction, handover briefs, entity snapshots
