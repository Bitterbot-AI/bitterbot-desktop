/**
 * MemStore: publish/subscribe for Knowledge Crystal exchange.
 *
 * Extends the P2P skill propagation pattern to support any crystal type.
 * Manages local crystal sharing visibility and provides hooks for
 * peer-to-peer crystal import with governance-enforced access control.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import type { KnowledgeCrystal, CrystalSemanticType, CrystalLifecycle } from "./crystal-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { rowToCrystal } from "./crystal.js";
import { ensureColumn } from "./memory-schema.js";

const log = createSubsystemLogger("memory/mem-store");

export type CrystalFilter = {
  semanticTypes?: CrystalSemanticType[];
  lifecycles?: CrystalLifecycle[];
  minImportance?: number;
  maxAge?: number; // ms
};

export type CrystalSubscription = {
  id: string;
  filter: CrystalFilter;
  callback: (crystal: KnowledgeCrystal) => void;
  createdAt: number;
};

export type PublishResult = {
  crystalId: string;
  visibility: "shared" | "public";
  publishedAt: number;
};

export type ImportResult = {
  ok: boolean;
  action: "accepted" | "rejected";
  crystalId?: string;
  reason?: string;
};

export class MemStore {
  private readonly db: DatabaseSync;
  private readonly subscriptions = new Map<string, CrystalSubscription>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    ensureColumn(this.db, "chunks", "publish_visibility", "TEXT");
    ensureColumn(this.db, "chunks", "published_at", "INTEGER");
  }

  /**
   * Publish a crystal for sharing by updating its governance visibility.
   */
  publish(crystalId: string, visibility: "shared" | "public"): PublishResult | null {
    const now = Date.now();

    const row = this.db
      .prepare(`SELECT id, governance_json FROM chunks WHERE id = ?`)
      .get(crystalId) as { id: string; governance_json: string | null } | undefined;

    if (!row) {
      log.warn(`publish: crystal ${crystalId} not found`);
      return null;
    }

    let governance: Record<string, unknown> = {};
    if (row.governance_json) {
      try {
        governance = JSON.parse(row.governance_json);
      } catch {
        log.warn(
          `corrupted governance_json for crystal ${crystalId}, updating publish fields only`,
        );
        // Don't overwrite corrupted governance — only update publish visibility
        this.db
          .prepare(`UPDATE chunks SET publish_visibility = ?, published_at = ? WHERE id = ?`)
          .run(visibility, now, crystalId);
        return { crystalId, visibility, publishedAt: now };
      }
    }

    governance.accessScope = visibility;

    this.db
      .prepare(
        `UPDATE chunks SET governance_json = ?, publish_visibility = ?, published_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(governance), visibility, now, crystalId);

    log.debug("crystal published", { crystalId, visibility });

    // Notify matching subscribers
    const crystal = this.getCrystal(crystalId);
    if (crystal) {
      this.notifySubscribers(crystal);
    }

    return { crystalId, visibility, publishedAt: now };
  }

  /**
   * Subscribe to crystal types matching a filter.
   */
  subscribe(filter: CrystalFilter, callback: (crystal: KnowledgeCrystal) => void): string {
    const id = crypto.randomUUID();
    this.subscriptions.set(id, {
      id,
      filter,
      callback,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * Unsubscribe from crystal notifications.
   */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /**
   * Import a crystal from a P2P peer via skill envelope.
   * Validates provenance and applies governance checks.
   */
  importFromPeer(envelope: SkillEnvelope, peerPubkey: string): ImportResult {
    // Verify envelope has required fields
    if (!envelope.content_hash || !envelope.skill_md) {
      return { ok: false, action: "rejected", reason: "invalid envelope" };
    }

    // Check for duplicate content
    const existing = this.db
      .prepare(`SELECT id FROM chunks WHERE hash = ?`)
      .get(envelope.content_hash) as { id: string } | undefined;

    if (existing) {
      return { ok: false, action: "rejected", reason: "duplicate content", crystalId: existing.id };
    }

    // Decode content
    let content: string;
    try {
      content = Buffer.from(envelope.skill_md, "base64").toString("utf-8");
    } catch {
      return { ok: false, action: "rejected", reason: "invalid content encoding" };
    }

    // Store as new crystal with peer provenance
    const id = crypto.randomUUID();
    const now = Date.now();
    const governance = JSON.stringify({
      accessScope: "shared",
      lifespanPolicy: "permanent",
      priority: 0.5,
      sensitivity: "normal",
      provenanceChain: [],
      peerOrigin: peerPubkey,
    });

    try {
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, importance_score, model, embedding, updated_at, lifecycle_state, lifecycle, semantic_type, governance_json, created_at)
           VALUES (?, ?, 'skills', 0, 0, ?, ?, 0.5, 'peer', '[]', ?, 'active', 'generated', 'skill', ?, ?)`,
        )
        .run(id, `peer/${envelope.name}`, content, envelope.content_hash, now, governance, now);

      log.debug("crystal imported from peer", { id, peer: peerPubkey, name: envelope.name });

      // Notify subscribers
      const crystal = this.getCrystal(id);
      if (crystal) {
        this.notifySubscribers(crystal);
      }

      return { ok: true, action: "accepted", crystalId: id };
    } catch (err) {
      log.warn(`import failed: ${String(err)}`);
      return { ok: false, action: "rejected", reason: String(err) };
    }
  }

  /**
   * Get published crystals matching a filter.
   */
  getPublished(filter?: CrystalFilter, limit = 50): KnowledgeCrystal[] {
    let sql = `SELECT * FROM chunks WHERE publish_visibility IS NOT NULL AND COALESCE(lifecycle, 'generated') != 'expired' AND COALESCE(deprecated, 0) = 0`;
    const params: (string | number | null)[] = [];

    if (filter?.semanticTypes?.length) {
      const placeholders = filter.semanticTypes.map(() => "?").join(",");
      sql += ` AND semantic_type IN (${placeholders})`;
      params.push(...filter.semanticTypes);
    }
    if (filter?.lifecycles?.length) {
      const placeholders = filter.lifecycles.map(() => "?").join(",");
      sql += ` AND lifecycle IN (${placeholders})`;
      params.push(...filter.lifecycles);
    }
    if (filter?.minImportance != null) {
      sql += ` AND importance_score >= ?`;
      params.push(filter.minImportance);
    }
    if (filter?.maxAge != null) {
      sql += ` AND published_at >= ?`;
      params.push(Date.now() - filter.maxAge);
    }

    sql += ` ORDER BY published_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToCrystal);
  }

  /**
   * Get the latest non-deprecated version of a skill by stable_skill_id.
   */
  getLatestVersion(stableSkillId: string): KnowledgeCrystal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM chunks
         WHERE stable_skill_id = ?
           AND COALESCE(deprecated, 0) = 0
         ORDER BY skill_version DESC
         LIMIT 1`,
      )
      .get(stableSkillId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }
    return rowToCrystal(row);
  }

  /**
   * Get version history for a stable skill ID.
   */
  getVersionHistory(stableSkillId: string): KnowledgeCrystal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chunks
         WHERE stable_skill_id = ?
         ORDER BY skill_version ASC`,
      )
      .all(stableSkillId) as Array<Record<string, unknown>>;

    return rows.map(rowToCrystal);
  }

  /**
   * Get subscription count.
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  private getCrystal(id: string): KnowledgeCrystal | null {
    const row = this.db.prepare(`SELECT * FROM chunks WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return null;
    }
    return rowToCrystal(row);
  }

  private notifySubscribers(crystal: KnowledgeCrystal): void {
    for (const sub of this.subscriptions.values()) {
      if (this.matchesFilter(crystal, sub.filter)) {
        try {
          sub.callback(crystal);
        } catch (err) {
          log.warn(`subscriber ${sub.id} callback failed: ${String(err)}`);
        }
      }
    }
  }

  private matchesFilter(crystal: KnowledgeCrystal, filter: CrystalFilter): boolean {
    if (filter.semanticTypes?.length && !filter.semanticTypes.includes(crystal.semanticType)) {
      return false;
    }
    if (filter.lifecycles?.length && !filter.lifecycles.includes(crystal.lifecycle)) {
      return false;
    }
    if (filter.minImportance != null && crystal.importanceScore < filter.minImportance) {
      return false;
    }
    if (filter.maxAge != null) {
      const age = Date.now() - crystal.createdAt;
      if (age > filter.maxAge) {
        return false;
      }
    }
    return true;
  }
}
