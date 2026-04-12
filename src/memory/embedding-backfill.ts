/**
 * Embedding Backfill: iterates over chunks missing perspective embeddings
 * and generates them in batches, respecting the MemoryScheduler's budget.
 */

import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingPerspective } from "./crystal-types.js";
import type { EmbeddingProvider } from "./embedding-perspectives.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { embedSinglePerspective } from "./embedding-perspectives.js";

const log = createSubsystemLogger("memory/embedding-backfill");

export type BackfillConfig = {
  batchSize?: number;
  perspectives?: EmbeddingPerspective[];
};

const DEFAULT_CONFIG: Required<BackfillConfig> = {
  batchSize: 10,
  perspectives: ["procedural", "causal", "entity"],
};

const PERSPECTIVE_COLUMNS: Record<EmbeddingPerspective, string> = {
  semantic: "embedding",
  procedural: "embedding_procedural",
  causal: "embedding_causal",
  entity: "embedding_entity",
};

/**
 * Backfill missing perspective embeddings for chunks.
 * Returns the number of embeddings generated.
 */
export async function backfillEmbeddings(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  config?: BackfillConfig,
): Promise<{ generated: number; perspective: string }[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const results: Array<{ generated: number; perspective: string }> = [];

  for (const perspective of cfg.perspectives) {
    const column = PERSPECTIVE_COLUMNS[perspective];
    if (!column) {
      continue;
    }

    // Find chunks missing this perspective's embedding
    const chunks = db
      .prepare(
        `SELECT id, text FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
           AND (${column} IS NULL OR ${column} = '' OR ${column} = '[]')
           AND text IS NOT NULL AND text != ''
         LIMIT ?`,
      )
      .all(cfg.batchSize) as Array<{ id: string; text: string }>;

    if (chunks.length === 0) {
      results.push({ generated: 0, perspective });
      continue;
    }

    let generated = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await embedSinglePerspective(chunk.text, perspective, provider);
        if (embedding.length > 0) {
          db.prepare(`UPDATE chunks SET ${column} = ? WHERE id = ?`).run(
            JSON.stringify(embedding),
            chunk.id,
          );
          generated++;
        }
      } catch (err) {
        log.debug(
          `backfill failed for chunk ${chunk.id} perspective ${perspective}: ${String(err)}`,
        );
      }
    }

    results.push({ generated, perspective });
    if (generated > 0) {
      log.debug(`backfilled ${generated} ${perspective} embeddings`);
    }
  }

  return results;
}

/**
 * Count how many chunks are missing each perspective embedding.
 */
export function countMissingEmbeddings(db: DatabaseSync): Record<EmbeddingPerspective, number> {
  const result: Record<EmbeddingPerspective, number> = {
    semantic: 0,
    procedural: 0,
    causal: 0,
    entity: 0,
  };

  for (const [perspective, column] of Object.entries(PERSPECTIVE_COLUMNS)) {
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) as c FROM chunks
           WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                  OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
             AND (${column} IS NULL OR ${column} = '' OR ${column} = '[]')`,
        )
        .get() as { c: number };
      result[perspective as EmbeddingPerspective] = row?.c ?? 0;
    } catch {
      // Column might not exist yet
    }
  }

  return result;
}
