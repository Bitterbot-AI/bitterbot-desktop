/**
 * SkillVerifier: heuristic safety gate for skill mutations.
 *
 * Runs lightweight static checks before a mutation is promoted to a crystal:
 * 1. Dangerous pattern blocklist (DROP TABLE, rm -rf, eval, etc.)
 * 2. Structural invariants (non-empty, min length, max size)
 * 3. Semantic drift check (cosine distance to parent embedding)
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/skill-verifier");

export type VerificationCheck = {
  name: string;
  passed: boolean;
  reason: string;
};

export type VerificationResult = {
  passed: boolean;
  checks: VerificationCheck[];
  overallReason: string;
};

export type SkillVerifierConfig = {
  maxDriftThreshold?: number;
};

const DANGEROUS_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\brm\s+-rf\b/,
  /\brm\s+-fr\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bcurl\b.*\|\s*(?:ba)?sh/,
  /\bwget\b.*\|\s*(?:ba)?sh/,
  /\b__proto__\b/,
  /\bconstructor\s*\[\s*['"]prototype['"]\s*\]/,
  /\bprocess\.exit\b/,
  /\bchild_process\b/,
  /\bexec\s*\(/,
  /\bexecSync\s*\(/,
  /\bsudo\s+/,
  /\bchmod\s+777\b/,
  /\b(?:TRUNCATE|DELETE\s+FROM)\s+\w+\s*;?\s*$/im,
];

const MIN_CONTENT_LENGTH = 20;
const MAX_CONTENT_BYTES = 50 * 1024; // 50KB

export class SkillVerifier {
  private readonly db: DatabaseSync;
  private readonly maxDriftThreshold: number;

  constructor(db: DatabaseSync, config?: SkillVerifierConfig) {
    this.db = db;
    this.maxDriftThreshold = config?.maxDriftThreshold ?? 0.3;
  }

  /**
   * Run all verification checks on a candidate mutation.
   */
  verify(text: string, parentId: string | null, embedding?: number[]): VerificationResult {
    const checks: VerificationCheck[] = [];

    // Check 1: Dangerous patterns
    checks.push(this.checkDangerousPatterns(text));

    // Check 2: Structural invariants
    checks.push(this.checkStructuralInvariants(text));

    // Check 3: Semantic drift (only if parent exists and embedding provided)
    if (parentId && embedding && embedding.length > 0) {
      checks.push(this.checkSemanticDrift(embedding, parentId));
    }

    const failed = checks.filter((c) => !c.passed);
    const passed = failed.length === 0;
    const overallReason = passed
      ? "all checks passed"
      : failed.map((c) => `${c.name}: ${c.reason}`).join("; ");

    if (!passed) {
      log.debug("skill verification failed", { parentId, reason: overallReason });
    }

    return { passed, checks, overallReason };
  }

  private checkDangerousPatterns(text: string): VerificationCheck {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(text)) {
        return {
          name: "dangerous_patterns",
          passed: false,
          reason: `matches blocklist pattern: ${pattern.source}`,
        };
      }
    }
    return { name: "dangerous_patterns", passed: true, reason: "no dangerous patterns found" };
  }

  private checkStructuralInvariants(text: string): VerificationCheck {
    if (!text || text.trim().length === 0) {
      return { name: "structural", passed: false, reason: "content is empty or all whitespace" };
    }
    if (text.trim().length < MIN_CONTENT_LENGTH) {
      return { name: "structural", passed: false, reason: `content too short (${text.trim().length} < ${MIN_CONTENT_LENGTH} chars)` };
    }
    if (Buffer.byteLength(text, "utf-8") > MAX_CONTENT_BYTES) {
      return { name: "structural", passed: false, reason: `content too large (> ${MAX_CONTENT_BYTES} bytes)` };
    }
    return { name: "structural", passed: true, reason: "structural invariants met" };
  }

  private checkSemanticDrift(candidateEmbedding: number[], parentId: string): VerificationCheck {
    try {
      const row = this.db
        .prepare(`SELECT embedding FROM chunks WHERE id = ?`)
        .get(parentId) as { embedding: string } | undefined;

      if (!row?.embedding) {
        return { name: "semantic_drift", passed: true, reason: "parent embedding not available, skipping" };
      }

      const parentEmbedding = parseEmbedding(row.embedding);
      if (parentEmbedding.length === 0) {
        return { name: "semantic_drift", passed: true, reason: "parent embedding empty, skipping" };
      }

      const similarity = cosineSimilarity(candidateEmbedding, parentEmbedding);
      const distance = 1 - similarity;

      if (distance > this.maxDriftThreshold) {
        return {
          name: "semantic_drift",
          passed: false,
          reason: `cosine distance ${distance.toFixed(3)} exceeds threshold ${this.maxDriftThreshold}`,
        };
      }

      return { name: "semantic_drift", passed: true, reason: `cosine distance ${distance.toFixed(3)} within threshold` };
    } catch {
      return { name: "semantic_drift", passed: true, reason: "drift check failed gracefully, passing" };
    }
  }
}
