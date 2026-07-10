/**
 * Proactive Memory Surfacing — involuntary recall of identity, directive,
 * and high-confidence facts triggered by user message context.
 *
 * Runs on every turn before system prompt assembly. Zero LLM cost.
 * The agent embodies these facts naturally without announcing them.
 *
 * Scientific basis:
 * - Involuntary Autobiographical Memories (Berntsen, 2009)
 * - Spreading Activation (Collins & Loftus, 1975)
 * - Mood-Congruent Recall (Bower, 1981)
 *
 * Plan 7, Phase 1.
 */

import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeGraphManager } from "./knowledge-graph.js";
import type { UserModelManager, UserPreference } from "./user-model.js";
import { graphAnchoredFacts } from "./proactive-recall-graph.js";
import { getActiveOpenLoops } from "./zeigarnik-effect.js";

export interface ProactiveRecallConfig {
  enabled: boolean;
  maxFacts: number;
  minConfidence: number;
  /**
   * Minimum cosine similarity (1 - distance) between the user message and a
   * crystal for it to surface. Tuned for text-embedding-3-small, whose
   * genuinely-relevant pairs cluster around 0.42-0.67 while unrelated pairs sit
   * ~0.1-0.3. At the old 0.55 a natural query like "who is my wife" (~0.50 vs
   * "User's wife is named Donna") fell through and surfaced nothing; 0.45 keeps
   * relational/short queries while staying clear of the noise floor.
   */
  minScore: number;
  /**
   * Minimum importance_score a crystal needs to be *eligible* for semantic
   * surfacing. This is only a cheap prefilter to bound the candidate set —
   * relevance is gated by `minScore` (cosine similarity), so this is kept low
   * on purpose. Curated factual layers (directive/world_fact) are valuable even
   * at modest importance: e.g. a stored "processed 636M tokens" world_fact sits
   * around 0.18 importance but must still surface when the user asks about it.
   */
  minImportance: number;
  priorityLayers: string[];
  identityAlwaysInclude: boolean;
  cooldownTurns: number;
  /**
   * Slots reserved for the semantic crystal stage (vector, or its keyword
   * fallback) out of `maxFacts`. Without this, the graph + identity stages —
   * which run first — can consume every slot on an identity-heavy turn and
   * crowd out a genuinely on-topic world_fact match. Only reserved when a
   * semantic stage can actually run (embedding or keyword fallback present);
   * unused reserve is released to the open-loop/deictic stages as before.
   */
  vectorReserve: number;
}

export const DEFAULT_PROACTIVE_RECALL_CONFIG: ProactiveRecallConfig = {
  enabled: true,
  maxFacts: 5,
  minConfidence: 0.6,
  minScore: 0.45,
  minImportance: 0.15,
  priorityLayers: ["directive", "world_fact"],
  identityAlwaysInclude: true,
  cooldownTurns: 5,
  vectorReserve: 2,
};

/**
 * Minimal English stopword set for the recall FTS fallback. Only needs to
 * strip the glue words of a conversational sentence; bm25 handles the rest.
 */
const RECALL_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "did",
  "does",
  "has",
  "had",
  "have",
  "you",
  "your",
  "yours",
  "our",
  "ours",
  "his",
  "her",
  "hers",
  "its",
  "their",
  "theirs",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "what",
  "which",
  "when",
  "where",
  "who",
  "whom",
  "why",
  "how",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "about",
  "into",
  "onto",
  "over",
  "under",
  "again",
  "then",
  "than",
  "there",
  "here",
  "just",
  "very",
  "not",
  "but",
  "any",
  "all",
  "some",
  "one",
  "two",
  "get",
  "got",
  "let",
  "lets",
  "please",
  "tell",
  "know",
  "think",
  "want",
  "need",
  "yesterday",
  "today",
  "tomorrow",
  "now",
  "still",
  "yet",
  "also",
  "too",
]);

/**
 * Build an FTS5 query for the recall keyword fallback from a conversational
 * user message. Unlike `buildFtsQuery` (hybrid search), which ANDs every
 * token — correct for terse search-tool queries, useless for a natural
 * sentence where no fact contains every word — this ORs the content words and
 * lets bm25 rank by how many (and how rare) the matches are. Returns null
 * when the message has no usable content words.
 */
export function buildRecallFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu)
      ?.filter((t) => t.length >= 3 && !RECALL_STOPWORDS.has(t)) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const unique = [...new Set(tokens)].slice(0, 12);
  return unique.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

/**
 * Scope the proactive-recall cooldown map to one conversation. The map lives
 * on the process-singleton memory manager, so without scoping a brand-new
 * conversation in a warm process inherits the previous session's suppression
 * window — a fact surfaced near the end of the last chat is then silently
 * withheld from the first turns of the next one (the "works warm, fails on a
 * fresh conversation" failure). Clears the map when the scope key changes and
 * returns the new key; callers without a key keep today's behavior.
 */
export function applyRecallScope(
  cooldown: Map<string, number>,
  previousScopeKey: string | undefined,
  scopeKey: string | undefined,
): string | undefined {
  if (!scopeKey || scopeKey === previousScopeKey) {
    return previousScopeKey;
  }
  cooldown.clear();
  return scopeKey;
}

export interface ProactiveRecallResult {
  facts: ProactiveFact[];
  searchTimeMs: number;
  /** PLAN-28 B1: per-layer contribution counts for retrieval observability. */
  layerCounts: {
    graphFacts: number;
    identityFacts: number;
    vectorFacts: number;
    keywordFacts: number;
    openLoops: number;
  };
}

export interface ProactiveFact {
  text: string;
  source: "crystal" | "preference";
  confidence: number;
  epistemicLayer?: string;
  category?: string;
  chunkId?: string;
}

/**
 * Surface relevant memories from the user's latest message.
 *
 * Strategy:
 * 0. PLAN-27: for entity/identity turns, resolve the entity in the knowledge
 *    graph and surface its current (SABM-valid) family edges structurally —
 *    confident, and immune to the embedding-similarity cliff that loses "who is
 *    my wife". Skipped entirely for non-entity turns and when no graph is given.
 * 1. Always include top identity preferences (name, role, location)
 *    — these are cheap (DB query, no embedding) and prevent the most
 *    jarring continuity breaks ("what's your name?" when it's stored).
 * 2. Embed the user message (reuse embedding already computed for
 *    ingestion) and run a lightweight vector search against crystals
 *    with directive/world_fact/mental_model epistemic layers.
 * 3. Deduplicate against recently surfaced facts (cooldown window).
 * 4. Format as terse one-line facts for system prompt injection.
 */
export function proactiveRecall(params: {
  userMessage: string;
  queryEmbedding: number[] | null;
  db: DatabaseSync;
  userModelManager: UserModelManager | null;
  recentlySurfaced: Map<string, number>;
  currentTurn: number;
  config?: Partial<ProactiveRecallConfig>;
  hormonalModulation?: { importanceBoost: number; recencyBias: number } | null;
  /** PLAN-27: knowledge graph for entity-anchored family-edge recall. */
  kg?: KnowledgeGraphManager | null;
  /** Resolved user name, so graph facts can phrase "your <relation>". */
  userName?: string | null;
  /**
   * FTS fallback for the semantic stage when no query embedding is available
   * (cold-process embed timeout, provider outage). Without it, a null
   * embedding silently skips the entire crystal stage — the exact
   * "wired but dead" cold-start failure class. Opt-in: callers that do not
   * pass it keep the embedding-only behavior. The FTS query is always built
   * with `buildRecallFtsQuery` (OR semantics) — the AND-based hybrid-search
   * builder never matches a conversational sentence.
   */
  keywordFallback?: {
    ftsTable: string;
  } | null;
}): ProactiveRecallResult {
  const cfg = { ...DEFAULT_PROACTIVE_RECALL_CONFIG, ...params.config };
  const start = performance.now();
  const facts: ProactiveFact[] = [];
  const layerCounts = {
    graphFacts: 0,
    identityFacts: 0,
    vectorFacts: 0,
    keywordFacts: 0,
    openLoops: 0,
  };

  // Reserve slots for the semantic crystal stage only when it can actually
  // run, so the graph/identity stages (which fill first) cannot crowd it out.
  const hasEmbedding = !!params.queryEmbedding && params.queryEmbedding.length > 0;
  const canRunSemanticStage =
    hasEmbedding || (!!params.keywordFallback && !!params.userMessage?.trim());
  const preSemanticCap = canRunSemanticStage
    ? Math.max(0, cfg.maxFacts - Math.min(cfg.vectorReserve, cfg.maxFacts))
    : cfg.maxFacts;

  // ── 0. PLAN-27: graph-anchored family edges (entity/identity turns) ──
  // Runs first so a structural answer ("Donna — your spouse") leads, ahead of any
  // fuzzy vector match. No-ops on non-entity turns and when no graph is supplied.
  if (params.kg) {
    try {
      const graphFacts = graphAnchoredFacts({
        userMessage: params.userMessage,
        kg: params.kg,
        userName: params.userName,
        maxFacts: preSemanticCap,
        recentlySurfaced: params.recentlySurfaced,
        currentTurn: params.currentTurn,
        cooldownTurns: cfg.cooldownTurns,
      });
      facts.push(...graphFacts);
      layerCounts.graphFacts += graphFacts.length;
    } catch {
      // Graph unavailable or malformed — fall through to the vector path.
    }
  }

  // ── 1. Identity facts (always, no embedding needed) ──
  if (cfg.identityAlwaysInclude && params.userModelManager) {
    try {
      const profile = params.userModelManager.getUserProfile();
      const identityPrefs = profile.preferences
        .filter(
          (p: UserPreference) => p.category === "identity" && p.confidence >= cfg.minConfidence,
        )
        .slice(0, 3);

      for (const pref of identityPrefs) {
        if (facts.length >= preSemanticCap) {
          break;
        }
        const key = `pref:${pref.category}:${pref.key}`;
        const lastTurn = params.recentlySurfaced.get(key) ?? -Infinity;
        if (params.currentTurn - lastTurn < cfg.cooldownTurns) {
          continue;
        }

        facts.push({
          text: `${pref.key}: ${pref.value}`,
          source: "preference",
          confidence: pref.confidence,
          category: pref.category,
        });
        params.recentlySurfaced.set(key, params.currentTurn);
        layerCounts.identityFacts += 1;
      }
    } catch {
      // UserModelManager may not be ready
    }
  }

  // ── 2. Vector-matched crystals (directive + world_fact priority) ──
  if (hasEmbedding && params.queryEmbedding) {
    const remaining = cfg.maxFacts - facts.length;
    if (remaining > 0) {
      try {
        const candidateRows = params.db
          .prepare(
            `SELECT c.id, c.text, c.importance_score, c.epistemic_layer,
                    c.semantic_type, c.emotional_valence,
                    vec_distance_cosine(v.embedding, ?) as distance
             FROM chunks_vec v
             JOIN chunks c ON c.id = v.id
             WHERE c.epistemic_layer IN ('directive', 'world_fact', 'mental_model')
               AND COALESCE(c.lifecycle, 'generated') IN ('generated', 'activated', 'consolidated', 'frozen')
               AND c.importance_score >= ?
             ORDER BY distance ASC
             LIMIT ?`,
          )
          .all(JSON.stringify(params.queryEmbedding), cfg.minImportance, remaining * 3) as Array<{
          id: string;
          text: string;
          importance_score: number;
          epistemic_layer: string;
          semantic_type: string;
          emotional_valence: number | null;
          distance: number;
        }>;

        for (const row of candidateRows) {
          if (facts.length >= cfg.maxFacts) {
            break;
          }

          const score = 1 - row.distance;
          if (score < cfg.minScore) {
            continue;
          }

          // Cooldown check
          const lastTurn = params.recentlySurfaced.get(row.id) ?? -Infinity;
          if (params.currentTurn - lastTurn < cfg.cooldownTurns) {
            continue;
          }

          // Truncate crystal text for prompt injection
          const truncated = row.text.length > 120 ? row.text.slice(0, 117) + "..." : row.text;

          facts.push({
            text: truncated,
            source: "crystal",
            confidence: row.importance_score,
            epistemicLayer: row.epistemic_layer,
            chunkId: row.id,
          });
          params.recentlySurfaced.set(row.id, params.currentTurn);
          layerCounts.vectorFacts += 1;
        }
      } catch {
        // Vector table may not exist or query may fail — non-critical
      }
    }
  } else if (params.keywordFallback && params.userMessage?.trim()) {
    // ── 2b. Keyword fallback: no query embedding (cold-process embed timeout,
    // provider outage). Degraded transport for the same crystal channel: FTS
    // over the same layer/lifecycle/importance filters, ranked by bm25. This
    // keeps the semantic stage alive on exactly the turns where the vector
    // branch used to die silently.
    const remaining = cfg.maxFacts - facts.length;
    if (remaining > 0) {
      try {
        const ftsQuery = buildRecallFtsQuery(params.userMessage);
        if (ftsQuery) {
          const fts = params.keywordFallback.ftsTable;
          // bm25() cannot be used inside an aggregate, so the per-embedding-
          // model duplicate rows the FTS table carries are deduped in the loop
          // below (same shape as manager-search's searchKeyword). Over-fetch
          // to survive both the dedup and the cooldown filter.
          const candidateRows = params.db
            .prepare(
              `SELECT c.id, c.text, c.importance_score, c.epistemic_layer, bm25(${fts}) AS rank
               FROM ${fts} f
               JOIN chunks c ON c.id = f.id
               WHERE ${fts} MATCH ?
                 AND c.epistemic_layer IN ('directive', 'world_fact', 'mental_model')
                 AND COALESCE(c.lifecycle, 'generated') IN ('generated', 'activated', 'consolidated', 'frozen')
                 AND c.importance_score >= ?
               ORDER BY rank ASC
               LIMIT ?`,
            )
            .all(ftsQuery, cfg.minImportance, Math.max(30, remaining * 6)) as Array<{
            id: string;
            text: string;
            importance_score: number;
            epistemic_layer: string;
            rank: number;
          }>;

          const seenIds = new Set<string>();
          for (const row of candidateRows) {
            if (facts.length >= cfg.maxFacts) {
              break;
            }
            if (seenIds.has(row.id)) {
              continue;
            }
            seenIds.add(row.id);
            const lastTurn = params.recentlySurfaced.get(row.id) ?? -Infinity;
            if (params.currentTurn - lastTurn < cfg.cooldownTurns) {
              continue;
            }
            const truncated = row.text.length > 120 ? row.text.slice(0, 117) + "..." : row.text;
            facts.push({
              text: truncated,
              source: "crystal",
              confidence: row.importance_score,
              epistemicLayer: row.epistemic_layer,
              chunkId: row.id,
            });
            params.recentlySurfaced.set(row.id, params.currentTurn);
            layerCounts.keywordFacts += 1;
          }
        }
      } catch {
        // FTS table may not exist or MATCH may fail — non-critical
      }
    }
  }

  // ── 3. PLAN-9 GAP-8: Zeigarnik — surface unfinished business ──
  if (facts.length < cfg.maxFacts) {
    try {
      const openLoops = getActiveOpenLoops(params.db, 2);
      for (const loop of openLoops) {
        if (facts.length >= cfg.maxFacts) {
          break;
        }
        const key = `openloop:${loop.id}`;
        const lastTurn = params.recentlySurfaced.get(key) ?? -Infinity;
        if (params.currentTurn - lastTurn < cfg.cooldownTurns * 2) {
          continue;
        }

        facts.push({
          text: `Unfinished: ${loop.context || loop.text}`,
          source: "crystal",
          confidence: Math.min(0.9, loop.importance),
          epistemicLayer: "experience",
          chunkId: loop.id,
        });
        params.recentlySurfaced.set(key, params.currentTurn);
        layerCounts.openLoops += 1;
      }
    } catch {
      // Non-critical
    }
  }

  // ── 4. Entity snapshot: surface last-touched entities for anaphora resolution ──
  // When the user says "that file" or "the same thing", the LLM needs the referents.
  // Query the most recent handover chunk which contains entity names.
  if (facts.length < cfg.maxFacts && params.userMessage) {
    const deicticPatterns =
      /\b(?:that|this|the same|it|those|these|the other|the second|the first|same thing|change it|fix it|update it)\b/i;
    if (deicticPatterns.test(params.userMessage)) {
      try {
        const handoverRow = params.db
          .prepare(
            `SELECT text FROM chunks
             WHERE semantic_type = 'episode' AND source = 'memory'
               AND text LIKE 'Session Handover:%'
               AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated')
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get() as { text: string } | undefined;

        if (handoverRow) {
          // Extract entity names from the "Entities:" line in the chunk text
          const entitiesMatch = handoverRow.text.match(/Entities:\s*(.+)/);
          if (entitiesMatch) {
            facts.push({
              text: `Recent context: ${entitiesMatch[1].slice(0, 150)}`,
              source: "preference",
              confidence: 0.8,
              category: "context",
            });
          }
        }
      } catch {
        // Non-critical — entity snapshot not available
      }
    }
  }

  return {
    facts,
    searchTimeMs: performance.now() - start,
    layerCounts,
  };
}

export interface FormatProactiveFactsOptions {
  /**
   * When true, wrap the block in <memory-context>...</memory-context> fence
   * tags. Pairs with the StreamingContextScrubber on the consumer side so the
   * model echoing the block does not leak the fence verbatim. Default false
   * — flipping without a matching scrubber on the streaming pipeline will
   * surface fence tags in the user transcript.
   */
  wrapInMemoryFence?: boolean;
}

export const MEMORY_FENCE_OPEN_TAG = "<memory-context>";
export const MEMORY_FENCE_CLOSE_TAG = "</memory-context>";

/**
 * Format proactive facts for system prompt injection.
 * Terse, one-line-per-fact format that the LLM embodies naturally.
 */
export function formatProactiveFacts(
  facts: ProactiveFact[],
  options: FormatProactiveFactsOptions = {},
): string {
  if (facts.length === 0) {
    return "";
  }
  const lines = facts.map((f) => {
    const prefix = f.confidence < 0.4 ? "(uncertain) " : "";
    return `- ${prefix}${f.text}`;
  });
  const inner = [
    "What you already know (act on this naturally, never announce it):",
    ...lines,
  ].join("\n");
  if (options.wrapInMemoryFence) {
    return `${MEMORY_FENCE_OPEN_TAG}\n${inner}\n${MEMORY_FENCE_CLOSE_TAG}`;
  }
  return inner;
}
