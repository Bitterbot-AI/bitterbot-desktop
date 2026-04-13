/**
 * DiscoveryAgent: background agent that continuously discovers implicit
 * relationships between skills — prerequisites, compositions, contradictions.
 *
 * Operates on the skill_edges table to build a skill relationship graph.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { SkillEdge, SkillEdgeType } from "./crystal-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const log = createSubsystemLogger("memory/discovery-agent");

export type LlmCallFn = (prompt: string) => Promise<string>;

export type DiscoveryResult = {
  edgesDiscovered: number;
  prerequisitesFound: number;
  compositesFound: number;
  contradictionsFound: number;
  llmCallsUsed: number;
};

export type SkillSuggestion = {
  skillId: string;
  skillName: string;
  confidence: number;
  rationale: string;
  source: "friction" | "goal_alignment" | "curiosity_gap" | "trending";
  relevantGoalIds: string[];
  relevantQueryPatterns: string[];
};

export type SuggestSkillsConfig = {
  minConfidence?: number;
  maxResults?: number;
};

type SkillRow = {
  id: string;
  text: string;
  embedding: string;
  skill_category: string | null;
  stable_skill_id: string | null;
};

export class DiscoveryAgent {
  private readonly db: DatabaseSync;
  private readonly llmCall: LlmCallFn | null;

  constructor(db: DatabaseSync, llmCall: LlmCallFn | null) {
    this.db = db;
    this.llmCall = llmCall;
  }

  /**
   * Run one discovery cycle: analyze skill pairs and discover relationships.
   */
  async runCycle(): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      edgesDiscovered: 0,
      prerequisitesFound: 0,
      compositesFound: 0,
      contradictionsFound: 0,
      llmCallsUsed: 0,
    };

    const skills = this.loadSkills();
    if (skills.length < 2) {
      return result;
    }

    // 1. Embedding-based similarity edges
    const similarEdges = this.discoverSimilarEdges(skills);
    result.edgesDiscovered += similarEdges;

    // 2. LLM-based relationship discovery (if available)
    if (this.llmCall) {
      const prereqs = await this.discoverPrerequisites(skills);
      result.prerequisitesFound = prereqs.length;
      result.edgesDiscovered += prereqs.length;
      if (prereqs.length >= 0) {
        result.llmCallsUsed++;
      } // 1 call for prerequisites

      const { edges: composites, llmCalls: compositeLlmCalls } =
        await this.discoverCompositesWithCount(skills);
      result.compositesFound = composites.length;
      result.edgesDiscovered += composites.length;
      result.llmCallsUsed += compositeLlmCalls;

      const contradictions = await this.discoverContradictions(skills);
      result.contradictionsFound = contradictions.length;
      result.edgesDiscovered += contradictions.length;
      if (contradictions.length >= 0) {
        result.llmCallsUsed++;
      } // 1 call for contradictions
    }

    log.debug("discovery cycle complete", result);
    return result;
  }

  /**
   * Discover prerequisite relationships between skills using LLM.
   */
  async discoverPrerequisites(skills: SkillRow[]): Promise<SkillEdge[]> {
    if (!this.llmCall || skills.length < 2) {
      return [];
    }

    // Pick unconnected skill pairs within the same category
    const pairs = this.findUnconnectedPairs(skills, 3);
    if (pairs.length === 0) {
      return [];
    }

    const pairDescriptions = pairs
      .map(
        ([a, b], i) =>
          `Pair ${i + 1}:\nSkill A: ${a.text.slice(0, 300)}\nSkill B: ${b.text.slice(0, 300)}`,
      )
      .join("\n\n---\n\n");

    const prompt =
      `Analyze these skill pairs and determine if one is a prerequisite for the other.\n\n` +
      `${pairDescriptions}\n\n` +
      `For each pair, respond with a JSON array of objects:\n` +
      `- "pair": the pair number (1-indexed)\n` +
      `- "relationship": "prerequisite" | "enables" | "none"\n` +
      `- "direction": "a_to_b" | "b_to_a" (which is the prerequisite)\n` +
      `- "confidence": float 0-1\n\n` +
      `Respond ONLY with the JSON array.`;

    try {
      const raw = await this.llmCall(prompt);
      const parsed = this.parseLlmResponse(raw);
      const edges: SkillEdge[] = [];

      for (const item of parsed) {
        const pairIdx = (Number(item.pair) || 1) - 1;
        if (pairIdx < 0 || pairIdx >= pairs.length) {
          continue;
        }
        if (item.relationship === "none") {
          continue;
        }

        const [a, b] = pairs[pairIdx]!;
        const source = item.direction === "b_to_a" ? b : a;
        const target = item.direction === "b_to_a" ? a : b;

        const edge = this.storeEdge(
          source.id,
          target.id,
          item.relationship as SkillEdgeType,
          Number(item.confidence) || 0.5,
          "llm",
        );
        if (edge) {
          edges.push(edge);
        }
      }

      return edges;
    } catch (err) {
      log.debug(`prerequisite discovery failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Discover composite skills — groups that form higher-level capabilities.
   */
  async discoverComposites(skills: SkillRow[]): Promise<SkillEdge[]> {
    const { edges } = await this.discoverCompositesWithCount(skills);
    return edges;
  }

  /**
   * Internal: discover composites and return the actual LLM call count
   * (one call per qualifying category).
   */
  private async discoverCompositesWithCount(
    skills: SkillRow[],
  ): Promise<{ edges: SkillEdge[]; llmCalls: number }> {
    if (!this.llmCall || skills.length < 3) {
      return { edges: [], llmCalls: 0 };
    }

    // Take up to 5 skills in the same category
    const sameCategory = new Map<string, SkillRow[]>();
    for (const skill of skills) {
      const cat = skill.skill_category ?? "general";
      if (!sameCategory.has(cat)) {
        sameCategory.set(cat, []);
      }
      sameCategory.get(cat)!.push(skill);
    }

    const edges: SkillEdge[] = [];
    let llmCalls = 0;
    for (const [cat, catSkills] of sameCategory) {
      if (catSkills.length < 3) {
        continue;
      }
      const sample = catSkills.slice(0, 5);

      const skillList = sample.map((s, i) => `Skill ${i + 1}: ${s.text.slice(0, 200)}`).join("\n");

      const prompt =
        `Given these skills in the "${cat}" category, identify which skills compose ` +
        `a higher-level capability when combined.\n\n${skillList}\n\n` +
        `Respond with a JSON array of composition groups:\n` +
        `- "skills": array of skill numbers that compose together\n` +
        `- "capability": what they form together\n` +
        `- "confidence": float 0-1\n\n` +
        `Respond ONLY with the JSON array.`;

      try {
        const raw = await this.llmCall(prompt);
        llmCalls++;
        const parsed = this.parseLlmResponse(raw);

        for (const item of parsed) {
          const skillNums = item.skills as number[] | undefined;
          if (!skillNums || skillNums.length < 2) {
            continue;
          }

          // Create "composes" edges between all pairs
          for (let i = 0; i < skillNums.length; i++) {
            for (let j = i + 1; j < skillNums.length; j++) {
              const a = sample[(skillNums[i] ?? 1) - 1];
              const b = sample[(skillNums[j] ?? 1) - 1];
              if (!a || !b) {
                continue;
              }

              const edge = this.storeEdge(
                a.id,
                b.id,
                "composes",
                Number(item.confidence) || 0.5,
                "llm",
              );
              if (edge) {
                edges.push(edge);
              }
            }
          }
        }
      } catch (err) {
        llmCalls++; // count failed calls too — they consumed API quota
        log.debug(`composite discovery failed for ${cat}: ${String(err)}`);
      }
    }

    return { edges, llmCalls };
  }

  /**
   * Discover contradictions between skills.
   */
  async discoverContradictions(skills: SkillRow[]): Promise<SkillEdge[]> {
    if (!this.llmCall || skills.length < 2) {
      return [];
    }

    // Find highly similar skills that might contradict
    const candidates = this.findSimilarPairs(skills, 0.7, 3);
    if (candidates.length === 0) {
      return [];
    }

    const pairDescriptions = candidates
      .map(
        ([a, b], i) =>
          `Pair ${i + 1}:\nSkill A: ${a.text.slice(0, 300)}\nSkill B: ${b.text.slice(0, 300)}`,
      )
      .join("\n\n---\n\n");

    const prompt =
      `These skill pairs are semantically similar. Do any of them contradict each other ` +
      `(give conflicting advice, opposite approaches, incompatible strategies)?\n\n` +
      `${pairDescriptions}\n\n` +
      `Respond with a JSON array of objects:\n` +
      `- "pair": the pair number\n` +
      `- "contradicts": true/false\n` +
      `- "explanation": brief reason\n` +
      `- "confidence": float 0-1\n\n` +
      `Respond ONLY with the JSON array.`;

    try {
      const raw = await this.llmCall(prompt);
      const parsed = this.parseLlmResponse(raw);
      const edges: SkillEdge[] = [];

      for (const item of parsed) {
        if (!item.contradicts) {
          continue;
        }
        const pairIdx = (Number(item.pair) || 1) - 1;
        if (pairIdx < 0 || pairIdx >= candidates.length) {
          continue;
        }

        const [a, b] = candidates[pairIdx]!;
        const edge = this.storeEdge(
          a.id,
          b.id,
          "contradicts",
          Number(item.confidence) || 0.5,
          "llm",
        );
        if (edge) {
          edges.push(edge);
        }
      }

      return edges;
    } catch (err) {
      log.debug(`contradiction discovery failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Get all edges for a skill (both directions).
   */
  getEdges(skillId: string): SkillEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_edges
         WHERE source_skill_id = ? OR target_skill_id = ?
         ORDER BY weight DESC`,
      )
      .all(skillId, skillId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToEdge(row));
  }

  /**
   * Get prerequisite chain for a skill (backward traversal).
   */
  getPrerequisites(skillId: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    const queue = [skillId];
    const result: string[] = [];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextQueue: string[] = [];
      for (const id of queue) {
        if (visited.has(id)) {
          continue;
        }
        visited.add(id);

        const prereqs = this.db
          .prepare(
            `SELECT source_skill_id FROM skill_edges
             WHERE target_skill_id = ? AND edge_type = 'prerequisite'
             ORDER BY weight DESC`,
          )
          .all(id) as Array<{ source_skill_id: string }>;

        for (const p of prereqs) {
          if (!visited.has(p.source_skill_id)) {
            result.push(p.source_skill_id);
            nextQueue.push(p.source_skill_id);
          }
        }
      }
      if (nextQueue.length === 0) {
        break;
      }
      queue.length = 0;
      queue.push(...nextQueue);
    }

    return result;
  }

  /**
   * Decay steering rewards on all edges.
   */
  decayEdgeRewards(factor = 0.95): number {
    const result = this.db
      .prepare(
        `UPDATE skill_edges SET steering_reward = steering_reward * ?
         WHERE steering_reward != 0`,
      )
      .run(factor);
    return (result as { changes: number }).changes;
  }

  // ── Proactive Skill Suggestions (Task 8) ──

  /**
   * Suggest skills that might help the user based on 4 strategies:
   * 1. Friction patterns — repeated low-score searches
   * 2. Goal alignment — active/stalled goals matched to marketplace
   * 3. Curiosity gaps — unresolved knowledge gaps
   * 4. Marketplace trending — popular peer-origin skills
   */
  async suggestSkills(config?: SuggestSkillsConfig): Promise<SkillSuggestion[]> {
    const minConfidence = config?.minConfidence ?? 0.3;
    const maxResults = config?.maxResults ?? 5;
    const suggestions: SkillSuggestion[] = [];

    // Strategy 1: Friction patterns — repeated low-score searches
    try {
      const frictionQueries = this.db
        .prepare(
          `SELECT query, query_embedding, COUNT(*) as c, AVG(top_score) as avg_score
           FROM curiosity_queries
           GROUP BY query
           HAVING c >= 3 AND avg_score < 0.4
           ORDER BY c DESC
           LIMIT 5`,
        )
        .all() as Array<{ query: string; query_embedding: string; c: number; avg_score: number }>;

      for (const fq of frictionQueries) {
        const queryEmb = parseEmbedding(fq.query_embedding);
        if (queryEmb.length === 0) {
          continue;
        }

        const match = this.findMarketplaceSkillsByEmbedding(queryEmb, 1);
        if (match.length > 0 && match[0]!) {
          const m = match[0];
          suggestions.push({
            skillId: m.id,
            skillName: m.name,
            confidence: Math.min(1, 0.3 + (fq.c / 10) * 0.3 + m.similarity * 0.4),
            rationale: `Repeated search "${fq.query}" (${fq.c}x, avg score ${fq.avg_score.toFixed(2)}) matches this skill`,
            source: "friction",
            relevantGoalIds: [],
            relevantQueryPatterns: [fq.query],
          });
        }
      }
    } catch {
      // curiosity_queries table might not exist
    }

    // Strategy 2: Goal alignment — active/stalled goals
    try {
      const goals = this.db
        .prepare(
          `SELECT id, description FROM task_goals WHERE status IN ('active', 'stalled') LIMIT 10`,
        )
        .all() as Array<{ id: string; description: string }>;

      for (const goal of goals) {
        const keywords = goal.description
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length > 3);
        if (keywords.length === 0) {
          continue;
        }

        const keywordPattern = keywords.slice(0, 3).join("%");
        const matchingSkills = this.db
          .prepare(
            `SELECT id, path, text FROM chunks
             WHERE marketplace_listed = 1 AND LOWER(text) LIKE ?
             LIMIT 1`,
          )
          .all(`%${keywordPattern}%`) as Array<{ id: string; path: string; text: string }>;

        for (const ms of matchingSkills) {
          suggestions.push({
            skillId: ms.id,
            skillName: this.extractNameFromPath(ms.path),
            confidence: 0.4,
            rationale: `Matches active goal: "${goal.description.slice(0, 60)}"`,
            source: "goal_alignment",
            relevantGoalIds: [goal.id],
            relevantQueryPatterns: [],
          });
        }
      }
    } catch {
      // task_goals table might not exist
    }

    // Strategy 3: Curiosity gaps — unresolved knowledge gaps
    try {
      const gaps = this.db
        .prepare(
          `SELECT id, label FROM curiosity_targets
           WHERE type = 'knowledge_gap' AND resolved_at IS NULL AND expires_at > ?
           LIMIT 5`,
        )
        .all(Date.now()) as Array<{ id: string; label: string }>;

      for (const gap of gaps) {
        const keywords = gap.label
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length > 3);
        if (keywords.length === 0) {
          continue;
        }

        const keywordPattern = keywords.slice(0, 3).join("%");
        const matchingSkills = this.db
          .prepare(
            `SELECT id, path, text FROM chunks
             WHERE marketplace_listed = 1 AND LOWER(text) LIKE ?
             LIMIT 1`,
          )
          .all(`%${keywordPattern}%`) as Array<{ id: string; path: string; text: string }>;

        for (const ms of matchingSkills) {
          suggestions.push({
            skillId: ms.id,
            skillName: this.extractNameFromPath(ms.path),
            confidence: 0.35,
            rationale: `Addresses knowledge gap: "${gap.label.slice(0, 60)}"`,
            source: "curiosity_gap",
            relevantGoalIds: [],
            relevantQueryPatterns: [gap.label],
          });
        }
      }
    } catch {
      // curiosity_targets table might not exist
    }

    // Strategy 4: Marketplace trending — recent high-download peer-origin skills
    try {
      const trending = this.db
        .prepare(
          `SELECT id, path, download_count FROM chunks
           WHERE marketplace_listed = 1 AND governance_json LIKE '%peerOrigin%'
           ORDER BY download_count DESC
           LIMIT 3`,
        )
        .all() as Array<{ id: string; path: string; download_count: number }>;

      for (const t of trending) {
        if (t.download_count < 1) {
          continue;
        }
        suggestions.push({
          skillId: t.id,
          skillName: this.extractNameFromPath(t.path),
          confidence: Math.min(1, 0.3 + (t.download_count / 50) * 0.4),
          rationale: `Trending marketplace skill (${t.download_count} downloads)`,
          source: "trending",
          relevantGoalIds: [],
          relevantQueryPatterns: [],
        });
      }
    } catch {}

    // Deduplicate by skillId (keep highest confidence)
    const deduped = new Map<string, SkillSuggestion>();
    for (const s of suggestions) {
      const existing = deduped.get(s.skillId);
      if (!existing || s.confidence > existing.confidence) {
        deduped.set(s.skillId, s);
      }
    }

    // Filter by minConfidence and return top results
    return Array.from(deduped.values())
      .filter((s) => s.confidence >= minConfidence)
      .toSorted((a, b) => b.confidence - a.confidence)
      .slice(0, maxResults);
  }

  /**
   * Find marketplace-listed skills by embedding similarity.
   */
  private findMarketplaceSkillsByEmbedding(
    queryEmbedding: number[],
    limit: number,
  ): Array<{ id: string; name: string; similarity: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, path, embedding FROM chunks
         WHERE marketplace_listed = 1 AND embedding IS NOT NULL AND embedding != '[]'
         LIMIT 50`,
      )
      .all() as Array<{ id: string; path: string; embedding: string }>;

    const scored = rows
      .map((row) => {
        const emb = parseEmbedding(row.embedding);
        if (emb.length === 0) {
          return null;
        }
        const similarity = cosineSimilarity(queryEmbedding, emb);
        return { id: row.id, name: this.extractNameFromPath(row.path), similarity };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .toSorted((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit);
  }

  private extractNameFromPath(path: string): string {
    const parts = path.split("/");
    const last = parts[parts.length - 1] ?? "unknown";
    return last.replace(/[^a-z0-9-]/gi, "-").slice(0, 64) || "unknown";
  }

  // ── Private helpers ──

  private loadSkills(): SkillRow[] {
    return this.db
      .prepare(
        `SELECT id, text, embedding, skill_category, stable_skill_id
         FROM chunks
         WHERE (COALESCE(memory_type, 'plaintext') = 'skill'
                OR COALESCE(semantic_type, 'general') = 'skill')
           AND COALESCE(deprecated, 0) = 0
           AND (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
         ORDER BY importance_score DESC
         LIMIT 50`,
      )
      .all() as SkillRow[];
  }

  private discoverSimilarEdges(skills: SkillRow[]): number {
    const embeddings = new Map<string, number[]>();
    for (const skill of skills) {
      const emb = parseEmbedding(skill.embedding);
      if (emb.length > 0) {
        embeddings.set(skill.id, emb);
      }
    }

    let count = 0;
    for (let i = 0; i < skills.length; i++) {
      const embA = embeddings.get(skills[i]!.id);
      if (!embA) {
        continue;
      }
      for (let j = i + 1; j < skills.length; j++) {
        const embB = embeddings.get(skills[j]!.id);
        if (!embB) {
          continue;
        }
        const sim = cosineSimilarity(embA, embB);
        if (sim >= 0.8) {
          const edge = this.storeEdge(skills[i]!.id, skills[j]!.id, "similar", sim, "embedding");
          if (edge) {
            count++;
          }
        }
      }
    }
    return count;
  }

  private findUnconnectedPairs(skills: SkillRow[], limit: number): Array<[SkillRow, SkillRow]> {
    const pairs: Array<[SkillRow, SkillRow]> = [];
    for (let i = 0; i < skills.length && pairs.length < limit; i++) {
      for (let j = i + 1; j < skills.length && pairs.length < limit; j++) {
        // Check if edge already exists
        const existing = this.db
          .prepare(
            `SELECT id FROM skill_edges
             WHERE (source_skill_id = ? AND target_skill_id = ?)
                OR (source_skill_id = ? AND target_skill_id = ?)
             LIMIT 1`,
          )
          .get(skills[i]!.id, skills[j]!.id, skills[j]!.id, skills[i]!.id);

        if (!existing) {
          pairs.push([skills[i]!, skills[j]!]);
        }
      }
    }
    return pairs;
  }

  private findSimilarPairs(
    skills: SkillRow[],
    threshold: number,
    limit: number,
  ): Array<[SkillRow, SkillRow]> {
    const embeddings = new Map<string, number[]>();
    for (const skill of skills) {
      const emb = parseEmbedding(skill.embedding);
      if (emb.length > 0) {
        embeddings.set(skill.id, emb);
      }
    }

    const pairs: Array<[SkillRow, SkillRow]> = [];
    for (let i = 0; i < skills.length && pairs.length < limit; i++) {
      const embA = embeddings.get(skills[i]!.id);
      if (!embA) {
        continue;
      }
      for (let j = i + 1; j < skills.length && pairs.length < limit; j++) {
        const embB = embeddings.get(skills[j]!.id);
        if (!embB) {
          continue;
        }
        if (cosineSimilarity(embA, embB) >= threshold) {
          pairs.push([skills[i]!, skills[j]!]);
        }
      }
    }
    return pairs;
  }

  private storeEdge(
    sourceId: string,
    targetId: string,
    edgeType: SkillEdgeType,
    confidence: number,
    discoveredBy: string,
  ): SkillEdge | null {
    // Check for existing edge
    const existing = this.db
      .prepare(
        `SELECT id FROM skill_edges
         WHERE source_skill_id = ? AND target_skill_id = ? AND edge_type = ?`,
      )
      .get(sourceId, targetId, edgeType);

    if (existing) {
      return null;
    }

    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO skill_edges
         (id, source_skill_id, target_skill_id, edge_type, weight, confidence, discovered_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sourceId, targetId, edgeType, confidence, confidence, discoveredBy, now, now);

    return {
      id,
      sourceSkillId: sourceId,
      targetSkillId: targetId,
      edgeType,
      weight: confidence,
      steeringReward: 0,
      confidence,
      discoveredBy: discoveredBy as SkillEdge["discoveredBy"],
      createdAt: now,
      updatedAt: now,
    };
  }

  private parseLlmResponse(raw: string): Array<Record<string, unknown>> {
    try {
      const cleaned = raw
        .trim()
        .replace(/^```json?\s*/i, "")
        .replace(/```\s*$/, "");
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private rowToEdge(row: Record<string, unknown>): SkillEdge {
    const r = row as Record<string, string | number | null>;
    return {
      id: String(r.id ?? ""),
      sourceSkillId: String(r.source_skill_id ?? ""),
      targetSkillId: String(r.target_skill_id ?? ""),
      edgeType: String(r.edge_type ?? "similar") as SkillEdgeType,
      weight: Number(r.weight ?? 0.5),
      steeringReward: Number(r.steering_reward ?? 0),
      confidence: Number(r.confidence ?? 0.5),
      discoveredBy: String(r.discovered_by ?? "embedding") as SkillEdge["discoveredBy"],
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    };
  }
}
