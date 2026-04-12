/**
 * MemoryGovernance: access control, privacy tagging, provenance tracking,
 * TTL enforcement, and audit logging for Knowledge Crystals.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { ProvenanceNode } from "./crystal-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureColumn } from "./memory-schema.js";

const log = createSubsystemLogger("memory/governance");

export type AccessContext = {
  actor: string;
  purpose: string;
  sessionKey?: string;
};

export type ProvenanceEvent = {
  event: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
};

export type ProvenanceTree = {
  node: ProvenanceNode;
  parents: ProvenanceTree[];
};

export class MemoryGovernance {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // Ensure audit log has governance columns
    ensureColumn(db, "memory_audit_log", "operation", "TEXT");
    ensureColumn(db, "memory_audit_log", "context_json", "TEXT DEFAULT '{}'");
  }

  /**
   * Check if a crystal can be accessed in the given context.
   * Enforces real access control based on scope, sensitivity, and actor.
   */
  canAccess(crystalId: string, context: AccessContext): boolean {
    const row = this.db
      .prepare(`SELECT governance_json, lifecycle FROM chunks WHERE id = ?`)
      .get(crystalId) as { governance_json: string | null; lifecycle: string | null } | undefined;

    if (!row) return false;

    // Expired crystals are not accessible
    if (row.lifecycle === "expired") return false;

    try {
      const governance = row.governance_json ? JSON.parse(row.governance_json) : {};

      // Confidential crystals: never share externally
      if (governance.sensitivity === "confidential") {
        return context.actor === "local_agent";
      }

      // Private: only local agent
      if (governance.accessScope === "private") {
        return context.actor === "local_agent";
      }

      // Shared: local agent + authenticated sessions
      if (governance.accessScope === "shared") {
        if (context.actor === "local_agent") return true;
        if (context.sessionKey) return true; // authenticated session
        return false;
      }

      // Public: anyone
      if (governance.accessScope === "public") return true;
    } catch (err) {
      log.warn(`canAccess: failed to parse governance for crystal ${crystalId}: ${String(err)}`);
    }

    // Default: allow local agent, deny others
    return context.actor === "local_agent";
  }

  /**
   * Detect and tag sensitive content.
   */
  tagSensitivity(text: string): "normal" | "personal" | "confidential" {
    const lower = text.toLowerCase();

    // Confidential patterns
    if (
      /\b(?:password|secret|api[_\s]?key|token|credential|private[_\s]?key|ssh[_\s]?key)\b/i.test(
        lower,
      )
    ) {
      return "confidential";
    }

    // Personal patterns
    if (
      /\b(?:my name|my email|my phone|my address|birthday|social security|ssn|credit card)\b/i.test(
        lower,
      )
    ) {
      return "personal";
    }
    if (/\b(?:i feel|i think|personally|my opinion|my preference)\b/i.test(lower)) {
      return "personal";
    }

    return "normal";
  }

  /**
   * Record provenance event for a crystal.
   */
  recordProvenance(crystalId: string, event: ProvenanceEvent): void {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata, operation, context_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          crystalId,
          event.event,
          now,
          "governance",
          JSON.stringify({ sourceId: event.sourceId, ...event.metadata }),
          "provenance",
          "{}",
        );

      // Update provenance chain on the crystal
      if (event.sourceId) {
        const current = this.db
          .prepare(`SELECT provenance_chain FROM chunks WHERE id = ?`)
          .get(crystalId) as { provenance_chain: string | null } | undefined;

        let chain: string[] = [];
        try {
          if (current?.provenance_chain) {
            chain = JSON.parse(current.provenance_chain);
          }
        } catch (err) {
          log.debug(`invalid provenance_chain JSON for crystal ${crystalId}: ${String(err)}`);
        }

        if (!chain.includes(event.sourceId)) {
          chain.push(event.sourceId);
          this.db
            .prepare(`UPDATE chunks SET provenance_chain = ? WHERE id = ?`)
            .run(JSON.stringify(chain), crystalId);
        }
      }
    } catch (err) {
      log.warn(`failed to record provenance: ${String(err)}`);
    }
  }

  /**
   * Enforce TTL-based lifespan policies. Returns count of expired crystals.
   */
  enforceLifespan(): number {
    const now = Date.now();
    let expired = 0;

    try {
      // Find crystals with TTL policies that have expired
      const rows = this.db
        .prepare(
          `SELECT id, governance_json, created_at FROM chunks
           WHERE COALESCE(lifecycle, 'generated') NOT IN ('expired', 'frozen')
             AND governance_json LIKE '%ttl%'`,
        )
        .all() as Array<{ id: string; governance_json: string; created_at: number | null }>;

      for (const row of rows) {
        try {
          const governance = JSON.parse(row.governance_json);
          if (governance.lifespanPolicy === "ttl" && governance.ttlMs) {
            const createdAt = row.created_at ?? 0;
            if (now - createdAt > governance.ttlMs) {
              this.db
                .prepare(
                  `UPDATE chunks SET lifecycle = 'expired', lifecycle_state = 'forgotten' WHERE id = ?`,
                )
                .run(row.id);
              expired++;
            }
          }
        } catch (err) {
          log.debug(`failed to parse governance for TTL check on ${row.id}: ${String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`lifespan enforcement failed: ${String(err)}`);
    }

    return expired;
  }

  /**
   * Log an access event for audit.
   */
  logAccess(crystalId: string, operation: string, context: AccessContext): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata, operation, context_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          crystalId,
          "accessed",
          Date.now(),
          context.actor,
          JSON.stringify({ purpose: context.purpose }),
          operation,
          JSON.stringify(context),
        );
    } catch {
      // Non-critical
    }
  }

  // ── Provenance DAG ──

  /**
   * Record a provenance node in the crystal's provenance DAG.
   */
  recordProvenanceNode(crystalId: string, node: ProvenanceNode): void {
    try {
      const row = this.db
        .prepare(`SELECT provenance_dag FROM chunks WHERE id = ?`)
        .get(crystalId) as { provenance_dag: string | null } | undefined;

      let dag: ProvenanceNode[] = [];
      try {
        if (row?.provenance_dag) dag = JSON.parse(row.provenance_dag);
      } catch (err) {
        log.debug(`invalid provenance_dag JSON for crystal ${crystalId}: ${String(err)}`);
      }

      dag.push(node);

      this.db
        .prepare(`UPDATE chunks SET provenance_dag = ? WHERE id = ?`)
        .run(JSON.stringify(dag), crystalId);
    } catch (err) {
      log.warn(`failed to record provenance node: ${String(err)}`);
    }
  }

  /**
   * Get the full provenance DAG for a crystal.
   */
  getProvenanceDAG(crystalId: string): ProvenanceNode[] {
    const row = this.db.prepare(`SELECT provenance_dag FROM chunks WHERE id = ?`).get(crystalId) as
      | { provenance_dag: string | null }
      | undefined;

    if (!row?.provenance_dag) return [];
    try {
      return JSON.parse(row.provenance_dag);
    } catch {
      return [];
    }
  }

  /**
   * Get the derivation tree for a crystal (recursive parents).
   */
  getDerivationTree(crystalId: string, maxDepth = 5): ProvenanceTree | null {
    const dag = this.getProvenanceDAG(crystalId);
    if (dag.length === 0) return null;

    const rootNode = dag[dag.length - 1]; // most recent operation
    if (!rootNode) return null;

    return this.buildTree(rootNode, maxDepth, new Set());
  }

  /**
   * Get all unique actors who contributed to a crystal's lineage.
   */
  getAttributionChain(crystalId: string): string[] {
    const actors = new Set<string>();
    const visited = new Set<string>();
    const queue = [crystalId];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const dag = this.getProvenanceDAG(id);
      for (const node of dag) {
        actors.add(node.actor);
        for (const parentId of node.parentIds) {
          if (!visited.has(parentId)) queue.push(parentId);
        }
      }
    }

    return [...actors];
  }

  private buildTree(node: ProvenanceNode, depth: number, visited: Set<string>): ProvenanceTree {
    visited.add(node.crystalId);
    const parents: ProvenanceTree[] = [];

    if (depth > 0) {
      for (const parentId of node.parentIds) {
        if (visited.has(parentId)) continue;
        const parentDag = this.getProvenanceDAG(parentId);
        const parentNode = parentDag[parentDag.length - 1];
        if (parentNode) {
          parents.push(this.buildTree(parentNode, depth - 1, visited));
        }
      }
    }

    return { node, parents };
  }

  /**
   * Get governance statistics for status reporting.
   */
  getStats(): {
    totalAuditEntries: number;
    sensitivityCounts: { normal: number; personal: number; confidential: number };
    lifecycleCounts: Record<string, number>;
  } {
    const auditCount =
      (this.db.prepare(`SELECT COUNT(*) as c FROM memory_audit_log`).get() as { c: number })?.c ??
      0;

    const lifecycleRows = this.db
      .prepare(
        `SELECT COALESCE(lifecycle, 'generated') as lc, COUNT(*) as c FROM chunks GROUP BY lc`,
      )
      .all() as Array<{ lc: string; c: number }>;

    const lifecycleCounts: Record<string, number> = {};
    for (const row of lifecycleRows) {
      lifecycleCounts[row.lc] = row.c;
    }

    // Count sensitivity by scanning governance_json
    const sensitivityCounts = { normal: 0, personal: 0, confidential: 0 };
    try {
      const gRows = this.db
        .prepare(
          `SELECT governance_json FROM chunks WHERE governance_json IS NOT NULL AND governance_json != '{}'`,
        )
        .all() as Array<{ governance_json: string }>;

      for (const row of gRows) {
        try {
          const g = JSON.parse(row.governance_json);
          const s = g.sensitivity ?? "normal";
          if (s in sensitivityCounts) {
            sensitivityCounts[s as keyof typeof sensitivityCounts]++;
          }
        } catch {
          // Non-critical: skip rows with corrupted governance JSON
        }
      }
    } catch (err) {
      log.debug(`getStats: failed to query sensitivity counts: ${String(err)}`);
    }

    return { totalAuditEntries: auditCount, sensitivityCounts, lifecycleCounts };
  }
}
