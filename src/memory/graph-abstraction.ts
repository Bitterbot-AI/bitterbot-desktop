/**
 * PLAN-24 HORMA Phase 5: graph abstraction — build a hierarchy over the flat
 * SAGE entity graph so retrieval has an O(log N) coarse entry point.
 *
 * Offline (during dreams) we run cheap label-propagation community detection
 * over the relationship graph; each community of >= k entities gets one
 * LLM-synthesized SUMMARY entity, linked to its members by `summarizes` edges,
 * and each member's `parent_entity_id` points up at the summary. The reader can
 * then seed at the summary level when no exact entity matches and descend into
 * the relevant community, instead of scanning a flat frontier.
 *
 * Community detection is pure; the LLM is injected, so the builder is testable.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EntityType, KnowledgeGraphManager } from "./knowledge-graph.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/graph-abstraction");

/**
 * Synchronous label-propagation community detection over an undirected
 * adjacency map. Returns a map of nodeId -> community label. Deterministic:
 * ties resolve to the lexicographically smallest label.
 */
export function detectCommunities(
  adjacency: Map<string, Set<string>>,
  opts?: { maxIterations?: number },
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const id of adjacency.keys()) {
    labels.set(id, id);
  }
  const nodes = [...adjacency.keys()].toSorted();
  const maxIter = opts?.maxIterations ?? 20;

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const node of nodes) {
      const neighbors = adjacency.get(node);
      if (!neighbors || neighbors.size === 0) {
        continue;
      }
      const counts = new Map<string, number>();
      for (const nb of neighbors) {
        const l = labels.get(nb);
        if (l !== undefined) {
          counts.set(l, (counts.get(l) ?? 0) + 1);
        }
      }
      let best = labels.get(node)!;
      let bestCount = -1;
      for (const [label, count] of [...counts.entries()].toSorted((a, b) =>
        a[0] < b[0] ? -1 : 1,
      )) {
        if (count > bestCount) {
          bestCount = count;
          best = label;
        }
      }
      if (best !== labels.get(node)) {
        labels.set(node, best);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return labels;
}

/** Group node->label into label->nodes[]. */
export function groupCommunities(labels: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, label] of labels) {
    (out.get(label) ?? out.set(label, []).get(label)!).push(id);
  }
  return out;
}

export function buildSummaryPrompt(memberNames: string[]): string {
  return `You are organizing a knowledge graph. The following entities form one tightly-connected cluster:

${memberNames.map((n) => `- ${n}`).join("\n")}

Write a single SUMMARY node that captures what this cluster is about, so it can serve as a coarse navigation entry point above these entities.

Respond with ONLY a JSON object (no markdown fences):
{ "name": "a short 2-5 word summary label", "abstract": "one sentence describing what this cluster covers" }`;
}

export function parseSummary(raw: string): { name: string; abstract: string } | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    const o = JSON.parse(cleaned) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const abstract = typeof o.abstract === "string" ? o.abstract.trim() : "";
    if (name.length < 2) {
      return null;
    }
    return { name, abstract };
  } catch {
    return null;
  }
}

type EntityRow = { id: string; name: string; entity_type: string; parent_entity_id: string | null };

export type BuildAbstractionsResult = { created: number; communities: number };

/**
 * Build summary entities for communities of >= minCommunitySize entities that
 * are not already summarized. Idempotent: a community whose members already
 * have a parent is skipped.
 */
export async function buildGraphAbstractions(params: {
  db: DatabaseSync;
  kg: KnowledgeGraphManager;
  llmCall: (prompt: string) => Promise<string>;
  minCommunitySize?: number;
  maxCommunities?: number;
}): Promise<BuildAbstractionsResult> {
  const { db, kg, llmCall } = params;
  const minSize = params.minCommunitySize ?? 3;

  let rels: Array<{ s: string; t: string }>;
  try {
    rels = db
      .prepare(
        `SELECT source_entity_id AS s, target_entity_id AS t
         FROM relationships WHERE valid_until IS NULL`,
      )
      .all() as Array<{ s: string; t: string }>;
  } catch {
    return { created: 0, communities: 0 };
  }

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
  };
  for (const r of rels) {
    if (r.s && r.t && r.s !== r.t) {
      link(r.s, r.t);
      link(r.t, r.s);
    }
  }
  if (adjacency.size === 0) {
    return { created: 0, communities: 0 };
  }

  const entById = new Map<string, EntityRow>();
  for (const e of db
    .prepare(`SELECT id, name, entity_type, parent_entity_id FROM entities`)
    .all() as EntityRow[]) {
    entById.set(e.id, e);
  }

  const communities = groupCommunities(detectCommunities(adjacency));
  let created = 0;
  let considered = 0;

  for (const members of communities.values()) {
    const real = members.filter((id) => entById.get(id)?.entity_type !== "summary");
    if (real.length < minSize) {
      continue;
    }
    // Idempotency: skip if any member already belongs to a summary.
    if (real.some((id) => entById.get(id)?.parent_entity_id)) {
      continue;
    }
    considered++;
    const names = real.map((id) => entById.get(id)!.name);
    let summary: { name: string; abstract: string } | null;
    try {
      summary = parseSummary(await llmCall(buildSummaryPrompt(names)));
    } catch (err) {
      log.debug(`summary synthesis failed: ${String(err)}`);
      continue;
    }
    if (!summary) {
      continue;
    }

    const summaryEntity = kg.upsertEntity({
      name: summary.name,
      type: "summary",
      properties: { abstract: summary.abstract, memberCount: real.length },
    });
    for (const id of real) {
      const m = entById.get(id)!;
      try {
        kg.upsertRelationship(
          {
            sourceName: summary.name,
            sourceType: "summary",
            targetName: m.name,
            targetType: m.entity_type as EntityType,
            relationType: "summarizes",
            weight: 0.8,
          },
          [],
        );
        db.prepare(`UPDATE entities SET parent_entity_id = ? WHERE id = ?`).run(
          summaryEntity.id,
          id,
        );
      } catch (err) {
        log.debug(`summarizes edge failed: ${String(err)}`);
      }
    }
    created++;
    if (params.maxCommunities && created >= params.maxCommunities) {
      break;
    }
  }

  if (created > 0) {
    log.info(
      `graph abstraction: created ${created} summary node(s) over ${considered} communities`,
    );
  }
  return { created, communities: communities.size };
}
