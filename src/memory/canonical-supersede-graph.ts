/**
 * PLAN-55 Phase 2 (G4), consumer 4: knowledge-graph edges follow the ledger.
 *
 * An edge matches a change when one endpoint IS the old value (entity names
 * are stored lowercased; compared exactly after trimming) and the edge is
 * about the same thing as the key: its relation type or the other
 * endpoint's name shares a token with the key (category and generic tokens
 * like `user` or `name` do not count). A matching, currently valid edge gets
 * the existing `supersede` belief action (KnowledgeGraphManager
 * .supersedeRelationship: the old edge's validity window closes and the
 * belief history records it). On a value change the replacement edge is
 * written to the new value with the same relation and other endpoint; on
 * the owner's retire the edge is closed with no replacement.
 *
 * Bounded: values the search consumer would skip are skipped here, at most
 * MAX_EDGES_PER_EVENT edges per event. Idempotent: a closed edge no longer
 * matches (valid_until IS NOT NULL), and the replacement upsert strengthens
 * an existing edge instead of duplicating it.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { canonicalChangeMarksStale, type CanonicalChangeEvent } from "./canonical-events.js";
import { staleValueMatcher } from "./canonical-supersede-search.js";
import type { EntityType, KnowledgeGraphManager, RelationType } from "./knowledge-graph.js";
import { factKeyValueHash, isSuppressed } from "./memory-suppressions.js";

const log = createSubsystemLogger("memory/canonical-propagation");

export const MAX_EDGES_PER_EVENT = 20;

const GENERIC_KEY_TOKENS = new Set([
  "user",
  "users",
  "name",
  "value",
  "the",
  "my",
  "of",
  "current",
  "default",
  "main",
  "primary",
]);

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);

/** Tokens of the key that say what it is about (category segment and generic words dropped). */
export function keySubjectTokens(key: string): Set<string> {
  const segments = key.split(".");
  const rest = segments.length > 1 ? segments.slice(1).join(".") : key;
  return new Set(tokens(rest).filter((t) => !GENERIC_KEY_TOKENS.has(t)));
}

type EdgeRow = {
  id: string;
  relation_type: string;
  src_id: string;
  src_name: string;
  src_type: string;
  tgt_id: string;
  tgt_name: string;
  tgt_type: string;
};

export type GraphPropagationResult = { superseded: number };

export function propagateToKnowledgeGraph(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  event: CanonicalChangeEvent,
): GraphPropagationResult {
  const result: GraphPropagationResult = { superseded: 0 };
  if (!canonicalChangeMarksStale(event) || !staleValueMatcher(event.oldValue)) {
    return result;
  }
  const subject = keySubjectTokens(event.key);
  if (subject.size === 0) {
    return result;
  }
  const oldName = event.oldValue!.trim().toLowerCase();
  let edges: EdgeRow[];
  try {
    edges = db
      .prepare(
        `SELECT r.id, r.relation_type,
                s.id AS src_id, s.name AS src_name, s.entity_type AS src_type,
                t.id AS tgt_id, t.name AS tgt_name, t.entity_type AS tgt_type
           FROM entities e
           JOIN relationships r
             ON (r.source_entity_id = e.id OR r.target_entity_id = e.id)
           JOIN entities s ON s.id = r.source_entity_id
           JOIN entities t ON t.id = r.target_entity_id
          WHERE e.name = ? AND r.valid_until IS NULL
          LIMIT ?`,
      )
      .all(oldName, MAX_EDGES_PER_EVENT * 5) as unknown as EdgeRow[];
  } catch {
    return result; // no graph tables on this database
  }
  // The replacement value must not be one the owner retired for this key.
  const newValue =
    event.newValue &&
    !isSuppressed(db, "fact_key_value", factKeyValueHash(event.key, event.newValue))
      ? event.newValue.trim()
      : null;
  for (const edge of edges) {
    if (result.superseded >= MAX_EDGES_PER_EVENT) {
      break;
    }
    const oldIsSource = edge.src_name === oldName;
    const otherName = oldIsSource ? edge.tgt_name : edge.src_name;
    const about = new Set([...tokens(edge.relation_type), ...tokens(otherName)]);
    if (![...subject].some((t) => about.has(t))) {
      continue;
    }
    const replacement = newValue
      ? {
          sourceName: oldIsSource ? newValue : edge.src_name,
          sourceType: edge.src_type as EntityType,
          targetName: oldIsSource ? edge.tgt_name : newValue,
          targetType: edge.tgt_type as EntityType,
          relationType: edge.relation_type as RelationType,
        }
      : undefined;
    try {
      kg.supersedeRelationship(edge.id, replacement);
      result.superseded++;
    } catch (err) {
      log.debug(`graph supersede failed for edge ${edge.id.slice(0, 8)}: ${String(err)}`);
    }
  }
  if (result.superseded > 0) {
    log.info(`canonical:changed [${event.key}] superseded ${result.superseded} graph edge(s)`);
  }
  return result;
}
