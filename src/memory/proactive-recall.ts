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
import type { UserModelManager, UserPreference } from "./user-model.js";
import { getActiveOpenLoops } from "./zeigarnik-effect.js";

export interface ProactiveRecallConfig {
  enabled: boolean;
  maxFacts: number;
  minConfidence: number;
  minScore: number;
  priorityLayers: string[];
  identityAlwaysInclude: boolean;
  cooldownTurns: number;
}

export const DEFAULT_PROACTIVE_RECALL_CONFIG: ProactiveRecallConfig = {
  enabled: true,
  maxFacts: 5,
  minConfidence: 0.6,
  minScore: 0.55,
  priorityLayers: ["directive", "world_fact"],
  identityAlwaysInclude: true,
  cooldownTurns: 5,
};

export interface ProactiveRecallResult {
  facts: ProactiveFact[];
  searchTimeMs: number;
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
}): ProactiveRecallResult {
  const cfg = { ...DEFAULT_PROACTIVE_RECALL_CONFIG, ...params.config };
  const start = performance.now();
  const facts: ProactiveFact[] = [];

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
      }
    } catch {
      // UserModelManager may not be ready
    }
  }

  // ── 2. Vector-matched crystals (directive + world_fact priority) ──
  if (params.queryEmbedding && params.queryEmbedding.length > 0) {
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
               AND c.importance_score >= 0.4
             ORDER BY distance ASC
             LIMIT ?`,
          )
          .all(JSON.stringify(params.queryEmbedding), remaining * 3) as Array<{
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
        }
      } catch {
        // Vector table may not exist or query may fail — non-critical
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
  };
}

/**
 * Format proactive facts for system prompt injection.
 * Terse, one-line-per-fact format that the LLM embodies naturally.
 */
export function formatProactiveFacts(facts: ProactiveFact[]): string {
  if (facts.length === 0) {
    return "";
  }
  const lines = facts.map((f) => {
    const prefix = f.confidence < 0.4 ? "(uncertain) " : "";
    return `- ${prefix}${f.text}`;
  });
  return ["What you already know (act on this naturally, never announce it):", ...lines].join("\n");
}
