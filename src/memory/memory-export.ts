/**
 * PLAN-55 Phase 3 (G9): the memory export, version 2.
 *
 * Everything an owner needs to move or audit their agent's memory, as one
 * JSON document written piece by piece to a sink (a file, or an HTTP
 * response for the download), never built as one string in memory, with a
 * yield to the event loop after every page of rows.
 *
 * Version 2 keeps every version 1 field with the same name and shape
 * (`exportedAt`, `agentId`, `memories`, `facts`, `preferences`,
 * `workingMemory`), so a reader of version 1 still works, and adds:
 * `version`, `format`, every column of the facts ledger (all statuses, the
 * full belief history and the evidence ids), preference evidence, the
 * knowledge graph (entities, relationships, belief history), dream insights,
 * curiosity findings, ledger conflicts and the agent's open questions
 * (directives), suppressions, the memory audit log, supersession marks,
 * `GENOME.md` and a redaction count.
 *
 * What is never in it: embeddings, `.env`, keys, wallet material, auth
 * profiles or any other file than MEMORY.md and GENOME.md (the exporter only
 * reads the memory database and those two files). Text that has the shape
 * of a credential is replaced with `[redacted]` (secret-shape.ts), in
 * memory text, fact values, insight and finding text, audit metadata and
 * the two files.
 */

import type { DatabaseSync } from "node:sqlite";
import { yieldToEventLoop } from "./event-loop.js";
import { redactSecretShapes } from "./secret-shape.js";

export const MEMORY_EXPORT_FORMAT = "bitterbot-memory-export";
export const MEMORY_EXPORT_VERSION = 2;
const PAGE_ROWS = 250;

/** Where the export goes. May return a promise (backpressure); awaited before the next piece. */
export type ExportSink = (piece: string) => void | Promise<void>;

export type MemoryExportStats = {
  memories: number;
  facts: number;
  preferences: number;
  entities: number;
  relationships: number;
  beliefHistory: number;
  dreamInsights: number;
  curiosityFindings: number;
  conflicts: number;
  directives: number;
  suppressions: number;
  auditLog: number;
  chunkSupersessions: number;
  redactions: number;
  bytes: number;
};

export type MemoryExportExtra = {
  agentId: string;
  workingMemory?: string | null;
  genome?: string | null;
};

const OWN_PREFIXES = [
  "fact_",
  "note_",
  "scratch_",
  "dream_insight_",
  "distill_",
  "crule_",
  "hygiene_merge_",
  "seed_",
];

function columnsOf(db: DatabaseSync, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
  } catch {
    return [];
  }
}

type TableSpec = {
  table: string;
  /** Columns never exported (embeddings, blobs). */
  exclude?: string[];
  /** Text columns passed through the secret redactor. */
  redact?: string[];
};

export async function writeMemoryExport(
  db: DatabaseSync,
  sink: ExportSink,
  extra: MemoryExportExtra,
): Promise<MemoryExportStats> {
  const stats: MemoryExportStats = {
    memories: 0,
    facts: 0,
    preferences: 0,
    entities: 0,
    relationships: 0,
    beliefHistory: 0,
    dreamInsights: 0,
    curiosityFindings: 0,
    conflicts: 0,
    directives: 0,
    suppressions: 0,
    auditLog: 0,
    chunkSupersessions: 0,
    redactions: 0,
    bytes: 0,
  };
  const write = async (piece: string) => {
    stats.bytes += Buffer.byteLength(piece, "utf8");
    await sink(piece);
  };
  const redact = (value: unknown): unknown => {
    if (typeof value !== "string" || value.length === 0) {
      return value;
    }
    const out = redactSecretShapes(value);
    stats.redactions += out.redactions;
    return out.text;
  };

  /** Stream `rows` of one table as a JSON array; returns how many were written. */
  const dumpTable = async (
    spec: TableSpec,
    map?: (row: Record<string, unknown>) => unknown,
  ): Promise<number> => {
    const exclude = new Set(["embedding", ...(spec.exclude ?? [])]);
    const cols = columnsOf(db, spec.table).filter((c) => !exclude.has(c));
    await write("[");
    if (cols.length === 0) {
      await write("]");
      return 0;
    }
    const redactCols = new Set(spec.redact ?? []);
    const stmt = db.prepare(
      `SELECT rowid AS __rid, ${cols.map((c) => `"${c}"`).join(", ")} FROM ${spec.table}
        WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    let after = 0;
    let n = 0;
    for (;;) {
      const rows = stmt.all(after, PAGE_ROWS) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        break;
      }
      let page = "";
      for (const row of rows) {
        const out: Record<string, unknown> = {};
        for (const c of cols) {
          const v = row[c];
          // Blobs never leave; a column we did not expect to be binary is dropped.
          if (v instanceof Uint8Array) {
            continue;
          }
          out[c] = redactCols.has(c) ? redact(v) : v;
        }
        page += `${n > 0 ? "," : ""}${JSON.stringify(map ? map(out) : out)}`;
        n += 1;
      }
      await write(page);
      after = Number(rows[rows.length - 1]!.__rid);
      await yieldToEventLoop();
      if (rows.length < PAGE_ROWS) {
        break;
      }
    }
    await write("]");
    return n;
  };

  await write(
    `{"format":${JSON.stringify(MEMORY_EXPORT_FORMAT)},"version":${MEMORY_EXPORT_VERSION},` +
      `"exportedAt":${JSON.stringify(new Date().toISOString())},"agentId":${JSON.stringify(extra.agentId)},"memories":`,
  );
  // Memories keep the version 1 shape (camelCase), with the v2 fields added.
  stats.memories = await dumpTable({ table: "chunks", redact: ["text"] }, (row) => {
    const id = String(row.id);
    let sensitivity: string | null = null;
    try {
      sensitivity =
        (JSON.parse(String(row.governance_json ?? "{}")) as { sensitivity?: string }).sensitivity ??
        null;
    } catch {
      sensitivity = null;
    }
    return {
      id,
      kind: OWN_PREFIXES.some((p) => id.startsWith(p)) ? "own" : "file",
      source: row.source ?? null,
      path: row.path ?? null,
      semanticType: row.semantic_type ?? null,
      lifecycle: row.lifecycle_state === "forgotten" ? "forgotten" : (row.lifecycle ?? null),
      importance: row.importance_score ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      text: row.text ?? "",
      lifecycleState: row.lifecycle_state ?? null,
      origin: row.origin ?? null,
      epistemicLayer: row.epistemic_layer ?? null,
      evidenceRefs: row.evidence_refs ?? null,
      version: row.version ?? null,
      sessionTrust: row.session_trust ?? null,
      sensitivity,
    };
  });
  await write(`,"facts":`);
  stats.facts = await dumpTable({
    table: "canonical_facts",
    redact: ["value", "statement", "evidence_ref"],
  });
  await write(`,"preferences":`);
  stats.preferences = await dumpTable({ table: "user_preferences", redact: ["value"] });
  await write(`,"knowledgeGraph":{"entities":`);
  stats.entities = await dumpTable({
    table: "entities",
    exclude: ["name_embedding"],
    redact: ["name", "properties"],
  });
  await write(`,"relationships":`);
  stats.relationships = await dumpTable({ table: "relationships", exclude: ["gate_features"] });
  await write(`,"beliefHistory":`);
  stats.beliefHistory = await dumpTable({ table: "relationship_belief_history" });
  await write(`},"dreamInsights":`);
  stats.dreamInsights = await dumpTable({ table: "dream_insights", redact: ["content"] });
  await write(`,"curiosityFindings":`);
  stats.curiosityFindings = await dumpTable({
    table: "curiosity_findings",
    redact: ["question", "query_phrase", "answer", "sources_json"],
  });
  await write(`,"conflicts":`);
  stats.conflicts = await dumpTable({
    table: "canonical_conflicts",
    redact: ["current_value", "proposed_value"],
  });
  await write(`,"directives":`);
  stats.directives = await dumpTable({
    table: "epistemic_directives",
    redact: ["question", "context", "resolution"],
  });
  await write(`,"suppressions":`);
  stats.suppressions = await dumpTable({ table: "memory_suppressions", redact: ["text"] });
  await write(`,"auditLog":`);
  stats.auditLog = await dumpTable({ table: "memory_audit_log", redact: ["metadata"] });
  await write(`,"chunkSupersessions":`);
  stats.chunkSupersessions = await dumpTable({
    table: "chunk_supersessions",
    redact: ["stale_value", "current_value"],
  });
  await write(
    `,"workingMemory":${JSON.stringify(redact(extra.workingMemory ?? null))}` +
      `,"genome":${JSON.stringify(redact(extra.genome ?? null))}`,
  );
  // Last, so it counts everything above.
  await write(`,"redactions":${stats.redactions}}`);
  return stats;
}
