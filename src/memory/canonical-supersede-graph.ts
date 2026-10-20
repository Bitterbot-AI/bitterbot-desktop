/**
 * PLAN-55 Phase 2 (G4), consumer 4: knowledge-graph edges follow the ledger.
 *
 * An edge matches a change only when
 *
 * 1. one endpoint IS the old value (entity names are stored lowercased;
 *    compared exactly after trimming), and
 * 2. its relation type is one the key describes: an explicit key-segment
 *    -> relation map (KEY_SEGMENT_RELATIONS: employer -> works_at, home_city
 *    -> lives_in, language -> uses, spouse -> spouse_of, ...), or a key
 *    segment that is itself a relation name, and
 * 3. when the key names a subject of its own (`project.bitterbot.language`
 *    names "bitterbot"), the other endpoint is exactly that subject. Keys
 *    about the user (`user.employer`) name none and accept any endpoint.
 *
 * A matching, currently valid edge gets the existing `supersede` belief
 * action (KnowledgeGraphManager.supersedeRelationship). On a value change a
 * replacement edge to the new value is written with the same relation and
 * other endpoint; on the owner's retire there is no replacement. Closed and
 * added edges are recorded (canonical-propagation-undo.ts) so bringing the
 * value back reverses them.
 *
 * Bounded (MAX_EDGES_PER_EVENT) and idempotent: a closed edge no longer
 * matches, and the replacement upsert strengthens an existing edge instead of
 * duplicating it.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { canonicalChangeMarksStale, type CanonicalChangeEvent } from "./canonical-events.js";
import { recordUndo } from "./canonical-propagation-undo.js";
import { staleValueMatcher } from "./canonical-stale-match.js";
import type { EntityType, KnowledgeGraphManager, RelationType } from "./knowledge-graph.js";
import { factKeyValueHash, isSuppressed } from "./memory-suppressions.js";

const log = createSubsystemLogger("memory/canonical-propagation");

export const MAX_EDGES_PER_EVENT = 20;

/** Key segment -> the relation types that state it. Small and explicit on purpose. */
export const KEY_SEGMENT_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  employer: ["works_at", "works_for", "works_on", "employed_by"],
  company: ["works_at", "works_for", "employed_by"],
  workplace: ["works_at", "works_for"],
  job: ["works_at", "works_for"],
  home_city: ["lives_in", "located_at", "based_in"],
  home: ["lives_in", "located_at", "based_in"],
  city: ["lives_in", "located_at", "based_in"],
  location: ["lives_in", "located_at", "based_in"],
  country: ["lives_in", "located_at", "based_in"],
  language: ["uses"],
  framework: ["uses"],
  stack: ["uses"],
  editor: ["uses", "prefers"],
  database: ["uses", "depends_on"],
  runtime: ["uses"],
  dependency: ["depends_on"],
  manager: ["manages"],
  boss: ["manages"],
  spouse: ["spouse_of"],
  wife: ["spouse_of"],
  husband: ["spouse_of"],
  partner: ["spouse_of"],
  parent: ["parent_of"],
  mother: ["parent_of"],
  father: ["parent_of"],
  child: ["child_of"],
  son: ["child_of"],
  daughter: ["child_of"],
  sibling: ["sibling_of"],
  brother: ["sibling_of"],
  sister: ["sibling_of"],
  author: ["created_by"],
  creator: ["created_by"],
};

/** Relation names a key segment may name directly (`relationship.spouse_of`). */
const KNOWN_RELATIONS = new Set([
  "works_on",
  "works_at",
  "works_for",
  "employed_by",
  "manages",
  "depends_on",
  "uses",
  "created_by",
  "belongs_to",
  "located_at",
  "lives_in",
  "based_in",
  "part_of",
  "knows",
  "prefers",
  "spouse_of",
  "parent_of",
  "child_of",
  "sibling_of",
]);

/** Segments that name neither a relation nor a subject. */
const NON_SUBJECT = new Set([
  "user",
  "users",
  "me",
  "my",
  "identity",
  "project",
  "projects",
  "infra",
  "preference",
  "relationship",
  "other",
  "name",
  "value",
  "current",
  "default",
  "main",
  "primary",
]);

export type KeyGraphShape = {
  /** Relation types an edge must have to be about this key. */
  relations: Set<string>;
  /** Entity names the other endpoint must be (empty: any). */
  subjects: Set<string>;
};

/** What a key says about the graph: which relations, and which subject (if any). */
export function keyGraphShape(key: string): KeyGraphShape {
  const relations = new Set<string>();
  const subjects = new Set<string>();
  for (const seg of key.toLowerCase().split(".")) {
    if (KNOWN_RELATIONS.has(seg)) {
      relations.add(seg);
      continue;
    }
    const mapped =
      KEY_SEGMENT_RELATIONS[seg] ??
      seg.split(/[_-]+/).flatMap((part) => KEY_SEGMENT_RELATIONS[part] ?? []);
    if (mapped.length > 0) {
      mapped.forEach((r) => relations.add(r));
      continue;
    }
    if (!NON_SUBJECT.has(seg) && seg.length >= 2) {
      subjects.add(seg.replace(/[_-]+/g, " "));
    }
  }
  return { relations, subjects };
}

type EdgeRow = {
  id: string;
  relation_type: string;
  src_name: string;
  src_type: string;
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
  const shape = keyGraphShape(event.key);
  const relations = [...shape.relations];
  if (relations.length === 0) {
    return result; // the key says nothing the graph states
  }
  const oldName = event.oldValue!.trim().toLowerCase();
  let edges: EdgeRow[];
  try {
    edges = db
      .prepare(
        `SELECT r.id, r.relation_type,
                s.name AS src_name, s.entity_type AS src_type,
                t.name AS tgt_name, t.entity_type AS tgt_type
           FROM relationships r
           JOIN entities s ON s.id = r.source_entity_id
           JOIN entities t ON t.id = r.target_entity_id
          WHERE (s.name = ? OR t.name = ?) AND r.valid_until IS NULL
            AND r.relation_type IN (${relations.map(() => "?").join(",")})
          ORDER BY r.created_at DESC, r.id
          LIMIT ?`,
      )
      .all(oldName, oldName, ...relations, MAX_EDGES_PER_EVENT * 5) as unknown as EdgeRow[];
  } catch {
    return result; // no graph tables on this database
  }
  const newValue =
    event.newValue &&
    !isSuppressed(db, "fact_key_value", factKeyValueHash(event.key, event.newValue))
      ? event.newValue.trim()
      : null;
  for (const edge of edges) {
    if (result.superseded >= MAX_EDGES_PER_EVENT) {
      break;
    }
    const oldIsTarget = edge.tgt_name === oldName;
    const otherName = oldIsTarget ? edge.src_name : edge.tgt_name;
    if (shape.subjects.size > 0 && !shape.subjects.has(otherName)) {
      continue;
    }
    const replacement = newValue
      ? {
          sourceName: oldIsTarget ? edge.src_name : newValue,
          sourceType: edge.src_type as EntityType,
          targetName: oldIsTarget ? newValue : edge.tgt_name,
          targetType: edge.tgt_type as EntityType,
          relationType: edge.relation_type as RelationType,
        }
      : undefined;
    try {
      const added = kg.supersedeRelationship(edge.id, replacement);
      recordUndo(db, event.key, event.oldValue!, "edge_closed", { id: edge.id });
      if (added) {
        recordUndo(db, event.key, event.oldValue!, "edge_added", { id: added.id });
      }
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
