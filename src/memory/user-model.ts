/**
 * UserModelManager: extracts and tracks user preferences from session content.
 * Provides a user profile summary for system prompt enrichment and
 * pattern detection for dream extrapolation.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureColumn } from "./memory-schema.js";

const log = createSubsystemLogger("memory/user-model");

export type UserPreference = {
  id: string;
  category: "tool" | "language" | "style" | "workflow" | "communication"
    | "identity" | "project" | "technical" | "personal" | "directive";
  key: string;
  value: string;
  confidence: number;
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type UserPattern = {
  pattern: string;
  frequency: number;
  lastOccurrence: number;
  predictiveValue: number;
};

export type UserProfile = {
  preferences: UserPreference[];
  patterns: UserPattern[];
};

export type UserModelConfig = {
  enabled?: boolean;
  extractPreferences?: boolean;
  detectPatterns?: boolean;
};

// Preference extraction patterns
const PREFERENCE_PATTERNS: Array<{
  category: UserPreference["category"];
  key: string;
  pattern: RegExp;
  extractValue: (match: RegExpMatchArray) => string;
}> = [
  {
    category: "language",
    key: "preferred_language",
    pattern: /\b(?:i (?:prefer|use|like|always use|write in))\s+(typescript|javascript|python|rust|go|java|c\+\+|ruby|php|swift|kotlin)\b/i,
    extractValue: (m) => m[1]!,
  },
  {
    category: "tool",
    key: "preferred_editor",
    pattern: /\b(?:i (?:use|prefer|like))\s+(vscode|vim|neovim|emacs|sublime|intellij|cursor)\b/i,
    extractValue: (m) => m[1]!,
  },
  {
    category: "tool",
    key: "preferred_package_manager",
    pattern: /\b(?:i (?:use|prefer|like|always use))\s+(npm|yarn|pnpm|bun)\b/i,
    extractValue: (m) => m[1]!,
  },
  {
    category: "style",
    key: "code_style",
    pattern: /\b(?:i (?:prefer|like|use))\s+(tabs|spaces|2 spaces|4 spaces|semicolons|no semicolons)\b/i,
    extractValue: (m) => m[1]!,
  },
  {
    category: "workflow",
    key: "preferred_workflow",
    pattern: /\b(?:i (?:always|usually|prefer to))\s+(test first|write tests|review before|commit often|squash commits)\b/i,
    extractValue: (m) => m[1]!,
  },
  {
    category: "communication",
    key: "communication_style",
    pattern: /\b(?:i (?:prefer|like|want))\s+(brief|detailed|verbose|concise|step by step)\s+(?:responses?|explanations?|answers?)\b/i,
    extractValue: (m) => m[1]!,
  },
  {
    category: "tool",
    key: "preferred_framework",
    pattern: /\b(?:i (?:use|prefer|like|build with))\s+(react|vue|angular|svelte|next\.?js|nuxt|express|fastapi|django|flask|spring)\b/i,
    extractValue: (m) => m[1]!,
  },
];

export class UserModelManager {
  private readonly db: DatabaseSync;
  private readonly config: Required<UserModelConfig>;

  constructor(db: DatabaseSync, config?: UserModelConfig) {
    this.db = db;
    this.config = {
      enabled: config?.enabled ?? true,
      extractPreferences: config?.extractPreferences ?? true,
      detectPatterns: config?.detectPatterns ?? true,
    };
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        evidence_ids TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(category, key)
      );
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_user_prefs_category ON user_preferences(category);`,
    );
  }

  /**
   * Extract preferences from text during indexing.
   * Returns newly detected or updated preferences.
   */
  extractPreferences(text: string, evidenceChunkId?: string): UserPreference[] {
    if (!this.config.enabled || !this.config.extractPreferences) return [];

    const extracted: UserPreference[] = [];
    const now = Date.now();

    for (const spec of PREFERENCE_PATTERNS) {
      const match = text.match(spec.pattern);
      if (!match) continue;

      const value = spec.extractValue(match).toLowerCase().trim();
      if (!value) continue;

      const id = crypto.randomUUID();
      const evidence = evidenceChunkId ? [evidenceChunkId] : [];

      // Upsert: if we already have this preference, boost confidence
      const existing = this.db
        .prepare(`SELECT id, confidence, evidence_ids FROM user_preferences WHERE category = ? AND key = ?`)
        .get(spec.category, spec.key) as { id: string; confidence: number; evidence_ids: string } | undefined;

      if (existing) {
        let existingEvidence: string[] = [];
        try { existingEvidence = JSON.parse(existing.evidence_ids); } catch {}
        if (evidenceChunkId && !existingEvidence.includes(evidenceChunkId)) {
          existingEvidence.push(evidenceChunkId);
        }
        const newConfidence = Math.min(1, existing.confidence + 0.1);
        this.db
          .prepare(
            `UPDATE user_preferences SET value = ?, confidence = ?, evidence_ids = ?, updated_at = ? WHERE id = ?`,
          )
          .run(value, newConfidence, JSON.stringify(existingEvidence), now, existing.id);

        extracted.push({
          id: existing.id,
          category: spec.category,
          key: spec.key,
          value,
          confidence: newConfidence,
          evidenceIds: existingEvidence,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        this.db
          .prepare(
            `INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, spec.category, spec.key, value, 0.5, JSON.stringify(evidence), now, now);

        extracted.push({
          id,
          category: spec.category,
          key: spec.key,
          value,
          confidence: 0.5,
          evidenceIds: evidence,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return extracted;
  }

  /**
   * Get the current user profile summary.
   */
  getUserProfile(): UserProfile {
    const rows = this.db
      .prepare(
        `SELECT id, category, key, value, confidence, evidence_ids, created_at, updated_at
         FROM user_preferences
         ORDER BY confidence DESC, updated_at DESC`,
      )
      .all() as Array<{
        id: string;
        category: string;
        key: string;
        value: string;
        confidence: number;
        evidence_ids: string;
        created_at: number;
        updated_at: number;
      }>;

    const preferences: UserPreference[] = rows.map((r) => ({
      id: r.id,
      category: r.category as UserPreference["category"],
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      evidenceIds: (() => { try { return JSON.parse(r.evidence_ids); } catch { return []; } })(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { preferences, patterns: [] };
  }

  /**
   * Detect recurring patterns from crystal data. Called during dream extrapolation.
   */
  detectPatterns(texts: string[]): UserPattern[] {
    if (!this.config.enabled || !this.config.detectPatterns) return [];
    if (texts.length < 3) return [];

    const patterns: UserPattern[] = [];
    const now = Date.now();

    // Detect recurring action patterns (verbs + nouns appearing across multiple texts)
    const actionFreq = new Map<string, number>();
    for (const text of texts) {
      const actions = text.match(/\b(?:always|usually|often|prefer to|tend to|like to)\s+\w+(?:\s+\w+)?/gi);
      if (actions) {
        for (const action of actions) {
          const normalized = action.toLowerCase().trim();
          actionFreq.set(normalized, (actionFreq.get(normalized) ?? 0) + 1);
        }
      }
    }

    for (const [pattern, freq] of actionFreq) {
      if (freq >= 2) {
        patterns.push({
          pattern,
          frequency: freq,
          lastOccurrence: now,
          predictiveValue: Math.min(1, freq / texts.length),
        });
      }
    }

    return patterns.sort((a, b) => b.frequency - a.frequency).slice(0, 10);
  }

  /**
   * Route an LLM-extracted directive fact into user_preferences.
   * Uses heuristic keyword matching to classify category and derive a key.
   */
  upsertFromDirective(fact: { text: string; confidence: number; sessionId: string }): UserPreference | null {
    if (!this.config.enabled) return null;
    const text = fact.text.trim();
    if (!text || text.length < 5) return null;

    const lower = text.toLowerCase();
    const now = Date.now();

    // Classify category via keyword heuristics
    let category: UserPreference["category"];
    if (/\b(?:my name is|i am a|i work (?:as|at|for|in)|i'm based in|i live in|born in)\b/i.test(lower)) {
      category = "identity";
    } else if (/\b(?:project|repo|app|product|codebase|monorepo|workspace)\b/i.test(lower)) {
      category = "project";
    } else if (/\b(?:api|framework|library|database|server|deploy|docker|kubernetes|ci\/cd|infra)\b/i.test(lower)) {
      category = "technical";
    } else if (/\b(?:always|never|prefer|don't|do not|must|should)\b/i.test(lower)) {
      category = "directive";
    } else {
      category = "directive";
    }

    // Derive key from significant words (skip stop words, take first 5)
    const STOP_WORDS = new Set([
      "i", "me", "my", "the", "a", "an", "is", "am", "are", "was", "were",
      "be", "been", "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "that", "this", "it", "and", "or", "but", "not", "do", "does", "did",
      "have", "has", "had", "will", "would", "should", "can", "could",
    ]);
    const words = lower.replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(
      (w) => w.length > 2 && !STOP_WORDS.has(w),
    );
    const key = words.slice(0, 5).join("_") || `directive_${now}`;

    // Upsert: boost confidence for existing, insert for new
    const existing = this.db
      .prepare(`SELECT id, value, confidence, evidence_ids FROM user_preferences WHERE category = ? AND key = ?`)
      .get(category, key) as { id: string; value: string; confidence: number; evidence_ids: string } | undefined;

    if (existing) {
      let evidenceIds: string[] = [];
      try { evidenceIds = JSON.parse(existing.evidence_ids); } catch { /* empty */ }
      if (fact.sessionId && !evidenceIds.includes(fact.sessionId)) {
        evidenceIds.push(fact.sessionId);
      }

      // Plan 7, Phase 4: Bayesian-style confidence calibration
      const isContradiction = this.detectContradiction(existing.value ?? "", text);
      let newConfidence: number;

      if (isContradiction) {
        // Contradiction: erode confidence, update value to newer
        newConfidence = Math.max(0.1, existing.confidence * 0.6);
      } else {
        // Corroboration: Bayesian-style update (logarithmic growth)
        // Same session = weaker signal, different session = stronger
        const sameSession = evidenceIds.some(id => id.startsWith(fact.sessionId));
        const decayFactor = sameSession ? 0.7 : 0.6;
        newConfidence = Math.min(1.0, 1 - (1 - existing.confidence) * decayFactor);
      }

      const updatedValue = isContradiction ? text : (existing as Record<string, unknown>).value as string ?? text;
      this.db
        .prepare(
          `UPDATE user_preferences SET value = ?, confidence = ?, evidence_ids = ?, updated_at = ? WHERE id = ?`,
        )
        .run(updatedValue, newConfidence, JSON.stringify(evidenceIds.slice(-10)), now, existing.id);

      return {
        id: existing.id,
        category,
        key,
        value: updatedValue,
        confidence: newConfidence,
        evidenceIds,
        createdAt: now,
        updatedAt: now,
      };
    }

    const id = crypto.randomUUID();
    const evidenceIds = fact.sessionId ? [fact.sessionId] : [];
    this.db
      .prepare(
        `INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, category, key, text, fact.confidence, JSON.stringify(evidenceIds), now, now);

    log.debug(`Upserted directive preference: [${category}] ${key} (confidence: ${fact.confidence})`);

    return {
      id,
      category,
      key,
      value: text,
      confidence: fact.confidence,
      evidenceIds,
      createdAt: now,
      updatedAt: now,
    };
  }

  private detectContradiction(existing: string, incoming: string): boolean {
    const existLower = existing.toLowerCase();
    const incomingLower = incoming.toLowerCase();

    // Direct negation patterns
    if (
      (existLower.includes("prefer") && incomingLower.includes("don't prefer")) ||
      (existLower.includes("always") && incomingLower.includes("never")) ||
      (existLower.includes("never") && incomingLower.includes("always"))
    ) {
      return true;
    }

    // Short values with same key but different content = contradiction
    if (existing.length < 30 && incoming.length < 30 && existLower !== incomingLower) {
      return true;
    }

    return false;
  }
}
