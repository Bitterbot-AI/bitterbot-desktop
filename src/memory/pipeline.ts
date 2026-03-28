/**
 * MemoryPipeline: chainable memory operations for complex workflows.
 *
 * Provides a fluent API for building operation chains that retrieve,
 * filter, augment, and store Knowledge Crystals.
 */

import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeCrystal, CrystalSemanticType, CrystalLifecycle } from "./crystal-types.js";
import { rowToCrystal } from "./crystal.js";

export type PipelineResult = {
  crystals: KnowledgeCrystal[];
  retrieved: number;
  filtered: number;
  augmented: number;
  stored: number;
  durationMs: number;
};

type PipelineStep =
  | { type: "retrieve"; query: string; opts?: { limit?: number; semanticType?: CrystalSemanticType; lifecycle?: CrystalLifecycle } }
  | { type: "filter"; predicate: (c: KnowledgeCrystal) => boolean }
  | { type: "augment"; transform: (c: KnowledgeCrystal) => KnowledgeCrystal }
  | { type: "store"; opts?: { updateExisting?: boolean } };

export class MemoryPipeline {
  private steps: PipelineStep[] = [];

  static create(): MemoryPipeline {
    return new MemoryPipeline();
  }

  /**
   * Retrieve crystals matching a query and optional filters.
   */
  retrieve(
    query: string,
    opts?: { limit?: number; semanticType?: CrystalSemanticType; lifecycle?: CrystalLifecycle },
  ): MemoryPipeline {
    this.steps.push({ type: "retrieve", query, opts });
    return this;
  }

  /**
   * Filter crystals by a predicate function.
   */
  filter(predicate: (c: KnowledgeCrystal) => boolean): MemoryPipeline {
    this.steps.push({ type: "filter", predicate });
    return this;
  }

  /**
   * Transform each crystal (augmentation step).
   */
  augment(transform: (c: KnowledgeCrystal) => KnowledgeCrystal): MemoryPipeline {
    this.steps.push({ type: "augment", transform });
    return this;
  }

  /**
   * Store modified crystals back to the database.
   */
  store(opts?: { updateExisting?: boolean }): MemoryPipeline {
    this.steps.push({ type: "store", opts });
    return this;
  }

  /**
   * Execute the pipeline against a database.
   */
  async execute(db: DatabaseSync): Promise<PipelineResult> {
    const start = Date.now();
    let crystals: KnowledgeCrystal[] = [];
    const result: PipelineResult = {
      crystals: [],
      retrieved: 0,
      filtered: 0,
      augmented: 0,
      stored: 0,
      durationMs: 0,
    };

    for (const step of this.steps) {
      switch (step.type) {
        case "retrieve": {
          const limit = step.opts?.limit ?? 50;
          let sql = `SELECT * FROM chunks WHERE (COALESCE(lifecycle, 'generated') != 'expired') AND (COALESCE(lifecycle_state, 'active') != 'forgotten')`;
          const params: (string | number | null)[] = [];

          if (step.opts?.semanticType) {
            sql += ` AND semantic_type = ?`;
            params.push(step.opts.semanticType);
          }
          if (step.opts?.lifecycle) {
            sql += ` AND lifecycle = ?`;
            params.push(step.opts.lifecycle);
          }
          sql += ` ORDER BY importance_score DESC LIMIT ?`;
          params.push(limit);

          const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
          crystals = rows.map(rowToCrystal);
          result.retrieved = crystals.length;
          break;
        }
        case "filter": {
          const before = crystals.length;
          crystals = crystals.filter(step.predicate);
          result.filtered += before - crystals.length;
          break;
        }
        case "augment": {
          crystals = crystals.map(step.transform);
          result.augmented += crystals.length;
          break;
        }
        case "store": {
          if (step.opts?.updateExisting !== false) {
            const stmt = db.prepare(
              `UPDATE chunks SET importance_score = ?, semantic_type = ?, lifecycle = ? WHERE id = ?`,
            );
            for (const crystal of crystals) {
              stmt.run(crystal.importanceScore, crystal.semanticType, crystal.lifecycle, crystal.id);
            }
            result.stored = crystals.length;
          }
          break;
        }
      }
    }

    result.crystals = crystals;
    result.durationMs = Date.now() - start;
    return result;
  }
}
